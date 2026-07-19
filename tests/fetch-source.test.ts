// Contract tests for fetchSource()'s conditional-GET (304) revalidation path
// and the Snapshot.notModified transient marker (forage#4, the
// lookout-enabling leg). Mirrors traverse's tests/http-validators.test.ts —
// same fixture shape, same assertions — since forage's fetchSource is lifted
// from traverse's and must match its exact contract. Network-free: a custom
// FetchLike backed by real `Response` objects, no real timers.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchSource, sha256Hex } from "../src/fetch-source.js";
import { createInMemorySnapshotStore } from "../src/snapshot-store.js";
import type {
  FetchLike,
  FetchSourceOptions,
  SourceConfig,
} from "../src/internal-types.js";

const egress = { guarded: false } as const;

function cfg(overrides: Partial<SourceConfig> = {}): SourceConfig {
  return {
    id: "src-1",
    url: "https://example.test/page",
    respectRobots: false,
    egress,
    ...overrides,
  };
}

function fastOpts(extra: FetchSourceOptions = {}): FetchSourceOptions {
  return {
    sleep: async () => {},
    random: () => 0,
    politenessState: new Map(),
    robotsCache: new Map(),
    ...extra,
  };
}

interface RouteSpec {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}

interface FakeFetch extends FetchLike {
  calls: Array<{ url: string; headers: Record<string, string> }>;
}

/** A network-free FetchLike backed by real `Response` objects. */
function fakeFetch(routes: Record<string, RouteSpec | RouteSpec[]>): FakeFetch {
  const queues = new Map<string, RouteSpec[]>();
  for (const [url, spec] of Object.entries(routes)) {
    queues.set(url, Array.isArray(spec) ? [...spec] : [spec]);
  }
  const calls: FakeFetch["calls"] = [];
  const fn = (async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers });
    const queue = queues.get(url);
    if (!queue || queue.length === 0) {
      return new Response("", { status: 404 });
    }
    const spec = queue.length > 1 ? queue.shift()! : queue[0];
    const status = spec.status ?? 200;
    // The Fetch spec forbids a body on a null-body status (204/205/304); the
    // real `Response` constructor throws otherwise.
    const isNullBodyStatus = status === 204 || status === 205 || status === 304;
    return new Response(isNullBodyStatus ? null : (spec.body ?? ""), {
      status,
      headers: spec.headers,
    });
  }) as unknown as FakeFetch;
  fn.calls = calls;
  return fn;
}

