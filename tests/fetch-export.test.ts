// Proves the PUBLIC `@kontourai/forage/fetch` subpath surface (via the
// fetch-index barrel) re-exports a working fetcher + provenance helpers — the
// drop-in surface `@kontourai/lookout` re-points onto (kontourai/lookout#11).
// Exercises the runtime wiring through the barrel itself, not the internal
// modules, mirroring tests/egress-export.test.ts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  fetchSource,
  buildSnapshotSourceRef,
  parseSnapshotSourceRef,
  resolveSnapshotSourceRef,
  type FetchLike,
  type SourceConfig,
} from "../src/fetch-index.js";
import {
  createFilesystemSnapshotStore,
  createInMemorySnapshotStore,
  type ExactSnapshotStore,
  type Snapshot,
  type SnapshotStore,
} from "../src/index.js";

const egress = { guarded: false } as const;

function replaySnapshot(): Snapshot {
  const body = "model: result";
  return {
    sourceId: "trusted-source",
    url: "https://example.test/benchmark.yml",
    status: 200,
    fetchedAt: "2026-07-18T12:00:00.000Z",
    body,
    bodyHash: createHash("sha256").update(body).digest("hex"),
  };
}

async function recordPath(root: string, snapshot: Snapshot): Promise<{
  filesystem: ReturnType<typeof createFilesystemSnapshotStore>;
  record: string;
}> {
  const filesystem = createFilesystemSnapshotStore({ root });
  await filesystem.put(snapshot);
  const [sourceDirectory] = await readdir(root);
  const sourceRoot = path.join(root, sourceDirectory);
  const [record] = (await readdir(sourceRoot)).filter((name) => name.endsWith(".json"));
  assert.ok(record);
  return { filesystem, record: path.join(sourceRoot, record) };
}

async function assertStoreError(store: SnapshotStore, snapshot = replaySnapshot()): Promise<void> {
  const result = await resolveSnapshotSourceRef(store, buildSnapshotSourceRef(snapshot));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "snapshot-store-error");
}

