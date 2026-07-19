import { createHash } from "node:crypto";
import type {
  ExactSnapshotLookupResult,
  Snapshot,
  SnapshotLookup,
  SnapshotStore,
} from "./types.js";

const MAX_REFERENCE_LENGTH = 16 * 1024;
const MAX_LEGACY_REFERENCE_LENGTH = 1024 * 1024;
const MAX_SOURCE_ID_LENGTH = 1024;
const MAX_URL_LENGTH = 8 * 1024;
const MAX_FETCHED_AT_LENGTH = 256;
const MAX_DURABLE_BODY_BYTES = 64 * 1024 * 1024;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function snapshotEnvelopeDigest(snapshot: Snapshot): string {
  assertReferenceableSnapshot(snapshot);
  const envelope = {
    sourceId: snapshot.sourceId,
    url: snapshot.url,
    status: snapshot.status,
    fetchedAt: snapshot.fetchedAt,
    bodyHash: snapshot.bodyHash,
    bodyEncoding: typeof snapshot.body === "string" ? "utf8" : "bytes",
    headers: snapshot.headers === undefined
      ? null
      : Object.entries(snapshot.headers).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
    redirects: snapshot.redirects ?? null,
    rendered: snapshot.rendered ?? null,
    // notModified is a transient 304 marker, never part of a durable capture.
  };
  return sha256(JSON.stringify(envelope));
}

function formatSnapshotSourceRef(reference: ParsedSnapshotSourceRef): string {
  const params = new URLSearchParams({
    url: reference.url,
    sha256: reference.bodyHash,
    fetchedAt: reference.fetchedAt,
  });
  if (reference.snapshotDigest !== undefined) {
    params.set("snapshotSha256", reference.snapshotDigest);
  }
  return `forage-snapshot:${encodeURIComponent(reference.sourceId)}?${params.toString()}`;
}

/** Build a durable ref that commits to the body and canonical replay metadata. */
export function buildSnapshotSourceRef(snapshot: Snapshot): string {
  const reference = formatSnapshotSourceRef({
    sourceId: snapshot.sourceId,
    url: snapshot.url,
    bodyHash: snapshot.bodyHash,
    fetchedAt: snapshot.fetchedAt,
    snapshotDigest: snapshotEnvelopeDigest(snapshot),
  });
  if (reference.length > MAX_REFERENCE_LENGTH) {
    throw new TypeError(`snapshot reference exceeds ${MAX_REFERENCE_LENGTH} characters after encoding`);
  }
  return reference;
}

export interface ParsedSnapshotSourceRef extends SnapshotLookup {}

export type SnapshotSourceRefResolution =
  | {
      ok: true;
      integrity: "snapshot-envelope" | "body-and-identity";
      reference: ParsedSnapshotSourceRef;
      snapshot: Snapshot;
    }
  | {
      ok: false;
      error: {
        kind:
          | "invalid-reference"
          | "snapshot-not-found"
          | "snapshot-mismatch"
          | "snapshot-store-error";
        message: string;
      };
    };

/**
 * Parse a `buildSnapshotSourceRef` string back into its components, or
 * `undefined` if `ref` is not a forage-snapshot ref. Round-trips
 * `buildSnapshotSourceRef` exactly. Matches traverse's
 * `parseSnapshotSourceRef` (traverse/src/fetch/compose.ts).
 */