describe("fetchSource() — Snapshot.notModified transient marker (forage#4)", () => {
  it("a fresh 200 never sets notModified", async () => {
    const fetch = fakeFetch({
      "https://example.test/page": { status: 200, headers: { etag: '"v1"' }, body: "hello" },
    });
    const result = await fetchSource(cfg(), fastOpts({ fetch }));
    assert.equal(result.error, undefined);
    assert.equal(result.snapshot?.notModified, undefined);
    assert.equal(result.snapshot?.body, "hello");
  });

  it("a 304 revalidation sets snapshot.notModified === true and does not read/replace the body", async () => {
    const store = createInMemorySnapshotStore();
    const first = fakeFetch({
      "https://example.test/page": { status: 200, headers: { etag: '"v1"' }, body: "hello" },
    });
    const captured = await fetchSource(cfg(), fastOpts({ fetch: first, store }));
    assert.equal(captured.snapshot?.notModified, undefined);
    await store.put(captured.snapshot!);

    // A real 304 carries no body (the Fetch spec forbids one on a
    // null-body status) — this asserts fetchSource re-serves the prior
    // snapshot's body rather than treating the empty 304 response as new
    // content.
    const second = fakeFetch({
      "https://example.test/page": { status: 304 },
    });
    const result = await fetchSource(cfg(), fastOpts({ fetch: second, store }));

    assert.equal(result.error, undefined);
    assert.equal(result.snapshot?.notModified, true);
    assert.equal(result.snapshot?.body, "hello", "body must be the byte-identical prior, not the empty 304 response");
    assert.equal(result.snapshot?.bodyHash, captured.snapshot!.bodyHash);
    assert.equal(second.calls[0]?.headers["If-None-Match"], '"v1"');
  });

  it("rejects an unsolicited 304 (no prior snapshot at all) as a typed http-error (false-304 hardening)", async () => {
    const store = createInMemorySnapshotStore(); // empty
    const fetch = fakeFetch({ "https://example.test/page": { status: 304 } });
    const result = await fetchSource(cfg(), fastOpts({ fetch, store }));
    assert.equal(result.snapshot, undefined);
    assert.equal(result.error?.kind, "http-error");
    assert.equal(result.error?.status, 304);
  });

  it("rejects a 304 for a resource that doesn't match the prior's URL (no validator sent) as a typed http-error", async () => {
    const store = createInMemorySnapshotStore();
    const priorUrl = "https://example.test/old";
    const currentUrl = "https://example.test/new";
    const captured = await fetchSource(
      cfg({ url: priorUrl }),
      fastOpts({
        fetch: fakeFetch({
          [priorUrl]: { status: 200, headers: { etag: '"v1"' }, body: "prior" },
        }),
        store,
      }),
    );
    await store.put(captured.snapshot!);

    const fetch = fakeFetch({ [currentUrl]: { status: 304 } });
    const result = await fetchSource(cfg({ url: currentUrl }), fastOpts({ fetch, store }));

    assert.equal(fetch.calls[0]?.headers["If-None-Match"], undefined);
    assert.equal(result.snapshot, undefined);
    assert.equal(result.error?.kind, "http-error");
    assert.equal(result.error?.status, 304);
  });

  it("the persisted store snapshot never carries notModified: true — transient-only, round-trips clean", async () => {
    const store = createInMemorySnapshotStore();
    const first = fakeFetch({
      "https://example.test/page": { status: 200, headers: { etag: '"v1"' }, body: "hello" },
    });
    const captured = await fetchSource(cfg(), fastOpts({ fetch: first, store }));
    await store.put(captured.snapshot!);

    const second = fakeFetch({ "https://example.test/page": { status: 304 } });
    const result = await fetchSource(cfg(), fastOpts({ fetch: second, store }));
    assert.equal(result.snapshot?.notModified, true);

    // fetchSource only READS a store (store.latest()); it never calls
    // store.put() itself. The record placed there before the 304 request
    // must be untouched — no stuck notModified flag.
    const stored = await store.latest("src-1");
    assert.equal(stored?.notModified, undefined);
    assert.equal(stored?.body, "hello");
    assert.equal(stored?.bodyHash, captured.snapshot!.bodyHash);

    // Even if a caller persists the RETURNED 304 snapshot anyway (as
    // forage's own crawl() does), the next revalidation is unaffected:
    // validators are read from `headers`, never from `notModified`.
    await store.put(result.snapshot!);
    const third = fakeFetch({ "https://example.test/page": { status: 304 } });
    const revalidatedAgain = await fetchSource(cfg(), fastOpts({ fetch: third, store }));
    assert.equal(revalidatedAgain.error, undefined);
    assert.equal(revalidatedAgain.snapshot?.notModified, true);
    assert.equal(third.calls[0]?.headers["If-None-Match"], '"v1"');
  });

  it("a fresh 200 during revalidation captures the server's NEW validators and never sets notModified", async () => {
    const store = createInMemorySnapshotStore();
    const first = fakeFetch({
      "https://example.test/page": { status: 200, headers: { etag: '"v1"' }, body: "hello" },
    });
    await store.put((await fetchSource(cfg(), fastOpts({ fetch: first, store }))).snapshot!);

    const second = fakeFetch({
      "https://example.test/page": { status: 200, headers: { etag: '"v2"' }, body: "changed" },
    });
    const result = await fetchSource(cfg(), fastOpts({ fetch: second, store }));
    assert.equal(second.calls[0]?.headers["If-None-Match"], '"v1"');
    assert.equal(result.snapshot?.notModified, undefined);
    assert.equal(result.snapshot?.headers?.etag, '"v2"');
    assert.equal(result.snapshot?.body, "changed");
  });
});

