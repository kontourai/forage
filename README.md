# forage

**Safe, replayable web crawling for review pipelines — a crawler for _untrusted_ URLs.**

Most crawlers assume *you* pick the sites: trusted seeds, crawl the public web at
scale, hand the pages downstream. `forage` is for the other job — when the URLs
come from **somewhere you don't control** (an aggregator's listings, links
discovered mid-crawl, user submissions) and the pages become **evidence a human
will review and cite.**

That job sits at the intersection of three tools that normally don't come
together, and `forage` is that intersection:

- a **crawler** (frontier, robots, politeness, sitemaps, adaptive rendering),
- a **security proxy** (SSRF + DNS-rebinding-safe egress, on by default), and
- a **provenance layer** (deterministic snapshots you can replay and cite).

## Why it's different

| | Typical crawler (Scrapy, Crawlee, Colly) | `forage` |
|---|---|---|
| Threat model | trusted seeds you choose | **untrusted, attacker-influenced URLs** |
| SSRF / DNS-rebinding | not addressed (wrong threat model) | **pinned egress by default** — resolve once, validate the IP, freeze it; no rebinding window |
| Cloud-metadata / internal targets | reachable | **hard-blocked** (169.254.169.254, `10.x`, loopback, link-local, NAT64…) |
| Re-processing | re-crawl (or ad-hoc HTTP cache) | **deterministic replay** — crawl once, re-extract offline forever |
| Downstream evidence | URL + timestamp | **per-page `sourceRef`** you can cite in a review UI |
| AI in the core | — | **none** — pure deterministic mechanics (fast, testable, no model calls) |

The crawling *mechanics* are commodity — `forage` leans on proven ideas and
focused libraries for those (robots parsing, URL canonicalization, sitemaps,
Crawlee's adaptive-render pattern). What it **owns** is the rare part: getting
SSRF-with-rebinding *actually right* (a pin, not just a check — the hole most
naive SSRF filters still have) and wiring provenance/replay for a human-review
workflow.

## Safe by default

SSRF protection is **opt-out, never opt-in.** You cannot accidentally ship a
`forage` crawl that will fetch your cloud metadata endpoint — refusing internal
targets is the default, and disabling it is an explicit, visible choice.

## Quick start

```ts
import { crawl } from "@kontourai/forage";

const manifest = await crawl(
  { url: "https://a-provider-you-dont-fully-trust.example/" },
  {
    maxPages: 8,
    maxDepth: 1,
    discovery: "links",
    render: "never",
    // egress is SSRF-pinned by default; robots + politeness honored by default
  },
);

for (const page of manifest.pages) {
  console.log(page.url, page.status, page.sourceRef); // cite page.sourceRef downstream
}
```

**Smoke-testing against a local fixture.** The default guarded egress policy
will reject a `localhost`/`127.0.0.1` URL on a nonstandard port — that's the
SSRF guard doing its job (`egress-denied: ... (INVALID_PORT)`), not a bug. For
local fixtures (a test server, a dev-time crawl target) opt a specific
loopback origin in explicitly, never in production:

```ts
const manifest = await crawl(
  { url: "http://127.0.0.1:4173/" },
  {
    maxPages: 1,
    egress: {
      guarded: true,
      // test-only escape hatch: exact loopback origins, never production hostnames.
      testOnlyAllowedLoopbackOrigins: ["http://127.0.0.1:4173"],
    },
  },
);
```

Consumers that process a cited snapshot offline can resolve the exact durable
reference without duplicating the provenance grammar or accepting a hash prefix.
The reference commits separately to the body bytes and to the canonical replay
metadata (status, headers, redirects, render state, and body representation):

```ts
import { resolveSnapshotSourceRef } from "@kontourai/forage/fetch";

const replay = await resolveSnapshotSourceRef(store, page.sourceRef);
if (!replay.ok) throw new Error(replay.error.message);
console.log(replay.snapshot.body);
```

Direct acquisitions can enforce a source-specific body ceiling across plain,
rendered, and validator-backed snapshots. Oversized declared lengths fail
early, while streamed and final snapshot checks remain authoritative when the
header is absent, incorrect, or replaced by rendered HTML:

```ts
const result = await fetchSource(source, { maxResponseBytes: 8 * 1024 * 1024 });
if (result.error?.kind === "response-too-large") throw new Error(result.error.message);
```

Envelope references are capped at 16 KiB after URL encoding; the builder throws
instead of emitting a reference the parser cannot consume. References emitted
by the released `0.3` grammar remain accepted through a bounded 1 MiB
compatibility lane and report `integrity: "body-and-identity"`; envelope
references report `integrity: "snapshot-envelope"`. Filesystem stores write a
bounded exact-identity index for both forms. Existing `0.3` filesystem captures
replay through their deterministic released filename; re-putting them builds the
stronger current index, but is not required to resolve an existing reference.
The current grammar is a backward-compatible extension that adds
`snapshotSha256`; durable replay bodies are capped at 64 MiB.

Filesystem stores cap each snapshot record at 96 MiB and each source history
at 10,000 JSON records. `put()` reserves capacity before creating a record and
rejects a new identity when no slot remains, so a successful write cannot make
later history reads fail. Applications with a lower retention ceiling can pass
`maxHistoryFiles` to `createFilesystemSnapshotStore()`; the accepted range is
1 through 10,000 and cannot change after a source store is initialized.
Capacity decisions use deterministic, exclusive filesystem slot reservations,
so cooperating store instances and processes cannot consume the same remaining
slot. A process interrupted after reservation can complete the same immutable
snapshot idempotently on retry. The store does not silently delete evidence.

## Guarded single-URL fetch (`@kontourai/forage/egress`)

The package root stays focused on `crawl()`; consumers that need the
SSRF/DNS-rebinding-safe egress guard for a **single URL** — without pulling in
the full crawl frontier — import it from the `./egress` subpath instead:

```ts
import { createGuardedFetch } from "@kontourai/forage/egress";

// A fetch-shaped function: resolve the hostname once, validate every DNS
// answer against the private/loopback/link-local/metadata deny-lists, connect
// to the one validated public IP (defeating DNS rebinding), and re-validate
// every redirect hop.
const guardedFetch = createGuardedFetch();
const response = await guardedFetch("https://a-provider-you-dont-fully-trust.example/");
```

Drop `createGuardedFetch()`'s return value into any `fetch`-shaped seam (e.g.
an `opts.fetch` injection point) to get the exact same pinned-egress
protection `crawl()` uses internally. It rejects a denied target by throwing
`EgressUrlPolicyError` (`err.code` is one of the `EgressPolicyErrorCode`
values — `DENIED_ADDRESS`, `INVALID_PORT`, `REDIRECT_CROSS_HOST`, etc.)
instead of ever making the disallowed request:

