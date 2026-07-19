// Proves the PUBLIC `@kontourai/forage/fetch` subpath surface (via the
// fetch-index barrel) re-exports a working fetcher + provenance helpers — the
// drop-in surface `@kontourai/lookout` re-points onto (kontourai/lookout#11).
// Exercises the runtime wiring through the barrel itself, not the internal
// modules, mirroring tests/egress-export.test.ts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  type Snapshot,
  type SnapshotStore,
} from "../src/index.js";

const egress = { guarded: false } as const;

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
      notModified: true,
      fromCache: true,
      uncommitted: "must not survive",
    } as Snapshot & { fromCache: boolean; uncommitted: string };
    const ref = buildSnapshotSourceRef(snapshot);
    const memory = createInMemorySnapshotStore();
    await memory.put(snapshot);
    const stored = await memory.latest(snapshot.sourceId);
    assert.equal(stored?.notModified, undefined);
    assert.equal("fromCache" in (stored ?? {}), false);
    assert.equal("uncommitted" in (stored ?? {}), false);

    const root = await mkdtemp(path.join(tmpdir(), "forage-transient-"));
    try {
      const filesystem = createFilesystemSnapshotStore({ root });
      await filesystem.put(snapshot);
      const persisted = await filesystem.latest(snapshot.sourceId);
      assert.equal(persisted?.notModified, undefined);
      assert.equal("fromCache" in (persisted ?? {}), false);
      assert.equal("uncommitted" in (persisted ?? {}), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }

    const customStore: SnapshotStore = {
      put: async () => {},
      latest: async () => snapshot,
      get: async () => snapshot,
      list: async () => [snapshot],
    };
    const replay = await resolveSnapshotSourceRef(customStore, ref);
    assert.equal(replay.ok, true);
    if (replay.ok) {
      assert.equal(replay.snapshot.notModified, undefined);
      assert.equal("fromCache" in replay.snapshot, false);
      assert.equal("uncommitted" in replay.snapshot, false);
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
    const storeWith = (candidate: Snapshot): SnapshotStore => ({
      put: async () => {},
      latest: async () => candidate,
      get: async () => candidate,
      list: async () => [candidate],
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

  it("contains snapshot-store failures without leaking backend details", async () => {
    const body = "model: result";
    const snapshot: Snapshot = {
      sourceId: "trusted-source",
      url: "https://example.test/benchmark.yml",
      status: 200,
      fetchedAt: "2026-07-18T12:00:00.000Z",
      body,
      bodyHash: createHash("sha256").update(body).digest("hex"),
    };
    const failingStore: SnapshotStore = {
      put: async () => {},
      latest: async () => undefined,
      get: async () => undefined,
      list: async () => {
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

    const malformedListStore: SnapshotStore = {
      ...failingStore,
      list: async () => null as unknown as Snapshot[],
    };
    const malformedList = await resolveSnapshotSourceRef(
      malformedListStore,
      buildSnapshotSourceRef(snapshot),
    );
    assert.equal(malformedList.ok, false);
    if (!malformedList.ok) assert.equal(malformedList.error.kind, "snapshot-store-error");

    const throwingCandidate = Object.defineProperty({}, "bodyHash", {
      get() {
        throw new Error("PRIVATE_BACKEND_DETAIL");
      },
    }) as Snapshot;
    const throwingCandidateStore: SnapshotStore = {
      ...failingStore,
      list: async () => [throwingCandidate],
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

    const root = await mkdtemp(path.join(tmpdir(), "forage-ref-invalid-root-"));
    const invalidRoot = path.join(root, "store-file");
    try {
      await writeFile(invalidRoot, "not a directory", "utf8");
      const filesystemFailure = await resolveSnapshotSourceRef(
        createFilesystemSnapshotStore({ root: invalidRoot }),
        buildSnapshotSourceRef(snapshot),
      );
      assert.equal(filesystemFailure.ok, false);
      if (!filesystemFailure.ok) {
        assert.equal(filesystemFailure.error.kind, "snapshot-store-error");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
