import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { crawlWithOptions } from "../src/crawl.js";
import {
  EgressUrlPolicyError,
  createGuardedFetch,
  type EgressResolver,
  type EgressResponseOracle,
} from "../src/egress.js";
import type { RenderImpl } from "../src/internal-types.js";
import {
  createForageRenderImpl,
  installGuardedPageNetwork,
  preparePinnedBrowserNavigation,
  type BrowserPage,
} from "../src/render.js";
import { createInMemorySnapshotStore } from "../src/snapshot-store.js";

const origin = "http://127.0.0.1:43127";
const egress = {
  guarded: true,
  testOnlyAllowedLoopbackOrigins: [origin],
} as const;
const fixture = (...responses: EgressResponseOracle["responses"]) => ({
  fetch: createGuardedFetch({
    testOnlyAllowedLoopbackOrigins: [origin],
    responseOracle: { responses },
  }),
});
const openRobots = {
  urlSuffix: "/robots.txt",
  body: "User-agent: *\nDisallow:\n",
  repeat: true,
} as const;
const html = (urlSuffix: string, body: string) => ({
  urlSuffix,
  body,
  headers: { "content-type": "text/html" },
});

describe("adaptive render frontier (mock RenderImpl; no live browser)", () => {
  it("render:'always' renders every page and marks each snapshot", async () => {
    const calls: string[] = [];
    const renderImpl: RenderImpl = async (url) => {
      calls.push(url);
      return {
        html: url.endsWith("/child")
          ? "<main>rendered child</main>"
          : '<main>rendered seed <a href="/child">child</a></main>',
      };
    };
    const manifest = await crawlWithOptions(
      { url: origin },
      {
        maxPages: 2,
        maxDepth: 1,
        render: "always",
        politeness: { delayMs: 0 },
        egress,
      },
      {
        ...fixture(openRobots, html(`${origin}/`, "<p>plain</p>"), html("/child", "<p>plain child</p>")),
        renderImpl,
      },
    );
    assert.deepEqual(calls, [`${origin}/`, `${origin}/child`]);
    assert.deepEqual(manifest.pages.map((page) => page.rendered), [true, true]);
    assert.ok(manifest.pages.every((page) => page.snapshot.rendered === true));
  });

  it("render:'on-shell' escalates a JS shell but keeps substantive HTML plain", async () => {
    const calls: string[] = [];
    const manifest = await crawlWithOptions(
      { url: origin },
      {
        maxPages: 2,
        maxDepth: 1,
        render: "on-shell",
        politeness: { delayMs: 0 },
        egress,
      },
      {
        ...fixture(
          openRobots,
          html(`${origin}/`, '<div id="root"></div><script src="/app.js"></script>'),
          html("/article", `<article>${"Useful prose. ".repeat(30)}</article>`),
        ),
        renderImpl: async (url) => {
          calls.push(url);
          return { html: '<main>hydrated <a href="/article">article</a></main>' };
        },
      },
    );
    assert.deepEqual(calls, [`${origin}/`]);
    assert.deepEqual(manifest.pages.map((page) => page.rendered), [true, false]);
  });

  it("Seed.render renders only the seed when policy rendering is off", async () => {
    const calls: string[] = [];
    const manifest = await crawlWithOptions(
      { url: origin, render: true },
      { maxPages: 1, render: "never", politeness: { delayMs: 0 }, egress },
      {
        ...fixture(openRobots, html(`${origin}/`, "<p>plain</p>")),
        renderImpl: async (url) => {
          calls.push(url);
          return { html: "<p>rendered seed</p>" };
        },
      },
    );
    assert.deepEqual(calls, [`${origin}/`]);
    assert.equal(manifest.pages[0]?.rendered, true);
  });

  it("checks robots once against the requested URL before rendering", async () => {
    const fetched: string[] = [];
    const guarded = createGuardedFetch({
      testOnlyAllowedLoopbackOrigins: [origin],
      responseOracle: {
        responses: [
          openRobots,
          { urlSuffix: `${origin}/start`, status: 302, headers: { location: "/final" } },
          html("/final", "<p>plain final</p>"),
        ],
      },
    });
    await crawlWithOptions(
      { url: `${origin}/start` },
      { maxPages: 1, render: "always", politeness: { delayMs: 0 }, egress },
      {
        fetch: async (url, init) => {
          fetched.push(url);
          return guarded(url, init);
        },
        renderImpl: async () => ({ html: "<p>rendered</p>" }),
      },
    );
    assert.equal(fetched.filter((url) => url.endsWith("/robots.txt")).length, 1);
    assert.deepEqual(fetched, [
      `${origin}/robots.txt`,
      `${origin}/start`,
      `${origin}/final`,
    ]);
  });

  it("optional-Playwright absence degrades to the plain snapshot with a warning", async () => {
    const manifest = await crawlWithOptions(
      { url: origin },
      { maxPages: 1, render: "always", politeness: { delayMs: 0 }, egress },
      {
        ...fixture(openRobots, html(`${origin}/`, "<p>plain fallback</p>")),
        renderImpl: async () => {
          throw new Error("render unavailable: optional peer dependency 'playwright' is not installed");
        },
      },
    );
    assert.equal(manifest.pages[0]?.body, "<p>plain fallback</p>");
    assert.equal(manifest.pages[0]?.rendered, false);
    assert.ok(manifest.warnings.some((warning) => warning.includes("playwright")));
  });

  it("an arbitrary render failure never throws and keeps the plain snapshot", async () => {
    const manifest = await crawlWithOptions(
      { url: origin },
      { maxPages: 1, render: "always", politeness: { delayMs: 0 }, egress },
      {
        ...fixture(openRobots, html(`${origin}/`, "<p>still useful</p>")),
        renderImpl: async () => { throw new Error("browser crashed"); },
      },
    );
    assert.equal(manifest.pages[0]?.body, "<p>still useful</p>");
    assert.ok(manifest.warnings.some((warning) => warning.includes("browser crashed")));
  });

  it("replays a rendered snapshot byte-identically without invoking a browser", async () => {
    const store = createInMemorySnapshotStore();
    const policy = {
      maxPages: 1,
      render: "always" as const,
      politeness: { delayMs: 0 },
      egress,
      store,
    };
    const live = await crawlWithOptions(
      { url: origin },
      policy,
      {
        ...fixture(openRobots, html(`${origin}/`, "<p>plain</p>")),
        renderImpl: async () => ({ html: "<p>stable rendered bytes</p>" }),
      },
    );
    const replay = await crawlWithOptions(
      { url: origin },
      { ...policy, mode: "replay" },
      { renderImpl: async () => { throw new Error("must not run"); } },
    );
    assert.deepEqual(replay.pages, live.pages);
    assert.equal(replay.pages[0]?.snapshot.rendered, true);
  });
});

