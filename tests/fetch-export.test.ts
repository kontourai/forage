// Proves the PUBLIC `@kontourai/forage/fetch` subpath surface (via the
// fetch-index barrel) re-exports a working fetcher + provenance helpers — the
// drop-in surface `@kontourai/lookout` re-points onto (kontourai/lookout#11).
// Exercises the runtime wiring through the barrel itself, not the internal
// modules, mirroring tests/egress-export.test.ts.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fetchSource,
  buildSnapshotSourceRef,
  parseSnapshotSourceRef,
  type FetchLike,
  type SourceConfig,
} from "../src/fetch-index.js";
import type { Snapshot } from "../src/index.js";

const egress = { guarded: false } as const;

describe("@kontourai/forage/fetch public surface", () => {
  it("re-exports the primitives as callable values through the barrel", () => {
    assert.equal(typeof fetchSource, "function");
    assert.equal(typeof buildSnapshotSourceRef, "function");
    assert.equal(typeof parseSnapshotSourceRef, "function");
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
  });

  it("parseSnapshotSourceRef round-trips buildSnapshotSourceRef exactly and rejects foreign/malformed refs", () => {
    const snapshot: Snapshot = {
      sourceId: "id/with?odd&chars",
      url: "https://example.test/a?b=c#frag",
      status: 200,
      fetchedAt: "2026-07-16T00:00:00.000Z",
      body: "x",
      bodyHash: "a".repeat(64),
    };
    const ref = buildSnapshotSourceRef(snapshot);
    const parsed = parseSnapshotSourceRef(ref);
    assert.deepEqual(parsed, {
      sourceId: snapshot.sourceId,
      url: snapshot.url,
      bodyHash: snapshot.bodyHash,
      fetchedAt: snapshot.fetchedAt,
    });

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
  });
});
