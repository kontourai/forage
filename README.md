# forage

**Safe, replayable web crawling for review pipelines — a crawler for _untrusted_ URLs.**

[![npm version](https://img.shields.io/npm/v/%40kontourai%2Fforage)](https://www.npmjs.com/package/@kontourai/forage)
[![CI](https://github.com/kontourai/forage/actions/workflows/ci.yml/badge.svg)](https://github.com/kontourai/forage/actions/workflows/ci.yml)
[![Docs](https://img.shields.io/badge/docs-kontourai.github.io-blue)](https://kontourai.github.io/forage/)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

[Documentation](https://kontourai.github.io/forage/)

`forage` acquires pages from **untrusted, attacker-influenced URLs** — an
aggregator's listings, links discovered mid-crawl, or user submissions — and
records snapshots that a downstream application can replay and cite in review.
It combines a crawl frontier, guarded network access, and snapshot provenance.

## Acquisition, replay, and provenance

| Capability | `forage` behavior and limits |
|---|---|
| Guarded egress | **On by default.** Resolve and validate the destination, pin the connection to a validated public IP, and revalidate redirect hops. Private, loopback, link-local, and cloud-metadata targets are denied under the default policy. |
| Crawl policy | Robots and politeness are honored by default; discovery supports links and sitemaps. The frontier currently runs sequentially. |
| Replay | With a snapshot store, `mode: "replay"` reads captured snapshots without fetching pages again. Replay requires retained snapshots; it does not refresh their content. |
| Citable snapshots | Each captured page has a `sourceRef`; exact-reference resolution checks the stored snapshot's identity and integrity. A reference identifies captured content, not the truth of a claim made from it. |
| Rendering | Optional Playwright rendering handles JavaScript shells through pinned browser egress. Missing or failed rendering keeps the plain-fetch snapshot with a warning. |
| Model calls | None in the acquisition core. Extraction and review belong to downstream consumers. |

These are Forage's contracts, not a comparison of other crawlers' security or
replay support. Choose crawl and retention policies for your application;
Forage does not perform extraction checks or decide whether a proposed fact is
correct. See [MVP policy support](#mvp-policy-support) for current crawl limits
and [DESIGN.md](./DESIGN.md) for the egress and replay design.

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

### Text bodies: bytes, charset, and hash basis

A textual response keeps the exact bytes received (`snapshot.bytes`) and the
lower-cased `charset` its `Content-Type` declared (`snapshot.declaredCharset`,
or `null`). `bodyHash` is SHA-256 of those bytes, so two responses that differ
in any byte never share a hash. `snapshot.body` is the text decoded from the
bytes with the declared charset (UTF-8 when none is declared), through the
exported `decodeTextBody()`:

- an unknown charset label falls back to UTF-8 and adds a fetch warning;
- bytes invalid in the chosen encoding become U+FFFD and add a fetch warning;
- a leading byte-order mark that matches the chosen encoding is left out of
  `body` but kept in `bytes`, and never overrides the declared charset.

Filesystem records store the bytes and the charset, not the text, and
re-derive `body` on every read, so replay returns the fetched bytes exactly.

**Migration.** Text snapshots written by earlier releases hashed the UTF-8
encoding of text that was always decoded as UTF-8. Those records still load,
and their references still resolve; `snapshotHashBasis(snapshot)` reports
`"decoded-utf8"` for them and `"bytes"` for new captures (and for binary
bodies, which were always hashed as bytes). Rendered snapshots have no wire
bytes and keep the `"decoded-utf8"` basis. Because the reference envelope of a
byte-hashed text snapshot also commits to its charset, every new text capture
has a different `snapshotSha256` than an earlier-format capture of the same
response. Its `bodyHash` also differs when the bytes are not plain UTF-8: a
non-UTF-8 charset, a byte-order mark, or invalid UTF-8. A consumer that compares
`bodyHash` across the upgrade sees at most one spurious change per such source.

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
snapshot idempotently on retry. At the ceiling, `put()` rejects with
`SnapshotHistoryFullError` (`code: "history-full"`).

The store deletes nothing on its own. `prune(sourceId, { keepLast, keep })`
applies an explicit retention rule: it keeps the newest `keepLast` snapshots,
every snapshot matching a `keep` reference (for example, every snapshot the
caller still cites), and always the head, even for `keepLast: 0`. It removes
the other records with their identity-index entries and capacity slots, so a
pruned store verifies cleanly and `put()` succeeds again after pruning a full
store. The in-memory store implements the same rule.

Every `put()` and `prune()` of one source holds a per-source write lock,
`source.lock` in the source directory, for its critical section; readers never
take it. **Every process that writes to a store must run a forage version that
takes this lock.** A prune removes temporary files and capacity slots that name
no record, so an older, unlocked writer that is still running can lose data.

The lock records its owner's machine identity (the hostname, plus on Linux the
boot id and pid namespace), pid, and process start time, and the owner
refreshes its mtime every 10 seconds. Another process breaks the lock when it
has not been refreshed for 60 seconds, or when the owner has the same machine
identity and its pid has exited or now belongs to a process that started at a
different time. A lock from another machine or pid namespace, or one whose
identity cannot be read, is judged by age alone. A writer waits up to 90
seconds for the lock, then fails with `snapshot-store-error` (reason
`store-busy`). The limits of this scheme (a blocked event loop, clock skew
between machines, lock-free readers) are listed in `src/source-lock.ts`.

Because no write is in flight while a prune holds the lock, each prune first
removes everything an interrupted write can leave: temporary files, capacity
slots and identity entries that name no record, and markers of lock breakers
that died. It also gives a retained record back a missing identity entry or
capacity slot.

`latest()` picks the head from record filenames and reads only the head's
record, so its cost does not grow with history length. It does so when every
record filename carries an ISO-8601 UTC `fetchedAt`, which is what
`fetchSource()` produces; otherwise it reads the whole history as `list()`
does. To keep those filenames unambiguous, `put()` rejects a `fetchedAt` that
looks like ISO-8601 but uses other separators.

Filesystem reads are fail-closed. If an owned snapshot record is malformed,
has a digest mismatch, or belongs to a different source, `list` and `get`
reject with `SnapshotStoreReadError` whose safe `code` is
`"snapshot-corrupt"`; storage/race failures use `"snapshot-store-error"`.
`latest` verifies the record(s) it reads the same way and rejects when the head
is corrupt; it does not read, and so does not report, older records.
They never silently substitute a partial history or an empty baseline. Exact
reference resolution and replay return the same distinction through their
typed result errors (`snapshot-corrupt` versus `snapshot-store-error`) without
exposing filesystem paths or raw record contents.

### Verified source-head witnesses

The concrete filesystem store also offers an additive, opt-in head witness;
plain `SnapshotStore` implementations remain compatible. `readVerifiedHead()`
performs one fenced operation: it fingerprints the bounded immutable record,
capacity-index, and identity-index namespaces; authenticates the normal latest
snapshot record; then fingerprints the same namespace again. A successful
result contains an exact head reference and an opaque
`forage.source-head-witness/v1` token. `compareHeadWitness()` only reads that
metadata and reports `matches`, `changed`, `missing`, `unavailable`, `corrupt`,
or `unsupported`; it never reads a snapshot body and never guesses a new head.

The default ceilings are the store's 10,000-record history bound, 8 MiB of
index bytes, and 96 MiB of aggregate authenticated record bytes. Callers may
only lower them with `maxEntries`, `maxIndexBytes`, and
`maxVerifiedBodyBytes`; a limit refusal is explicit rather than a partial
witness. Incomplete released/legacy metadata is `unsupported`, and temporary,
reservation, orphan, or unindexed state is refused.

The token is stable across an unchanged restart but is deliberately local to
the physical store, so a copy or restore can invalidate it. It attests to the
metadata and to body authentication at capture time; it is not a silent-bitrot
detector or a proof against an attacker who can rewrite every authority.

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

## Development

```bash
pnpm install
npm run verify
```

The pnpm version is pinned in `package.json` (`packageManager`). Dependency
install scripts are blocked by default; the only packages allowed to run one are
listed under `allowBuilds` in `pnpm-workspace.yaml`, pinned by version. Scripts
are still run with `npm run …` — that only invokes `package.json` scripts and
does not depend on which tool installed `node_modules`.