```ts
import { createGuardedFetch, EgressUrlPolicyError } from "@kontourai/forage/egress";

try {
  await createGuardedFetch()("http://127.0.0.1:4173/internal");
} catch (err) {
  if (err instanceof EgressUrlPolicyError) {
    console.error(err.code, err.message); // "INVALID_PORT", "Server egress rejected (INVALID_PORT) for 127.0.0.1"
  }
}
```

Lower-level building blocks are exported too, for callers that need to
classify or pre-check a target without issuing a request:

- **`evaluateEgressUrl(url, deps?)`** — resolves and validates a URL's
  hostname (DNS + address classification + host/port/scheme checks) without
  fetching it; returns `{ url, addresses }` or throws `EgressUrlPolicyError`.
  Accepts an injectable `resolver` (for tests) and the same
  `testOnlyAllowedLoopbackOrigins` escape hatch described below.
- **`classifyAddress(address, safeHost?)`** — classifies a single resolved IP
  literal against the deny-lists (private/loopback/link-local/metadata/NAT64
  ranges); throws `EgressUrlPolicyError` with code `DENIED_ADDRESS` /
  `INVALID_HOST` on a disallowed address.

For local fixtures, `createGuardedFetch`/`evaluateEgressUrl` accept the same
test-only `testOnlyAllowedLoopbackOrigins` escape hatch as `crawl()`'s
`egress` policy — see "Smoke-testing against a local fixture" above.

This is the same guard `lookout` uses in production for single-URL egress
outside a full crawl.

## MVP policy support

The current crawler implements `discovery: "links"`, `"sitemap"`, and `"both"`.
Sitemap discovery reads seed-host `Sitemap:` directives (falling back to
`/sitemap.xml`), supports bounded nested indexes and gzip files, and reports
`manifest.sitemap.documentsRead` plus `manifest.sitemap.urlsDiscovered`.
`render: "on-shell"` escalates empty JavaScript shells from plain HTTP to a
DNS-pinned browser, while `render: "always"` and `Seed.render: true` request a
browser for the matching pages. Rendering requires the optional `playwright`
peer; when it is absent or rendering fails, the plain-fetch snapshot is kept
with a warning. `shouldFollow` scoring and frontier concurrency remain
forward-compatible seams that warn and use the deterministic host/depth policy
and sequential frontier.

## Where it sits

The target shape is `campfit → traverse → forage`, with dependencies pointing
only downward so each layer is usable alone. **traverse has adopted forage**
today (its `/fetch` subpath composes forage's crawl + guarded egress);
**campfit's adoption is still pending** — it does not yet depend on forage and
still carries its own `lib/security/egress-url-policy.ts` /
`lib/ingestion/render-fetch.ts`.

- **forage** — crawling + safe egress + provenance. Knows nothing about extraction.
- **traverse** — schema-directed extraction (`content + schema → reviewable
  proposals`). Depends on forage for its fetch/compose convenience.
- **campfit** — the app: crawl with forage, extract with traverse, review
  (once it migrates off its own egress/render code onto forage).

See [DESIGN.md](./DESIGN.md) for the public surface, the SSRF/replay rationale,
and the migration sequence lifting the crawler out of `traverse/fetch` and,
eventually, the egress guard out of `campfit`.
