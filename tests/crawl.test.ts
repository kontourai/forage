import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it, mock } from "node:test";
import { gzipSync } from "node:zlib";
import {
  InvalidCrawlConfigError,
  crawl,
  createFilesystemSnapshotStore,
  createInMemorySnapshotStore,
  type Snapshot,
} from "../src/index.js";
import { crawlWithOptions } from "../src/crawl.js";
import {
  createGuardedFetch,
  type EgressResponseOracle,
} from "../src/egress.js";

const origin = "http://127.0.0.1:43127";
const policyEgress = {
  guarded: true,
  testOnlyAllowedLoopbackOrigins: [origin],
} as const;
const guardedFixture = (...responses: EgressResponseOracle["responses"]) => ({
  fetch: createGuardedFetch({
    testOnlyAllowedLoopbackOrigins: [origin],
    responseOracle: { responses },
  }),
});

afterEach(() => mock.restoreAll());

describe("crawl", () => {
  it("runs a bounded same-host BFS, honors robots, and captures provenance", async () => {
    const store = createInMemorySnapshotStore();
    const manifest = await crawlWithOptions(
        { url: origin },
        {
          maxPages: 4,
          maxDepth: 1,
          discovery: "links",
          politeness: { delayMs: 0 },
          store,
          egress: policyEgress,
        },
        guardedFixture(
          {
            urlSuffix: "/robots.txt",
            body: "User-agent: *\nDisallow: /blocked\n",
            headers: { "content-type": "text/plain" },
            repeat: true,
          },
          {
            urlSuffix: `${origin}/`,
            body: '<a href="/a">A</a><a href="/blocked">blocked</a><a href="/a#again">dupe</a><a href="https://other.example/">offsite</a>',
            headers: { "content-type": "text/html; charset=utf-8" },
          },
          {
            urlSuffix: "/a",
            body: "<p>page a</p>",
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        ),
      );
      assert.deepEqual(
        manifest.pages.map((page) => [page.url, page.depth]),
        [
          [`${origin}/`, 0],
          [`${origin}/a`, 1],
        ],
      );
      assert.equal(manifest.truncated, false);
      assert.ok(manifest.warnings.some((warning) => warning.includes("robots-denied")));
      for (const page of manifest.pages) {
        assert.match(page.sourceRef, /^forage-snapshot:/);
        assert.match(page.snapshot.bodyHash, /^[a-f0-9]{64}$/);
        assert.equal(page.snapshot.sourceId.length > 0, true);
        assert.equal(
          (await store.get(page.snapshot.sourceId, page.snapshot.bodyHash))
            ?.bodyHash,
          page.snapshot.bodyHash,
        );
      }
  });

  it("replays the same pages and bytes with the network offline", async () => {
    const store = createInMemorySnapshotStore();
    const policy = {
      maxPages: 2,
      maxDepth: 1,
      store,
      politeness: { delayMs: 0 },
      egress: policyEgress,
    } as const;
    const live = await crawlWithOptions(
      { url: origin },
      policy,
      guardedFixture(
        {
          urlSuffix: "/robots.txt",
          body: "User-agent: *\nDisallow:\n",
          repeat: true,
        },
        {
          urlSuffix: `${origin}/`,
          body: '<a href="/next">next</a>',
          headers: { "content-type": "text/html" },
        },
        {
          urlSuffix: "/next",
          body: "<p>replayed exactly</p>",
          headers: { "content-type": "text/html" },
        },
      ),
    );
    const replay = await crawl(
      { url: origin },
      { ...policy, mode: "replay" },
    );
    assert.deepEqual(replay.pages, live.pages);
    assert.deepEqual(
      replay.pages.map((page) => page.body),
      live.pages.map((page) => page.body),
    );
  });

  it("uses matching validators and re-serves the prior snapshot on 304", async () => {
      const store = createInMemorySnapshotStore();
      const policy = {
        maxPages: 1,
        maxDepth: 0,
        store,
        politeness: { delayMs: 0 },
        egress: {
          guarded: true,
          testOnlyAllowedLoopbackOrigins: [origin],
        },
      } as const;
      const first = await crawlWithOptions(
        { url: origin },
        policy,
        guardedFixture(
          { urlSuffix: "/robots.txt", body: "User-agent: *\nDisallow:\n" },
          {
            urlSuffix: `${origin}/`,
            body: "<p>stable</p>",
            headers: { "content-type": "text/html", etag: '"fixture-v1"' },
          },
        ),
      );
      const second = await crawlWithOptions(
        { url: origin },
        policy,
        guardedFixture(
          { urlSuffix: "/robots.txt", body: "User-agent: *\nDisallow:\n" },
          {
            urlSuffix: `${origin}/`,
            status: 304,
            whenHeaders: { "if-none-match": '"fixture-v1"' },
          },
        ),
      );
      assert.equal(second.pages[0]?.sourceRef, first.pages[0]?.sourceRef);
      assert.equal(second.pages[0]?.body, "<p>stable</p>");
  });

  it("marks a remaining frontier truncated when maxPages is reached", async () => {
      const manifest = await crawlWithOptions(
        { url: origin },
        {
          maxPages: 2,
          maxDepth: 1,
          politeness: { delayMs: 0 },
          egress: policyEgress,
        },
        guardedFixture(
          {
            urlSuffix: "/robots.txt",
            body: "User-agent: *\nDisallow:\n",
            repeat: true,
          },
          {
            urlSuffix: `${origin}/`,
            body: '<a href="/a">a</a><a href="/b">b</a>',
            headers: { "content-type": "text/html" },
          },
          {
            urlSuffix: "/a",
            body: "<p>child</p>",
            headers: { "content-type": "text/html" },
          },
        ),
      );
      assert.equal(manifest.pages.length, 2);
      assert.equal(manifest.truncated, true);
      assert.ok(manifest.warnings.some((warning) => warning.includes("maxPages cap")));
  });

  it("fails closed but returns warnings for a denied live target", async () => {
    const manifest = await crawl(
      { url: "http://169.254.169.254/latest/meta-data" },
      { maxPages: 1, politeness: { delayMs: 0 } },
    );
    assert.deepEqual(manifest.pages, []);
    assert.ok(manifest.warnings.some((warning) => warning.includes("DENIED_ADDRESS")));
  });

  it("allows loopback only through the explicit guarded false opt-out", async () => {
    const calls: string[] = [];
    mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response("<p>explicit opt-out fixture</p>", {
        headers: { "content-type": "text/html" },
      });
    });
    const manifest = await crawl(
      { url: "http://127.0.0.1:43127/" },
      {
        maxPages: 1,
        robots: false,
        politeness: { delayMs: 0 },
        egress: { guarded: false },
      },
    );
    assert.equal(manifest.pages[0]?.body, "<p>explicit opt-out fixture</p>");
    assert.deepEqual(calls, ["http://127.0.0.1:43127/"]);
  });

  it("does not forward seed credentials to an opted-in cross-host page", async () => {
    const guarded = createGuardedFetch({
      resolver: async (hostname) => [
        {
          address:
            hostname === "seed.example" ? "93.184.216.34" : "93.184.216.35",
        },
      ],
      responseOracle: {
        responses: [
          {
            urlSuffix: "/robots.txt",
            body: "User-agent: *\nDisallow:\n",
            repeat: true,
          },
          {
            urlSuffix: "seed.example/",
            body: '<a href="https://other.example/">other</a>',
            headers: { "content-type": "text/html" },
          },
          {
            urlSuffix: "other.example/",
            body: "<p>other</p>",
            headers: { "content-type": "text/html" },
            withoutHeaders: ["authorization"],
          },
        ],
      },
    });
    const manifest = await crawlWithOptions(
      {
        url: "https://seed.example/",
        headers: { Authorization: "Bearer secret" },
      },
      {
        maxPages: 2,
        maxDepth: 1,
        sameHost: false,
        politeness: { delayMs: 0 },
      },
      { fetch: guarded },
    );
    assert.deepEqual(
      manifest.pages.map((page) => page.url),
      ["https://seed.example/", "https://other.example/"],
    );
  });

  it("refuses cross-host and downgrade redirects before a second fetch", async () => {
      const manifest = await crawlWithOptions(
        { url: origin },
        {
          maxPages: 1,
          politeness: { delayMs: 0 },
          egress: policyEgress,
        },
        guardedFixture(
          { urlSuffix: "/robots.txt", body: "User-agent: *\nDisallow:\n" },
          {
            urlSuffix: `${origin}/`,
            status: 302,
            headers: {
              location: "http://169.254.169.254/latest/meta-data",
            },
          },
        ),
      );
      assert.deepEqual(manifest.pages, []);
      assert.ok(
        manifest.warnings.some((warning) => warning.includes("cross-host")),
      );
  });

  it("surfaces genuinely deferred policy fields as explicit warnings", async () => {
    const store = createInMemorySnapshotStore();
    const manifest = await crawl(
      { url: "https://example.test", render: true },
      {
        maxPages: 0,
        discovery: "both",
        render: "always",
        politeness: { concurrency: 2 },
        shouldFollow: () => true,
        store,
      },
    );
    assert.ok(manifest.warnings.length >= 3);
    assert.deepEqual(manifest.sitemap, {
      documentsRead: 0,
      urlsDiscovered: 0,
    });
    assert.equal(manifest.truncated, true);
  });

  it("throws only for invalid caller configuration", async () => {
    await assert.rejects(
      crawl({ url: "not a URL" }),
      InvalidCrawlConfigError,
    );
    await assert.rejects(
      crawl({ url: "https://example.test" }, { mode: "replay" }),
      InvalidCrawlConfigError,
    );
  });
});

