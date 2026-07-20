# forage — design

## Purpose

A survey-neutral crawler for untrusted URLs, feeding human-review pipelines.
Owns the two properties no off-the-shelf crawler bundles — **SSRF/rebinding-safe
egress** and **provenance/replay** — while leaning on commodity ideas/libraries
for the rest (frontier, robots, sitemaps, adaptive render).

## Public surface

```ts
crawl(seed: Seed, policy?: CrawlPolicy): Promise<CrawlManifest>;
// A streaming variant (crawlStream(seed, policy): AsyncIterable<Page>) has
// been discussed but is NOT implemented or exported — crawl() is the only
// public crawl entry point today.

interface Seed {
  url: string;
  render?: boolean;               // seed-only; frontier pages follow policy.render
  headers?: Record<string, string>;
  userAgent?: string;
}

interface CrawlPolicy {
  maxPages?: number;              // clamped to a hard ceiling
  maxDepth?: number;             // seed = depth 0
  sameHost?: boolean;            // default true; cross-host discovery is off by default
  discovery?: "links" | "sitemap" | "both";   // sitemap-first is often the straight line to a listing page
  render?: "never" | "on-shell" | "always";    // adaptive: plain first, render on JS-shell detection
  politeness?: { delayMs?: number; concurrency?: number };
  robots?: boolean;             // default true
  egress?: EgressPolicy;        // SSRF pin ON by default; opt-out is explicit
  mode?: "live" | "replay";     // deterministic replay from a store
  store?: SnapshotStore;        // provenance + replay
  shouldFollow?: (link: DiscoveredLink, ctx: FrontierContext) => boolean | number;
    // optional frontier scorer — a seam a consumer may fill (heuristic, sitemap, or AI).
    // forage core ships NO AI; the hook is where intelligence plugs in, in the consumer.
}

interface Page {
  url: string; status: number;
  body: string | Uint8Array; snapshot: Snapshot;
  sourceRef: string;            // durable, citable pointer to the exact snapshot
  depth: number; rendered: boolean; warnings: string[];
}
```

For the MVP, `Snapshot` also carries the stable crawl-owned `sourceId` used by
`SnapshotStore`, allowing `sourceRef` to resolve the exact stored bytes even
when the fetched URL redirected.

## Load-bearing decisions

- **SSRF-pinned egress, default-on.** Resolve the hostname once, validate every
  answer's IP against the address policy (reject private/loopback/link-local/
  metadata/NAT64/embedded-v4), pin the connection to the one validated public IP
  (a `lookup`/connector that freezes it), preserve hostname for Host/TLS/SNI.
  Redirects re-validate + re-pin per hop; cross-host + downgrade redirects
  refused. This is the pin-not-just-check property most SSRF filters miss.
- **Deterministic replay.** Every fetched page is snapshotted with a `sourceRef`;
  `mode: "replay"` re-serves snapshots byte-identically, network-free — so
  downstream extraction is reproducible and offline-testable.
- **Never-throws.** A malformed page / parse failure degrades to a warning, not a
  thrown crawl. The only whole-crawl typed error is invalid-config.
- **No AI in core.** Deterministic mechanics only. Intelligence, if wanted, plugs
  in at `shouldFollow`, owned by the consumer.
- **Same-host by default.** Cross-host link-following is off (SSRF surface +
  scope creep); explicit opt-in only.

## What forage leans on (not reinvents)

- robots.txt parsing, URL canonicalization/frontier-dedup, sitemap parsing —
  focused libraries.
- Adaptive-render (plain→browser) and the request-frontier concept — Crawlee's
  proven patterns, without adopting its weight (which would fight the pinned
  egress + replay).

## Migration (lift, don't rewrite — the code already runs in prod)

1. **Crawl frontier + fetch mechanics** from `@kontourai/traverse`'s
   `src/fetch/` (crawl / fetch-source / robots / snapshot-store / types) — these
   are already survey-neutral (only `compose.ts` touches `extract`).
2. **SSRF egress policy** from `campfit`'s `lib/security/egress-url-policy.ts`
   (address classification, `evaluateEgressUrl`, the pinned connector) and the
   browser pin from `lib/ingestion/render-fetch.ts` — generic web-security infra
   that never belonged in the app.
3. **traverse** depends on forage; re-exports it from `/fetch` for back-compat so
   nothing importing `@kontourai/traverse/fetch` breaks. `fetchAndExtract`/
   `crawlAndExtract` compose forage's crawl with traverse's extract.
4. **campfit** depends on forage directly for crawling; its egress-policy app-code
   is deleted in favor of the forage default.
5. **New:** sitemap-first discovery + the unified `CrawlPolicy` surface.

Sequence: forage MVP (frontier + fetch + SSRF + replay + ported SSRF/replay
tests) → release → traverse adopts + re-exports → campfit adopts. Each step is
independently shippable; back-compat re-export means no big-bang cutover.