describe("fetchSource() — bounded response streaming", () => {
  it("accepts a response exactly at the caller's byte limit", async () => {
    const fetch = fakeFetch({
      "https://example.test/page": { headers: { "content-length": "5" }, body: "hello" },
    });
    const result = await fetchSource(cfg(), fastOpts({ fetch, maxResponseBytes: 5 }));
    assert.equal(result.error, undefined);
    assert.equal(result.snapshot?.body, "hello");
  });

  it("rejects an oversized declared body before reading it", async () => {
    let cancelled = false;
    const fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("hello!")); },
      cancel() { cancelled = true; },
    }), { headers: { "content-length": "6" } })) as FetchLike;
    const result = await fetchSource(cfg(), fastOpts({ fetch, maxResponseBytes: 5 }));
    assert.equal(result.snapshot, undefined);
    assert.equal(result.error?.kind, "response-too-large");
    assert.equal(cancelled, true);
  });

  it("cancels a chunked response as soon as actual bytes exceed the limit", async () => {
    let cancelled = false;
    const fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("1234"));
        controller.enqueue(new TextEncoder().encode("5678"));
      },
      cancel() { cancelled = true; },
    }))) as FetchLike;
    const result = await fetchSource(cfg(), fastOpts({ fetch, maxResponseBytes: 5 }));
    assert.equal(result.error?.kind, "response-too-large");
    assert.equal(cancelled, true);
  });

  it("rejects an invalid byte limit before network access", async () => {
    const fetch = fakeFetch({ "https://example.test/page": { body: "hello" } });
    const result = await fetchSource(cfg(), fastOpts({ fetch, maxResponseBytes: 0 }));
    assert.equal(result.error?.kind, "invalid-config");
    assert.equal(fetch.calls.length, 0);
  });

  it("bounds robots bodies and proceeds fail-open to the target", async () => {
    const fetch = fakeFetch({
      "https://example.test/robots.txt": {
        headers: { "content-length": String(256 * 1024 + 1) },
        body: "x",
      },
      "https://example.test/page": { body: "hello" },
    });
    const result = await fetchSource(cfg({ respectRobots: true }), fastOpts({ fetch, maxResponseBytes: 5 }));
    assert.equal(result.error, undefined);
    assert.equal(result.snapshot?.body, "hello");
    assert.match(result.warnings?.[0] ?? "", /robots\.txt.*exceeded/);
  });

  it("passes the ceiling into rendering and never returns oversized rendered HTML", async () => {
    let receivedLimit: number | undefined;
    const result = await fetchSource(
      cfg({ render: true }),
      fastOpts({
        fetch: fakeFetch({ "https://example.test/page": { body: "plain" } }),
        maxResponseBytes: 5,
        renderImpl: async (_url, options) => {
          receivedLimit = options?.maxResponseBytes;
          return { html: "rendered" };
        },
      }),
    );
    assert.equal(receivedLimit, 5);
    assert.equal(result.snapshot, undefined);
    assert.equal(result.error?.kind, "response-too-large");
  });

  it("rejects an oversized prior snapshot on a validated 304 response", async () => {
    const store = createInMemorySnapshotStore();
    const prior = {
      sourceId: "src-1",
      url: "https://example.test/page",
      status: 200,
      fetchedAt: "2026-07-18T00:00:00.000Z",
      body: "oversized",
      headers: { etag: '"v1"' },
      bodyHash: sha256Hex("oversized"),
    };
    await store.put(prior);
    const result = await fetchSource(
      cfg(),
      fastOpts({
        fetch: (async () => new Response(null, { status: 304 })) as FetchLike,
        maxResponseBytes: 5,
        store,
      }),
    );
    assert.equal(result.snapshot, undefined);
    assert.equal(result.error?.kind, "response-too-large");
  });
});