export function parseSnapshotSourceRef(ref: string): ParsedSnapshotSourceRef | undefined {
  if (
    typeof ref !== "string" ||
    ref.length > MAX_LEGACY_REFERENCE_LENGTH ||
    !isWellFormed(ref)
  ) return undefined;
  const prefix = "forage-snapshot:";
  if (!ref.startsWith(prefix)) return undefined;
  const rest = ref.slice(prefix.length);
  const q = rest.indexOf("?");
  if (q === -1) return undefined;
  let sourceId: string;
  try {
    sourceId = decodeURIComponent(rest.slice(0, q));
  } catch {
    return undefined;
  }
  const params = new URLSearchParams(rest.slice(q + 1));
  const url = params.get("url");
  const bodyHash = params.get("sha256");
  const fetchedAt = params.get("fetchedAt");
  const snapshotDigest = params.get("snapshotSha256") ?? undefined;
  const envelopeReference = snapshotDigest !== undefined;
  if (
    !sourceId ||
    !url ||
    !fetchedAt ||
    !bodyHash ||
    (envelopeReference && (
      ref.length > MAX_REFERENCE_LENGTH ||
      sourceId.length > MAX_SOURCE_ID_LENGTH ||
      url.length > MAX_URL_LENGTH ||
      fetchedAt.length > MAX_FETCHED_AT_LENGTH
    ))
  ) return undefined;
  return {
    sourceId,
    url,
    bodyHash,
    fetchedAt,
    ...(snapshotDigest === undefined ? {} : { snapshotDigest }),
  };
}

function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function assertSnapshotCore(
  value: unknown,
  releasedIdentity = false,
): asserts value is Snapshot {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("snapshot must be an object");
  }
  const snapshot = value as Snapshot;
  if (
    typeof snapshot.sourceId !== "string" ||
    !snapshot.sourceId ||
    snapshot.sourceId.length > (releasedIdentity ? MAX_LEGACY_REFERENCE_LENGTH : MAX_SOURCE_ID_LENGTH) ||
    typeof snapshot.url !== "string" ||
    !snapshot.url ||
    snapshot.url.length > (releasedIdentity ? MAX_LEGACY_REFERENCE_LENGTH : MAX_URL_LENGTH) ||
    typeof snapshot.fetchedAt !== "string" ||
    !snapshot.fetchedAt ||
    snapshot.fetchedAt.length > (releasedIdentity ? MAX_LEGACY_REFERENCE_LENGTH : MAX_FETCHED_AT_LENGTH) ||
    typeof snapshot.bodyHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(snapshot.bodyHash) ||
    !Number.isInteger(snapshot.status) ||
    (typeof snapshot.body !== "string" && !(snapshot.body instanceof Uint8Array)) ||
    (typeof snapshot.body === "string"
      ? Buffer.byteLength(snapshot.body, "utf8")
      : snapshot.body.byteLength) > MAX_DURABLE_BODY_BYTES
  ) {
    throw new TypeError("snapshot has an invalid durable shape");
  }
}

function snapshotStrings(snapshot: Snapshot): string[] {
  const strings = [snapshot.sourceId, snapshot.url, snapshot.fetchedAt];
  if (typeof snapshot.body === "string") strings.push(snapshot.body);
  if (snapshot.headers !== undefined) {
    if (typeof snapshot.headers !== "object" || snapshot.headers === null || Array.isArray(snapshot.headers)) {
      throw new TypeError("snapshot headers must be a string record");
    }
    for (const [name, headerValue] of Object.entries(snapshot.headers)) {
      if (typeof headerValue !== "string") throw new TypeError("snapshot headers must be a string record");
      strings.push(name, headerValue);
    }
  }
  if (snapshot.redirects !== undefined) {
    if (!Array.isArray(snapshot.redirects) || snapshot.redirects.some((redirect) => typeof redirect !== "string")) {
      throw new TypeError("snapshot redirects must be strings");
    }
    strings.push(...snapshot.redirects);
  }
  if (snapshot.rendered !== undefined && typeof snapshot.rendered !== "boolean") {
    throw new TypeError("snapshot rendered marker must be boolean");
  }
  if (snapshot.notModified !== undefined && snapshot.notModified !== true) {
    throw new TypeError("snapshot notModified marker may only be present as true");
  }
  return strings;
}

function assertReferenceableSnapshot(
  value: unknown,
  releasedIdentity = false,
): asserts value is Snapshot {
  assertSnapshotCore(value, releasedIdentity);
  if (snapshotStrings(value).some((entry) => !isWellFormed(entry))) {
    throw new TypeError("snapshot strings must be well-formed UTF-16");
  }
  if (sha256(value.body) !== value.bodyHash) {
    throw new TypeError("snapshot body does not match its SHA-256 digest");
  }
}

