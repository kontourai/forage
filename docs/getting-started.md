# Getting started

This guide installs `@kontourai/forage`, runs a first crawl, stores the pages
as snapshots, and replays them offline. For what each piece is, read
[Concepts](concepts.md). For every option, read the [Reference](reference.md).

## Requirements

- Node.js 22 or newer (`engines.node` is `>=22`).
- The package is ESM only (`"type": "module"`).
- Rendering JavaScript pages is optional. It needs the `playwright` peer
  dependency and its Chromium browser. Without them, forage keeps the plain
  HTTP snapshot and adds a warning.

## Install

```bash
npm install @kontourai/forage
```

Add `playwright` as well only if you want `render: "on-shell"` or
`render: "always"` to drive a real browser:

```bash
npm install playwright
```

## Run a first crawl

`crawl(seed, policy)` walks one site breadth-first and returns a manifest.
Egress is SSRF-guarded, robots.txt is honored, and only same-origin links are
followed, all by default.

```ts
import { crawl } from "@kontourai/forage";

const manifest = await crawl(
  {
    url: "https://example.com/",
    // Identify your crawler. The default user agent carries a placeholder contact.
    userAgent: "my-review-bot/1.0 (+https://example.org/bot; contact: ops@example.org)",
  },
  { maxPages: 8, maxDepth: 1, discovery: "links", render: "never" },
);

for (const page of manifest.pages) {
  console.log(page.depth, page.status, page.url);
  console.log("  cite as:", page.sourceRef);
}
console.log("truncated:", manifest.truncated);
console.log(manifest.warnings);
```

`crawl()` throws only `InvalidCrawlConfigError`, for a bad seed or policy.
Every other failure, such as a denied address, a robots.txt refusal, a timeout,
or an HTTP error, becomes a string in `manifest.warnings`, and the crawl
continues with the next URL.

## Keep snapshots and replay them

Pass a `store` to keep every fetched page. A filesystem store writes one
directory per source under `root`:

```ts
import { crawl, createFilesystemSnapshotStore } from "@kontourai/forage";

const store = createFilesystemSnapshotStore({ root: "./snapshots" });
const seed = { url: "https://example.com/" };

// Live: fetch over the network and put each snapshot into the store.
const live = await crawl(seed, { maxPages: 8, store });

// Replay: no network. Each page is served from the store's latest snapshot.
const replayed = await crawl(seed, { maxPages: 8, store, mode: "replay" });
```

Replay looks pages up by an id built from the seed URL and the page URL, so
replay with the same seed URL you crawled. `mode: "replay"` without a `store`
is an `InvalidCrawlConfigError`.

## Resolve a citation later

A `sourceRef` names one exact snapshot. Resolve it against the store, offline:

```ts
import { resolveSnapshotSourceRef } from "@kontourai/forage/fetch";

const replay = await resolveSnapshotSourceRef(store, page.sourceRef);
if (!replay.ok) throw new Error(`${replay.error.kind}: ${replay.error.message}`);
console.log(replay.snapshot.body);
```

## Fetch a single page

For one URL without a frontier, use `fetchSource()` from the `./fetch` subpath.
It returns `{ snapshot?, error?, warnings? }` and never throws for operational
failures:

```ts
import { fetchSource } from "@kontourai/forage/fetch";

const result = await fetchSource(
  { id: "pricing-page", url: "https://example.com/pricing", egress: { guarded: true } },
  { maxResponseBytes: 8 * 1024 * 1024 },
);
if (result.error) console.error(result.error.kind, result.error.message);
else console.log(result.snapshot!.bodyHash);
```

`fetchSource()` reads a store you pass in `options.store` to revalidate, but it
never writes to it. Call `store.put(snapshot)` yourself if you want to keep the
result.

## Crawl a local test server

The guard rejects loopback addresses and non-default ports, so a crawl of
`http://127.0.0.1:4173/` fails with `egress-denied: ... (INVALID_PORT)`. For
tests, allow that exact origin, and never a production hostname:

```ts
const manifest = await crawl(
  { url: "http://127.0.0.1:4173/" },
  {
    maxPages: 1,
    egress: { guarded: true, testOnlyAllowedLoopbackOrigins: ["http://127.0.0.1:4173"] },
  },
);
```

Each entry must be an exact `http://127.0.0.1:<port>` or `http://[::1]:<port>`
origin with an explicit port.

## Next steps

- [Concepts](concepts.md): the frontier, guarded egress, snapshots, and replay.
- [Reference](reference.md): every export, option, default, and limit.
- [Troubleshooting](troubleshooting.md): what each warning and error means.