describe("sitemap discovery", () => {
  const openRobots = {
    urlSuffix: "/robots.txt",
    body: "User-agent: *\nDisallow:\n",
    headers: { "content-type": "text/plain" },
  } as const;
  const html = (urlSuffix: string, body = "<p>fixture</p>") => ({
    urlSuffix,
    body,
    headers: { "content-type": "text/html" },
  });
  const sitemapPolicy = (overrides: Record<string, unknown> = {}) => ({
    maxPages: 10,
    maxDepth: 1,
    discovery: "sitemap" as const,
    politeness: { delayMs: 0 },
    egress: policyEgress,
    ...overrides,
  });

  it("seeds the frontier from a conventional urlset without following page links", async () => {
    const manifest = await crawlWithOptions(
      { url: origin },
      sitemapPolicy(),
      guardedFixture(
        openRobots,
        {
          urlSuffix: "/sitemap.xml",
          body: `<urlset><url><loc>${origin}/camps</loc></url><url><loc>${origin}/detail?x=1&amp;y=2</loc></url></urlset>`,
          headers: { "content-type": "application/xml" },
        },
        html(`${origin}/`, '<a href="/links-must-not-run">no</a>'),
        html("/camps"),
        html("/detail?x=1&y=2"),
      ),
    );
    assert.deepEqual(
      manifest.pages.map((page) => [page.url, page.depth]),
      [[`${origin}/`, 0], [`${origin}/camps`, 1], [`${origin}/detail?x=1&y=2`, 1]],
    );
    assert.deepEqual(manifest.sitemap, { documentsRead: 1, urlsDiscovered: 2 });
  });

  it("uses robots Sitemap directives before the conventional location", async () => {
    const manifest = await crawlWithOptions(
      { url: origin },
      sitemapPolicy(),
      guardedFixture(
        {
          urlSuffix: "/robots.txt",
          body: `User-agent: *\nDisallow:\nSitemap: ${origin}/custom-map.xml\n`,
        },
        {
          urlSuffix: "/custom-map.xml",
          body: `<urlset><url><loc>${origin}/from-robots</loc></url></urlset>`,
          headers: { "content-type": "application/xml" },
        },
        html(`${origin}/`),
        html("/from-robots"),
      ),
    );
    assert.deepEqual(manifest.pages.map((page) => page.url), [
      `${origin}/`,
      `${origin}/from-robots`,
    ]);
  });

  it("recursively reads a sitemap index", async () => {
    const manifest = await crawlWithOptions(
      { url: origin },
      sitemapPolicy(),
      guardedFixture(
        openRobots,
        {
          urlSuffix: "/sitemap.xml",
          body: `<sitemapindex><sitemap><loc>${origin}/nested.xml</loc></sitemap></sitemapindex>`,
          headers: { "content-type": "application/xml" },
        },
        {
          urlSuffix: "/nested.xml",
          body: `<urlset><url><loc><![CDATA[${origin}/nested-page]]></loc></url></urlset>`,
          headers: { "content-type": "application/xml" },
        },
        html(`${origin}/`),
        html("/nested-page"),
      ),
    );
    assert.equal(manifest.pages[1]?.url, `${origin}/nested-page`);
    assert.deepEqual(manifest.sitemap, { documentsRead: 2, urlsDiscovered: 1 });
  });

  it("gunzips .xml.gz sitemap documents", async () => {
    const bytes = gzipSync(
      `<urlset><url><loc>${origin}/compressed</loc></url></urlset>`,
    );
    const manifest = await crawlWithOptions(
      { url: origin },
      sitemapPolicy(),
      guardedFixture(
        {
          urlSuffix: "/robots.txt",
          body: `Sitemap: ${origin}/sitemap.xml.gz`,
        },
        {
          urlSuffix: "/sitemap.xml.gz",
          bodyBytes: [...bytes],
          headers: { "content-type": "application/gzip" },
        },
        html(`${origin}/`),
        html("/compressed"),
      ),
    );
    assert.equal(manifest.pages[1]?.url, `${origin}/compressed`);
  });

  it("fails closed through the guard for an internal robots sitemap target", async () => {
    const manifest = await crawlWithOptions(
      { url: origin },
      sitemapPolicy(),
      guardedFixture(
        {
          urlSuffix: "/robots.txt",
          body: "Sitemap: http://169.254.169.254/latest/meta-data\n",
        },
        html(`${origin}/`),
      ),
    );
    assert.equal(manifest.sitemap?.documentsRead, 0);
    assert.ok(manifest.warnings.some((warning) => warning.includes("DENIED_ADDRESS")));
  });

  it("drops cross-host page locations", async () => {
    const manifest = await crawlWithOptions(
      { url: origin },
      sitemapPolicy(),
      guardedFixture(
        openRobots,
        {
          urlSuffix: "/sitemap.xml",
          body: `<urlset><url><loc>${origin}/local</loc></url><url><loc>https://other.example/foreign</loc></url></urlset>`,
          headers: { "content-type": "application/xml" },
        },
        html(`${origin}/`),
        html("/local"),
      ),
    );
    assert.deepEqual(manifest.pages.map((page) => page.url), [`${origin}/`, `${origin}/local`]);
    assert.ok(manifest.warnings.some((warning) => warning.includes("off-host sitemap page")));
  });

  it("merges and deduplicates sitemap and link discovery in both mode", async () => {
    const manifest = await crawlWithOptions(
      { url: origin },
      sitemapPolicy({ discovery: "both", maxPages: 4 }),
      guardedFixture(
        openRobots,
        {
          urlSuffix: "/sitemap.xml",
          body: `<urlset><url><loc>${origin}/shared</loc></url><url><loc>${origin}/map-only</loc></url></urlset>`,
          headers: { "content-type": "application/xml" },
        },
        html(`${origin}/`, '<a href="/shared">shared</a><a href="/link-only">link</a>'),
        html("/shared"),
        html("/map-only"),
        html("/link-only"),
      ),
    );
    assert.deepEqual(manifest.pages.map((page) => page.url), [
      `${origin}/`,
      `${origin}/shared`,
      `${origin}/map-only`,
      `${origin}/link-only`,
    ]);
  });

  it("does not request robots or a sitemap in links mode", async () => {
    const calls: string[] = [];
    const guarded = guardedFixture(
      html(`${origin}/`, '<a href="/linked">link</a>'),
      html("/linked"),
    ).fetch;
    const manifest = await crawlWithOptions(
      { url: origin },
      {
        maxPages: 2,
        maxDepth: 1,
        discovery: "links",
        robots: false,
        politeness: { delayMs: 0 },
        egress: policyEgress,
      },
      { fetch: async (url, init) => { calls.push(url); return guarded(url, init); } },
    );
    assert.deepEqual(manifest.pages.map((page) => page.url), [`${origin}/`, `${origin}/linked`]);
    assert.equal(calls.some((url) => url.endsWith("/sitemap.xml")), false);
    assert.equal(manifest.sitemap, undefined);
  });

  it("truncates discovered URLs at a bounded cap and warns", async () => {
    const manifest = await crawlWithOptions(
      { url: origin },
      sitemapPolicy({ maxPages: 2 }),
      guardedFixture(
        openRobots,
        {
          urlSuffix: "/sitemap.xml",
          body: `<urlset><url><loc>${origin}/one</loc></url><url><loc>${origin}/two</loc></url><url><loc>${origin}/three</loc></url></urlset>`,
          headers: { "content-type": "application/xml" },
        },
        html(`${origin}/`),
        html("/one"),
      ),
    );
    assert.ok(manifest.warnings.some((warning) => warning.includes("sitemap URL cap (2)")));
    assert.equal(manifest.truncated, true);
  });

  it("bounds sitemap index fan-out at the document cap", async () => {
    const locations = Array.from(
      { length: 60 },
      (_, index) => `<sitemap><loc>${origin}/maps/${index}.xml</loc></sitemap>`,
    ).join("");
    const manifest = await crawlWithOptions(
      { url: origin },
      sitemapPolicy({ maxPages: 2 }),
      guardedFixture(
        openRobots,
        {
          urlSuffix: "/sitemap.xml",
          body: `<sitemapindex>${locations}</sitemapindex>`,
          headers: { "content-type": "application/xml" },
        },
        {
          urlSuffix: ".xml",
          body: "<urlset></urlset>",
          headers: { "content-type": "application/xml" },
          repeat: true,
        },
        html(`${origin}/`),
      ),
    );
    assert.equal(manifest.sitemap?.documentsRead, 50);
    assert.ok(manifest.warnings.some((warning) => warning.includes("sitemap document cap (50)")));
  });

  it("stops nested indexes at the depth cap", async () => {
    const index = (next: string) => ({
      urlSuffix: `/maps/${next === "4" ? "3" : String(Number(next) - 1)}.xml`,
      body: `<sitemapindex><sitemap><loc>${origin}/maps/${next}.xml</loc></sitemap></sitemapindex>`,
      headers: { "content-type": "application/xml" },
    });
    const manifest = await crawlWithOptions(
      { url: origin },
      sitemapPolicy({ maxPages: 2 }),
      guardedFixture(
        {
          urlSuffix: "/robots.txt",
          body: `Sitemap: ${origin}/maps/0.xml`,
        },
        index("1"),
        index("2"),
        index("3"),
        index("4"),
        html(`${origin}/`),
      ),
    );
    assert.equal(manifest.sitemap?.documentsRead, 4);
    assert.ok(manifest.warnings.some((warning) => warning.includes("sitemap nesting depth cap (3)")));
  });

  it("retains parseable locations and warns for malformed XML", async () => {
    const manifest = await crawlWithOptions(
      { url: origin },
      sitemapPolicy(),
      guardedFixture(
        openRobots,
        {
          urlSuffix: "/sitemap.xml",
          body: `<urlset><url><loc>${origin}/kept</loc></url><url><loc>${origin}/broken</url></urlset>`,
          headers: { "content-type": "application/xml" },
        },
        html(`${origin}/`),
        html("/kept"),
      ),
    );
    assert.equal(manifest.pages[1]?.url, `${origin}/kept`);
    assert.ok(manifest.warnings.some((warning) => warning.includes("malformed or unrecognized XML")));
  });
});

describe("filesystem snapshot store", () => {
  it("round-trips binary snapshot bodies byte-identically", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "forage-store-"));
    try {
      const store = createFilesystemSnapshotStore({ root });
      const snapshot: Snapshot = {
        sourceId: "binary-fixture",
        url: "https://example.test/file.bin",
        status: 200,
        fetchedAt: "2026-07-13T12:00:00.000Z",
        body: new Uint8Array([0, 255, 1, 254, 2]),
        bodyHash:
          "243876a7a7952190ccf8f470122e8acbd8584c682be5f70f70875af8bb7901fc",
      };
      await store.put(snapshot);
      const replay = await store.get(snapshot.sourceId, snapshot.bodyHash);
      assert.ok(replay?.body instanceof Uint8Array);
      assert.deepEqual(replay.body, snapshot.body);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
