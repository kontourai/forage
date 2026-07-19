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
at 10,000 JSON records. `put()` rejects and removes a newly created record that
would exceed that bound, so a successful write cannot make later history reads
fail. Applications with a lower retention ceiling can pass
`maxHistoryFiles` to `createFilesystemSnapshotStore()`; the accepted range is
1 through 10,000. The store does not silently delete evidence.

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

`campfit → traverse → forage`. Dependencies point only downward; each layer is
usable alone:

- **forage** — crawling + safe egress + provenance. Knows nothing about extraction.
- **traverse** — schema-directed extraction (`content + schema → reviewable
  proposals`). Depends on forage for its fetch/compose convenience.
- **campfit** — the app: crawl with forage, extract with traverse, review.

See [DESIGN.md](./DESIGN.md) for the public surface, the SSRF/replay rationale,
and the migration lifting the crawler out of `traverse/fetch` + the egress guard
out of `campfit`.
