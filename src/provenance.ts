import type { Snapshot } from "./types.js";

/** Build a durable ref that can be resolved through SnapshotStore.get(). */
export function buildSnapshotSourceRef(snapshot: Snapshot): string {
  const params = new URLSearchParams({
    url: snapshot.url,
    sha256: snapshot.bodyHash,
    fetchedAt: snapshot.fetchedAt,
  });
  return `forage-snapshot:${encodeURIComponent(snapshot.sourceId)}?${params.toString()}`;
}

export interface ParsedSnapshotSourceRef {
  sourceId: string;
  url: string;
  bodyHash: string;
  fetchedAt: string;
}

/**
 * Parse a `buildSnapshotSourceRef` string back into its components, or
 * `undefined` if `ref` is not a forage-snapshot ref. Round-trips
 * `buildSnapshotSourceRef` exactly. Matches traverse's
 * `parseSnapshotSourceRef` (traverse/src/fetch/compose.ts).
 */
export function parseSnapshotSourceRef(ref: string): ParsedSnapshotSourceRef | undefined {
  const prefix = "forage-snapshot:";
  if (!ref.startsWith(prefix)) return undefined;
  const rest = ref.slice(prefix.length);
  const q = rest.indexOf("?");
  if (q === -1) return undefined;
  const sourceId = decodeURIComponent(rest.slice(0, q));
  const params = new URLSearchParams(rest.slice(q + 1));
  const url = params.get("url");
  const bodyHash = params.get("sha256");
  const fetchedAt = params.get("fetchedAt");
  if (!url || !bodyHash || !fetchedAt) return undefined;
  return { sourceId, url, bodyHash, fetchedAt };
}