describe("@kontourai/forage/fetch public surface", () => {
  it("re-exports the primitives as callable values through the barrel", () => {
    assert.equal(typeof fetchSource, "function");
    assert.equal(typeof buildSnapshotSourceRef, "function");
    assert.equal(typeof parseSnapshotSourceRef, "function");
    assert.equal(typeof resolveSnapshotSourceRef, "function");
  });

  it("fetchSource from the subpath captures a snapshot with a resolvable sourceRef", async () => {
    const fetch = (async () =>
      new Response("hello", {
        status: 200,
        headers: { "content-type": "text/plain" },
      })) as unknown as FetchLike;
    const config: SourceConfig = {
      id: "src-export",
      url: "https://example.test/page",
      respectRobots: false,
      egress,
    };
    const result = await fetchSource(config, {
      fetch,
      sleep: async () => {},
      random: () => 0,
      politenessState: new Map(),
      robotsCache: new Map(),
    });
    assert.equal(result.error, undefined);
    assert.equal(result.snapshot?.body, "hello");

    // buildSnapshotSourceRef -> parseSnapshotSourceRef round-trips through the
    // public barrel and resolves back to the snapshot's identity.
    const ref = buildSnapshotSourceRef(result.snapshot!);
    assert.match(ref, /^forage-snapshot:/);
    const parsed = parseSnapshotSourceRef(ref);
    assert.equal(parsed?.sourceId, "src-export");
    assert.equal(parsed?.url, result.snapshot!.url);
    assert.equal(parsed?.bodyHash, result.snapshot!.bodyHash);
    assert.equal(parsed?.fetchedAt, result.snapshot!.fetchedAt);
    assert.match(parsed?.snapshotDigest ?? "", /^[a-f0-9]{64}$/);
  });

  it("parseSnapshotSourceRef round-trips buildSnapshotSourceRef exactly and rejects foreign/malformed refs", () => {
    const snapshot: Snapshot = {
      sourceId: "id/with?odd&chars",
      url: "https://example.test/a?b=c#frag",
      status: 200,
      fetchedAt: "2026-07-16T00:00:00.000Z",
      body: "x",
      bodyHash: createHash("sha256").update("x").digest("hex"),
    };
    const ref = buildSnapshotSourceRef(snapshot);
    const parsed = parseSnapshotSourceRef(ref);
    assert.deepEqual(parsed, {
      sourceId: snapshot.sourceId,
      url: snapshot.url,
      bodyHash: snapshot.bodyHash,
      fetchedAt: snapshot.fetchedAt,
      snapshotDigest: parseSnapshotSourceRef(ref)?.snapshotDigest,
    });

    const legacyParams = new URLSearchParams({
      url: snapshot.url,
      sha256: snapshot.bodyHash,
      fetchedAt: snapshot.fetchedAt,
    });
    assert.deepEqual(
      parseSnapshotSourceRef(`forage-snapshot:${encodeURIComponent(snapshot.sourceId)}?${legacyParams}`),
      {
        sourceId: snapshot.sourceId,
        url: snapshot.url,
        bodyHash: snapshot.bodyHash,
        fetchedAt: snapshot.fetchedAt,
      },
    );
    const largeLegacySourceId = "s".repeat(1025);
    assert.equal(
      parseSnapshotSourceRef(`forage-snapshot:${largeLegacySourceId}?${legacyParams}`)?.sourceId,
      largeLegacySourceId,
    );

    const unicodeSnapshot = {
      ...snapshot,
      url: "https://example.test/caf\u00e9",
    };
    assert.equal(parseSnapshotSourceRef(buildSnapshotSourceRef(unicodeSnapshot))?.url, unicodeSnapshot.url);
    assert.throws(
      () => buildSnapshotSourceRef({
        ...snapshot,
        url: `https://example.test/${"\u00e9".repeat(3000)}`,
      }),
      /reference exceeds 16384 characters/,
    );

    // Not a forage-snapshot ref -> undefined (e.g. a traverse ref).
    assert.equal(
      parseSnapshotSourceRef("traverse-snapshot:id?url=https://x&sha256=y&fetchedAt=z"),
      undefined,
    );
    // Missing query -> undefined.
    assert.equal(parseSnapshotSourceRef("forage-snapshot:id"), undefined);
    // Missing a required param -> undefined.
    assert.equal(
      parseSnapshotSourceRef("forage-snapshot:id?url=https://x&sha256=y"),
      undefined,
    );
    assert.equal(
      parseSnapshotSourceRef("forage-snapshot:%ZZ?url=https://x&sha256=y&fetchedAt=z"),
      undefined,
    );
    assert.equal(parseSnapshotSourceRef(`forage-snapshot:\ud800?url=x&sha256=${"a".repeat(64)}&fetchedAt=z&snapshotSha256=${"b".repeat(64)}`), undefined);
    assert.equal(parseSnapshotSourceRef(null as unknown as string), undefined);
    assert.equal(parseSnapshotSourceRef(`forage-snapshot:${"a".repeat(17 * 1024)}`), undefined);
    assert.throws(() => buildSnapshotSourceRef({
      ...snapshot,
      body: "\ud800",
      bodyHash: createHash("sha256").update("\ud800").digest("hex"),
    }), /well-formed UTF-16/);
  });

  it("resolves canonical references exactly through in-memory and filesystem stores", async () => {
    const body = "model: result";
    const snapshot: Snapshot = {
      sourceId: "trusted-source",
      url: "https://example.test/benchmark.yml",
      status: 200,
      fetchedAt: "2026-07-18T12:00:00.000Z",
      body,
      bodyHash: createHash("sha256").update(body).digest("hex"),
    };
    const ref = buildSnapshotSourceRef(snapshot);
    const memory = createInMemorySnapshotStore();
    await memory.put(snapshot);
    const lookup = parseSnapshotSourceRef(ref)!;
    assert.deepEqual(
      await memory.findExact({ ...lookup, url: "https://example.test/other.yml" }),
      { kind: "mismatch" },
    );
    const mismatchedParams = new URLSearchParams({
      url: "https://example.test/other.yml",
      sha256: lookup.bodyHash,
      fetchedAt: lookup.fetchedAt,
      snapshotSha256: lookup.snapshotDigest!,
    });
    const mismatchedRef = `forage-snapshot:${encodeURIComponent(lookup.sourceId)}?${mismatchedParams}`;
    const memoryMismatch = await resolveSnapshotSourceRef(memory, mismatchedRef);
    assert.equal(memoryMismatch.ok, false);
    if (!memoryMismatch.ok) assert.equal(memoryMismatch.error.kind, "snapshot-mismatch");
    const memoryResolution = await resolveSnapshotSourceRef(memory, ref);
    assert.equal(memoryResolution.ok, true);
    if (memoryResolution.ok) {
      assert.equal(memoryResolution.integrity, "snapshot-envelope");
      assert.equal(memoryResolution.snapshot.bodyHash, snapshot.bodyHash);
      assert.equal(memoryResolution.snapshot.body, snapshot.body);
    }

    const root = await mkdtemp(path.join(tmpdir(), "forage-ref-"));
    try {
      const filesystem = createFilesystemSnapshotStore({ root });
      await filesystem.put(snapshot);
      assert.deepEqual(
        await filesystem.findExact({ ...lookup, bodyHash: "f".repeat(64) }),
        { kind: "mismatch" },
      );
      const filesystemMismatch = await resolveSnapshotSourceRef(filesystem, mismatchedRef);
      assert.equal(filesystemMismatch.ok, false);
      if (!filesystemMismatch.ok) assert.equal(filesystemMismatch.error.kind, "snapshot-mismatch");
      await assert.rejects(
        filesystem.findExact({ ...lookup, snapshotDigest: "../../../../secret" }),
        /invalid exact identity/,
      );
      const filesystemResolution = await resolveSnapshotSourceRef(filesystem, ref);
      assert.equal(filesystemResolution.ok, true);
      if (filesystemResolution.ok) {
        assert.equal(filesystemResolution.integrity, "snapshot-envelope");
        assert.deepEqual(filesystemResolution.snapshot, snapshot);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("strips transient and uncommitted fields at persistence and replay boundaries", async () => {
    const body = "durable body";
    const snapshot = {
      sourceId: "transient-source",
      url: "https://example.test/benchmark.json",
      status: 200,
      fetchedAt: "2026-07-18T12:00:00.000Z",
      body,
      bodyHash: createHash("sha256").update(body).digest("hex"),
      redirects: ["https://example.test/start"],
      notModified: true,
      fromCache: true,
      uncommitted: "must not survive",
    } as Snapshot & { fromCache: boolean; uncommitted: string };
    const ref = buildSnapshotSourceRef(snapshot);
    const memory = createInMemorySnapshotStore();
    await memory.put(snapshot);
    snapshot.redirects?.push("https://example.test/mutated-input");
    const stored = await memory.latest(snapshot.sourceId);
    assert.equal(stored?.notModified, undefined);
    assert.equal("fromCache" in (stored ?? {}), false);
    assert.equal("uncommitted" in (stored ?? {}), false);
    assert.deepEqual(stored?.redirects, ["https://example.test/start"]);
    const customCandidate = {
      ...(stored as Snapshot),
      notModified: true,
      fromCache: true,
      uncommitted: "must not survive",
    } as Snapshot & { fromCache: boolean; uncommitted: string };

    const root = await mkdtemp(path.join(tmpdir(), "forage-transient-"));
    try {
      const filesystem = createFilesystemSnapshotStore({ root });
      await filesystem.put(customCandidate);
      const persisted = await filesystem.latest(snapshot.sourceId);
      assert.equal(persisted?.notModified, undefined);
      assert.equal("fromCache" in (persisted ?? {}), false);
      assert.equal("uncommitted" in (persisted ?? {}), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }

    const customStore: ExactSnapshotStore = {
      put: async () => {},
      latest: async () => customCandidate,
      get: async () => customCandidate,
      list: async () => [customCandidate],
      findExact: async () => ({ kind: "found", snapshot: customCandidate }),
    };
    const replay = await resolveSnapshotSourceRef(customStore, ref);
    assert.equal(replay.ok, true);
    if (replay.ok) {
      assert.equal(replay.snapshot.notModified, undefined);
      assert.equal("fromCache" in replay.snapshot, false);
      assert.equal("uncommitted" in replay.snapshot, false);
      replay.snapshot.redirects?.push("https://example.test/mutated-result");
      assert.deepEqual((await memory.latest(snapshot.sourceId))?.redirects, ["https://example.test/start"]);
    }
  });

  it("distinguishes invalid and missing references before accepting a replay", async () => {
    const body = "model: result";
    const snapshot: Snapshot = {
      sourceId: "trusted-source",
      url: "https://example.test/benchmark.yml",
      status: 200,
      fetchedAt: "2026-07-18T12:00:00.000Z",
      body,
      bodyHash: createHash("sha256").update(body).digest("hex"),
    };
    const ref = buildSnapshotSourceRef(snapshot);
    const memory = createInMemorySnapshotStore();

    assert.deepEqual(await resolveSnapshotSourceRef(memory, ref), {
      ok: false,
      error: {
        kind: "snapshot-not-found",
        message: "the referenced snapshot is not present in the supplied store",
      },
    });
    for (const invalid of [
      ref.replace(snapshot.bodyHash, snapshot.bodyHash.slice(0, 12)),
      `${ref}&extra=1`,
    ]) {
      const result = await resolveSnapshotSourceRef(memory, invalid);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.kind, "invalid-reference");
    }
  });

  it("resolves an older reference after a same-body recapture", async () => {
    const body = "same body";
    const bodyHash = createHash("sha256").update(body).digest("hex");
    const older: Snapshot = {
      sourceId: "recaptured-source",
      url: "https://example.test/benchmark.yml",
      status: 200,
      fetchedAt: "2026-07-18T12:00:00Z",
      body,
      bodyHash,
    };
    const newer: Snapshot = {
      ...older,
      fetchedAt: "2026-07-18T13:00:00.000Z",
      headers: { etag: '"v2"' },
    };
    const store = createInMemorySnapshotStore();
    await store.put(older);
    await store.put(newer);

    const result = await resolveSnapshotSourceRef(store, buildSnapshotSourceRef(older));
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.snapshot.fetchedAt, older.fetchedAt);
  });

  it("resolves through one exact lookup without listing source history", async () => {
    const body = "stable body";
    const bodyHash = createHash("sha256").update(body).digest("hex");
    const target: Snapshot = {
      sourceId: "long-lived-source",
      url: "https://example.test/benchmark.json",
      status: 200,
      fetchedAt: "original-capture",
      body,
      bodyHash,
    };
    const store: ExactSnapshotStore = {
      put: async () => {},
      latest: async () => target,
      get: async () => target,
      list: async () => { throw new Error("history must not be listed"); },
      findExact: async () => ({ kind: "found", snapshot: target }),
    };
    const result = await resolveSnapshotSourceRef(store, buildSnapshotSourceRef(target));
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.snapshot.fetchedAt, target.fetchedAt);
  });

  it("resolves released-format references with an explicit lower integrity level", async () => {
    const body = "released reference";
    const snapshot: Snapshot = {
      sourceId: "legacy-source",
      url: "https://example.test/legacy.json",
      status: 200,
      fetchedAt: "2026-07-18T12:00:00.000Z",
      body,
      bodyHash: createHash("sha256").update(body).digest("hex"),
    };
    const params = new URLSearchParams({
      url: snapshot.url,
      sha256: snapshot.bodyHash,
      fetchedAt: snapshot.fetchedAt,
    });
    const ref = `forage-snapshot:${snapshot.sourceId}?${params}`;
    const store = createInMemorySnapshotStore();
    await store.put(snapshot);

    const result = await resolveSnapshotSourceRef(store, ref);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.integrity, "body-and-identity");

    const root = await mkdtemp(path.join(tmpdir(), "forage-legacy-ref-"));
    try {
      const filesystem = createFilesystemSnapshotStore({ root });
      await filesystem.put(snapshot);
      const [sourceDirectory] = await readdir(root);
      const sourceRoot = path.join(root, sourceDirectory);
      const releasedFilename = `${snapshot.fetchedAt.replace(/[^0-9A-Za-z._-]/g, "-")}-${snapshot.bodyHash.slice(0, 12)}.json`;
      await writeFile(path.join(sourceRoot, releasedFilename), JSON.stringify({
        ...snapshot,
        notModified: true,
        unknown: "must not survive",
      }, null, 2));
      await filesystem.put(snapshot);
      assert.deepEqual(await filesystem.list(snapshot.sourceId), [snapshot]);
      assert.deepEqual(await filesystem.latest(snapshot.sourceId), snapshot);

      await rm(sourceRoot, { recursive: true, force: true });
      await mkdir(sourceRoot, { recursive: true });
      await writeFile(path.join(sourceRoot, releasedFilename), JSON.stringify(snapshot, null, 2));
      const filesystemResult = await resolveSnapshotSourceRef(filesystem, ref);
      assert.equal(filesystemResult.ok, true);
      if (filesystemResult.ok) assert.equal(filesystemResult.integrity, "body-and-identity");
    } finally {
      await rm(root, { recursive: true, force: true });
    }

    const largeIdentitySnapshot = { ...snapshot, sourceId: "s".repeat(1025) };
    const largeRef = `forage-snapshot:${largeIdentitySnapshot.sourceId}?${params}`;
    const largeIdentityStore: ExactSnapshotStore = {
      put: async () => {},
      latest: async () => largeIdentitySnapshot,
      get: async () => largeIdentitySnapshot,
      list: async () => [largeIdentitySnapshot],
      findExact: async () => ({ kind: "found", snapshot: largeIdentitySnapshot }),
    };
    const largeIdentityResult = await resolveSnapshotSourceRef(largeIdentityStore, largeRef);
    assert.equal(largeIdentityResult.ok, true);
    if (largeIdentityResult.ok) assert.equal(largeIdentityResult.integrity, "body-and-identity");
  });

  it("filesystem identity preserves colliding timestamp slugs and replay envelopes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "forage-ref-collision-"));
    const body = "same body";
    const bodyHash = createHash("sha256").update(body).digest("hex");
    const first: Snapshot = {
      sourceId: "collision-source",
      url: "https://example.test/benchmark.json",
      status: 200,
      fetchedAt: "capture:a",
      body,
      bodyHash,
    };
    const second: Snapshot = {
      ...first,
      fetchedAt: "capture/a",
      headers: { etag: '"v2"' },
    };
    try {
      const store = createFilesystemSnapshotStore({ root });
      await store.put(first);
      await store.put(second);
      assert.equal((await store.list(first.sourceId)).length, 2);
      assert.equal((await resolveSnapshotSourceRef(store, buildSnapshotSourceRef(first))).ok, true);
      assert.equal((await resolveSnapshotSourceRef(store, buildSnapshotSourceRef(second))).ok, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("authenticates and replays binary bodies without changing representation", async () => {
    const body = new Uint8Array([0, 255, 1, 254]);
    const snapshot: Snapshot = {
      sourceId: "binary-source",
      url: "https://example.test/benchmark.bin",
      status: 200,
      fetchedAt: "2026-07-18T12:00:00.000Z",
      body,
      bodyHash: createHash("sha256").update(body).digest("hex"),
    };
    const store = createInMemorySnapshotStore();
    await store.put(snapshot);
    const result = await resolveSnapshotSourceRef(store, buildSnapshotSourceRef(snapshot));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.ok(result.snapshot.body instanceof Uint8Array);
      assert.deepEqual(result.snapshot.body, body);
    }
  });

  it("rejects body, representation, and replay-metadata changes", async () => {
    const body = "model: result";
    const snapshot: Snapshot = {
      sourceId: "trusted-source",
      url: "https://example.test/benchmark.yml",
      status: 200,
      fetchedAt: "2026-07-18T12:00:00.000Z",
      body,
      bodyHash: createHash("sha256").update(body).digest("hex"),
    };
    const ref = buildSnapshotSourceRef(snapshot);
    const storeWith = (candidate: Snapshot): ExactSnapshotStore => ({
      put: async () => {},
      latest: async () => candidate,
      get: async () => candidate,
      list: async () => [candidate],
      findExact: async () => ({ kind: "found", snapshot: candidate }),
    });

    for (const candidate of [
      { ...snapshot, sourceId: "other-source" },
      { ...snapshot, url: "https://example.test/other.yml" },
      { ...snapshot, fetchedAt: "2026-07-18T12:00:01.000Z" },
      { ...snapshot, body: new TextEncoder().encode(body) },
      { ...snapshot, status: 500 },
      { ...snapshot, headers: { "content-type": "application/octet-stream" } },
      { ...snapshot, redirects: ["https://example.test/redirect"] },
      { ...snapshot, rendered: true },
    ] satisfies Snapshot[]) {
      const mismatch = await resolveSnapshotSourceRef(storeWith(candidate), ref);
      assert.equal(mismatch.ok, false);
      if (!mismatch.ok) assert.equal(mismatch.error.kind, "snapshot-mismatch");
    }

    const corrupt = await resolveSnapshotSourceRef(
      storeWith({ ...snapshot, body: "tampered" }),
      ref,
    );
    assert.equal(corrupt.ok, false);
    if (!corrupt.ok) assert.equal(corrupt.error.kind, "snapshot-store-error");
  });

  it("contains exact-lookup failures without leaking backend details", async () => {
    const snapshot = replaySnapshot();
    const failingStore: ExactSnapshotStore = {
      put: async () => {},
      latest: async () => undefined,
      get: async () => undefined,
      list: async () => {
        throw new Error("private backend detail");
      },
      findExact: async () => {
        throw new Error("private backend detail");
      },
    };
    assert.deepEqual(await resolveSnapshotSourceRef(failingStore, buildSnapshotSourceRef(snapshot)), {
      ok: false,
      error: {
        kind: "snapshot-store-error",
        message: "the supplied snapshot store could not resolve the reference",
      },
    });
  });

  it("contains malformed exact-lookup candidates", async () => {
    const snapshot = replaySnapshot();
    const base: ExactSnapshotStore = {
      put: async () => {},
      latest: async () => undefined,
      get: async () => undefined,
      list: async () => [],
      findExact: async () => ({ kind: "missing" }),
    };
    const malformedCandidateStore: ExactSnapshotStore = {
      ...base,
      findExact: async () => ({ kind: "found", snapshot: null as unknown as Snapshot }),
    };
    await assertStoreError(malformedCandidateStore, snapshot);

    const throwingCandidate = Object.defineProperty({}, "bodyHash", {
      get() {
        throw new Error("PRIVATE_BACKEND_DETAIL");
      },
    }) as Snapshot;
    const throwingCandidateStore: ExactSnapshotStore = {
      ...base,
      findExact: async () => ({ kind: "found", snapshot: throwingCandidate }),
    };
    const throwingResult = await resolveSnapshotSourceRef(
      throwingCandidateStore,
      buildSnapshotSourceRef(snapshot),
    );
    assert.equal(throwingResult.ok, false);
    if (!throwingResult.ok) {
      assert.equal(throwingResult.error.kind, "snapshot-store-error");
      assert.doesNotMatch(throwingResult.error.message, /PRIVATE_BACKEND_DETAIL/);
    }
  });

  it("reports stores without exact lookup as a contained store error", async () => {
    const releasedStore: SnapshotStore = {
      put: async () => {},
      latest: async () => undefined,
      get: async () => undefined,
      list: async () => [],
    };
    await assertStoreError(releasedStore);
  });

  it("contains an invalid filesystem root", async () => {
    const snapshot = replaySnapshot();
    const root = await mkdtemp(path.join(tmpdir(), "forage-ref-invalid-root-"));
    const invalidRoot = path.join(root, "store-file");
    try {
      await writeFile(invalidRoot, "not a directory", "utf8");
      await assertStoreError(createFilesystemSnapshotStore({ root: invalidRoot }), snapshot);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("contains a non-file exact record", async () => {
    const snapshot = replaySnapshot();
    const unreadableRoot = await mkdtemp(path.join(tmpdir(), "forage-ref-unreadable-entry-"));
    try {
      const { filesystem, record } = await recordPath(unreadableRoot, snapshot);
      await rm(record);
      await mkdir(record);
      await assertStoreError(filesystem, snapshot);
    } finally {
      await rm(unreadableRoot, { recursive: true, force: true });
    }
  });

  it("contains an oversized exact record", async () => {
    const snapshot = replaySnapshot();
    const oversizedRoot = await mkdtemp(path.join(tmpdir(), "forage-ref-oversized-entry-"));
    try {
      const { filesystem, record } = await recordPath(oversizedRoot, snapshot);
      await truncate(record, 96 * 1024 * 1024 + 1);
      await assertStoreError(filesystem, snapshot);
    } finally {
      await rm(oversizedRoot, { recursive: true, force: true });
    }
  });

  it("contains a malformed exact record", async () => {
    const snapshot = replaySnapshot();
    const malformedRoot = await mkdtemp(path.join(tmpdir(), "forage-ref-malformed-entry-"));
    try {
      const { filesystem, record } = await recordPath(malformedRoot, snapshot);
      await rm(record);
      await writeFile(record, "{", "utf8");
      await assertStoreError(filesystem, snapshot);
    } finally {
      await rm(malformedRoot, { recursive: true, force: true });
    }
  });

  it("bounds history reads and isolates foreign filesystem entries", async () => {
    const snapshot = replaySnapshot();
    const root = await mkdtemp(path.join(tmpdir(), "forage-history-bounds-"));
    try {
      const { filesystem, record } = await recordPath(root, snapshot);
      const sourceRoot = path.dirname(record);
      await mkdir(path.join(sourceRoot, "foreign.json"));
      await writeFile(path.join(sourceRoot, "malformed.json"), "{", "utf8");
      await writeFile(path.join(sourceRoot, "oversized.json"), "", "utf8");
      await truncate(path.join(sourceRoot, "oversized.json"), 96 * 1024 * 1024 + 1);
      await writeFile(path.join(sourceRoot, "wrong-source.json"), JSON.stringify({
        ...snapshot,
        sourceId: "different-source",
      }), "utf8");

      assert.deepEqual(await filesystem.list(snapshot.sourceId), [snapshot]);
      assert.deepEqual(await filesystem.latest(snapshot.sourceId), snapshot);
      assert.deepEqual(await filesystem.get(snapshot.sourceId, snapshot.bodyHash), snapshot);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a write beyond the configured history bound without corrupting prior records", async () => {
    const first = replaySnapshot();
    const secondBody = "model: later-result";
    const second: Snapshot = {
      ...first,
      fetchedAt: "2026-07-18T12:01:00.000Z",
      body: secondBody,
      bodyHash: createHash("sha256").update(secondBody).digest("hex"),
    };
    const root = await mkdtemp(path.join(tmpdir(), "forage-history-write-bound-"));
    try {
      const store = createFilesystemSnapshotStore({ root, maxHistoryFiles: 1 });
      await store.put(first);
      await assert.rejects(store.put(second), /snapshot history exceeds 1 records/);
      assert.deepEqual(await store.list(first.sourceId), [first]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes concurrent capacity decisions across filesystem store instances", async () => {
    const initial = replaySnapshot();
    const root = await mkdtemp(path.join(tmpdir(), "forage-history-concurrency-"));
    const candidate = (minute: number): Snapshot => {
      const body = `model: concurrent-${minute}`;
      return {
        ...initial,
        fetchedAt: `2026-07-18T12:0${minute}:00.000Z`,
        body,
        bodyHash: createHash("sha256").update(body).digest("hex"),
      };
    };
    try {
      const firstStore = createFilesystemSnapshotStore({ root, maxHistoryFiles: 3 });
      const secondStore = createFilesystemSnapshotStore({ root, maxHistoryFiles: 3 });
      await firstStore.put(initial);
      await firstStore.put(candidate(1));

      const results = await Promise.allSettled([
        firstStore.put(candidate(2)),
        secondStore.put(candidate(3)),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(results.filter((result) => result.status === "rejected").length, 1);
      assert.equal((await firstStore.list(initial.sourceId)).length, 3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retries an interrupted reserved snapshot idempotently and fixes the history ceiling", async () => {
    const snapshot = replaySnapshot();
    const root = await mkdtemp(path.join(tmpdir(), "forage-history-reservation-retry-"));
    try {
      const { filesystem, record } = await recordPath(root, snapshot);
      await rm(record);
      await filesystem.put(snapshot);
      assert.deepEqual(await filesystem.list(snapshot.sourceId), [snapshot]);

      const differentlyConfigured = createFilesystemSnapshotStore({ root, maxHistoryFiles: 2 });
      await assert.rejects(
        differentlyConfigured.put({ ...snapshot, fetchedAt: "2026-07-18T12:02:00.000Z" }),
        /maxHistoryFiles cannot change/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