/** Return only the validated fields that are committed by a durable reference. */
export function canonicalDurableSnapshot(snapshot: Snapshot): Snapshot {
  assertReferenceableSnapshot(snapshot);
  return cloneDurableSnapshot(snapshot);
}

function cloneDurableSnapshot(snapshot: Snapshot): Snapshot {
  return {
    sourceId: snapshot.sourceId,
    url: snapshot.url,
    status: snapshot.status,
    fetchedAt: snapshot.fetchedAt,
    body: snapshot.body instanceof Uint8Array
      ? new Uint8Array(snapshot.body)
      : snapshot.body,
    bodyHash: snapshot.bodyHash,
    ...(snapshot.headers === undefined ? {} : { headers: { ...snapshot.headers } }),
    ...(snapshot.redirects === undefined ? {} : { redirects: [...snapshot.redirects] }),
    ...(snapshot.rendered === undefined ? {} : { rendered: snapshot.rendered }),
  };
}

function matchingSnapshot(
  snapshot: Snapshot,
  reference: ParsedSnapshotSourceRef,
): boolean {
  return snapshot.sourceId === reference.sourceId &&
    snapshot.url === reference.url &&
    snapshot.fetchedAt === reference.fetchedAt &&
    (reference.snapshotDigest === undefined ||
      snapshotEnvelopeDigest(snapshot) === reference.snapshotDigest);
}

function resolveCandidate(
  lookup: ExactSnapshotLookupResult,
  reference: ParsedSnapshotSourceRef,
): SnapshotSourceRefResolution {
  if (lookup.kind === "missing") {
    return {
      ok: false,
      error: {
        kind: "snapshot-not-found",
        message: "the referenced snapshot is not present in the supplied store",
      },
    };
  }
  if (lookup.kind === "mismatch") {
    return {
      ok: false,
      error: {
        kind: "snapshot-mismatch",
        message: "the stored snapshot does not exactly match the durable reference",
      },
    };
  }
  const candidate: unknown = lookup.snapshot;
  assertReferenceableSnapshot(candidate, reference.snapshotDigest === undefined);
  if (candidate.bodyHash !== reference.bodyHash || !matchingSnapshot(candidate, reference)) {
    return {
      ok: false,
      error: {
        kind: "snapshot-mismatch",
        message: "the stored snapshot does not exactly match the durable reference",
      },
    };
  }
  return {
    ok: true,
    integrity: reference.snapshotDigest === undefined
      ? "body-and-identity"
      : "snapshot-envelope",
    reference,
    snapshot: cloneDurableSnapshot(candidate),
  };
}

function isCanonicalReference(
  ref: string,
  parsed: ParsedSnapshotSourceRef,
): boolean {
  if (
    !parsed.sourceId ||
    !/^[a-f0-9]{64}$/.test(parsed.bodyHash) ||
    (parsed.snapshotDigest !== undefined &&
      !/^[a-f0-9]{64}$/.test(parsed.snapshotDigest))
  ) return false;
  try {
    return formatSnapshotSourceRef(parsed) === ref;
  } catch {
    return false;
  }
}

/** Resolve a canonical durable reference without fetching or accepting hash prefixes. */
export async function resolveSnapshotSourceRef(
  store: SnapshotStore,
  ref: string,
): Promise<SnapshotSourceRefResolution> {
  const reference = parseSnapshotSourceRef(ref);
  if (!reference || !isCanonicalReference(ref, reference)) {
    return {
      ok: false,
      error: {
        kind: "invalid-reference",
        message: "snapshot reference is not a canonical forage-snapshot reference",
      },
    };
  }

  try {
    if (store.findExact === undefined) {
      throw new TypeError("snapshot store does not implement exact lookup");
    }
    return resolveCandidate(await store.findExact(reference), reference);
  } catch {
    return {
      ok: false,
      error: {
        kind: "snapshot-store-error",
        message: "the supplied snapshot store could not resolve the reference",
      },
    };
  }
}