describe("pinned browser security (mock browser routes; no live browser)", () => {
  it("pins Chromium to the first forage-validated public IP and never asks for a rebinding answer", async () => {
    let resolutions = 0;
    const resolver: EgressResolver = async () => [{
      address: ++resolutions === 1 ? "93.184.216.34" : "169.254.169.254",
    }];
    const launches: string[][] = [];
    const render = createForageRenderImpl({
      resolver,
      testOnlyBrowserLauncher: async ({ args }) => {
        launches.push(args);
        return {
          newPage: async () => ({
            route: async () => undefined,
            goto: async () => undefined,
            content: async () => "<p>rendered</p>",
            close: async () => undefined,
          }),
          close: async () => undefined,
        };
      },
    });
    await render("https://rebinding.example/");
    assert.equal(resolutions, 1);
    assert.ok(launches[0]?.includes("--host-resolver-rules=MAP rebinding.example 93.184.216.34"));
    assert.ok(launches[0]?.includes("--no-proxy-server"));
  });

  it("refuses metadata/private targets before launching Chromium", async () => {
    let launches = 0;
    const render = createForageRenderImpl({
      testOnlyBrowserLauncher: async () => {
        launches++;
        throw new Error("must not launch");
      },
    });
    await assert.rejects(render("http://169.254.169.254/latest/meta-data"), EgressUrlPolicyError);
    assert.equal(launches, 0);
  });

  it("launches and closes a dedicated Chromium process for every pinned render", async () => {
    let launches = 0;
    let closes = 0;
    const render = createForageRenderImpl({
      resolver: async () => [{ address: "93.184.216.34" }],
      testOnlyBrowserLauncher: async () => {
        launches++;
        return {
          newPage: async () => ({
            route: async () => undefined,
            goto: async () => undefined,
            content: async () => "<p>ok</p>",
            close: async () => undefined,
          }),
          close: async () => { closes++; },
        };
      },
    });
    await render("https://one.example/");
    await render("https://two.example/");
    assert.deepEqual({ launches, closes }, { launches: 2, closes: 2 });
  });

  it("rejects rendered HTML that exceeds the caller's byte ceiling", async () => {
    let closes = 0;
    const render = createForageRenderImpl({
      resolver: async () => [{ address: "93.184.216.34" }],
      testOnlyBrowserLauncher: async () => ({
        newPage: async () => ({
          route: async () => undefined,
          goto: async () => undefined,
          content: async () => "rendered",
          close: async () => { closes++; },
        }),
        close: async () => { closes++; },
      }),
    });
    await assert.rejects(
      render("https://render.example/", { maxResponseBytes: 5 }),
      /rendered response exceeds 5 bytes/,
    );
    assert.equal(closes, 2);
  });

  it("refuses resolver-rule injection hostnames", async () => {
    await assert.rejects(
      preparePinnedBrowserNavigation(
        "https://safe.example,MAP-attacker.test/",
        async () => [{ address: "93.184.216.34" }],
      ),
      (error: unknown) => error instanceof EgressUrlPolicyError && error.code === "INVALID_HOST",
    );
  });

  it("blocks cross-host redirects, HTTPS downgrades, and internal subresources", async () => {
    let handler: ((route: any) => Promise<void>) | undefined;
    const page = {
      route: async (_pattern: string, routeHandler: (route: any) => Promise<void>) => {
        handler = routeHandler;
      },
    } as unknown as BrowserPage;
    const pinned = await preparePinnedBrowserNavigation(
      "https://safe.example/",
      async () => [{ address: "93.184.216.34" }],
    );
    await installGuardedPageNetwork(page, pinned);
    assert.ok(handler);

    const decision = async (url: string, from?: string) => {
      let action = "";
      await handler!({
        request: () => ({
          url: () => url,
          redirectedFrom: () => from ? { url: () => from } : null,
        }),
        continue: async () => { action = "continue"; },
        abort: async () => { action = "abort"; },
      });
      return action;
    };

    assert.equal(await decision("https://other.example/", "https://safe.example/"), "abort");
    assert.equal(await decision("http://safe.example/", "https://safe.example/"), "abort");
    assert.equal(await decision("http://169.254.169.254/latest/meta-data"), "abort");
    assert.equal(await decision("https://safe.example/app.js"), "continue");
  });
});
