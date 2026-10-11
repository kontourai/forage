# Troubleshooting

`crawl()` reports problems as strings in `manifest.warnings` (and per page in
`page.warnings`). A page-level failure reads
`[depth N] <url>: <kind>: <message>`, where `<kind>` is a
[fetch error kind](reference.md#fetcherrorkind). `fetchSource()` returns the
same kinds in `result.error.kind`, except the replay-only `no-snapshot`,
`snapshot-corrupt`, and `snapshot-store-error`.

## A crawl returns no pages

Read `manifest.warnings` for the `[depth 0] <seed>:` line that names an error
kind. Fail-open robots.txt warnings and sitemap warnings can come before it.
The usual causes:

- **`egress-denied`**: the guard refused the seed. The message names the code,
  for example `Server egress rejected (DENIED_ADDRESS) for internal.example`.
  See [Egress denied](#egress-denied).
- **`robots-denied`**: robots.txt disallows the seed path for your user agent's
  product token, the part of `userAgent` before the first space or `/`.
- **`http-error`**: the seed answered with a non-2xx status.
- **`no-snapshot`**: in `mode: "replay"`, the store has nothing for this page.
  Replay ids are built from the seed URL, so replay with the exact seed URL
  you crawled.

## Egress denied

| Code in the message | What to check |
| --- | --- |
| `INVALID_PORT` | The URL has a port other than 80 or 443. For a local test server, add its exact origin to `egress.testOnlyAllowedLoopbackOrigins`. |
| `DENIED_ADDRESS` | The hostname resolves to a private, loopback, link-local, or other non-public address. Every DNS answer must be public, not just one. |
| `DENIED_HOST` | The hostname is `localhost`, ends in `.localhost`, or is a cloud metadata name. |
| `INVALID_HOST` | The host is a non-canonical number such as `0x7f.1` or `017.0.0.1`. Use the dotted-decimal address. |
| `CREDENTIALS` | The URL contains `user:password@`. |
| `DNS_FAILURE` | The hostname did not resolve. |

`testOnlyAllowedLoopbackOrigins` entries must be exact origins such as
`http://127.0.0.1:4173`: `http:`, an explicit port, and a host of `127.0.0.1`
or `[::1]`. In `crawl()`, anything else, including `localhost`, is an
`InvalidCrawlConfigError`; `fetchSource()` returns it as a `network` error.
`egress: { guarded: false }` turns the guard off for plain HTTP requests
(rendering stays guarded); do not use it for URLs you do not control.

## A redirect is refused

`fetchSource()` follows redirects itself. It refuses one to another host, or
from `https:` to `http:`, with a `network` error such as
`redirect rejected: cross-host target other.example`. More than 5 hops is
`too-many-redirects`. These limits are fixed.

## The manifest is truncated

`truncated: true` and the warning
`maxPages cap (N) reached; M further URL(s) discovered but not fetched` mean
the frontier still had URLs. `maxPages` counts every attempt, including
failures, and is capped at 500. Raise `maxPages`, lower `maxDepth`, or use
`discovery: "sitemap"` to reach listing pages directly.

## Policy fields that only warn

These warnings mean the field was accepted but not acted on:

- `shouldFollow scoring is deferred in this MVP; the deterministic host/depth policy was used`
- `politeness.concurrency is deferred in this MVP; the frontier ran sequentially`

## Rendering does not happen

`render failed; kept plain-fetch snapshot (...)` means the plain snapshot was
used. When the cause is
`render unavailable: optional peer dependency 'playwright' is not installed`,
install `playwright` and its Chromium browser. With `render: "on-shell"`, a
page is rendered only if it is HTML and looks like a JavaScript shell; a page
with real text content is not rendered. Use `render: "always"` to force it.

`render: networkidle fallback used after Nms` means the page never went quiet
on the network, so forage captured it at `domcontentloaded` instead.

## robots.txt warnings

`robots.txt for <origin> unreachable (...); proceeding (fail-open)`, and the
matching `proceeding (fail-open)` warnings for a 429, a 5xx, or a robots.txt
over 256 KiB, mean forage could not read the rules and crawled as if none
existed. A 4xx robots.txt is treated
as allow-all without a warning.

## Snapshot store errors

| Symptom | Meaning |
| --- | --- |
| `SnapshotHistoryFullError` (`code: "history-full"`) from `put()` | The source holds `maxHistoryFiles` records. Call `store.prune(sourceId, { keepLast, keep })` to free capacity. In a crawl, this shows as a `store.put failed (...)` warning and the page stays in memory. |
| `SnapshotStoreReadError` with code `snapshot-corrupt` | A record is malformed, fails its digest, or belongs to another source. Reads fail rather than return a partial history. |
| `SnapshotStoreReadError` with reason `store-busy` | Another writer held `source.lock` for more than 90 seconds. |
| `maxHistoryFiles cannot change after filesystem store initialization` | The source directory was created with a different `maxHistoryFiles`. |

## A citation does not resolve

`resolveSnapshotSourceRef()` reports why in `error.kind`:

| Kind | Meaning |
| --- | --- |
| `invalid-reference` | The string is not a canonical `forage-snapshot:` reference. Hash prefixes are not accepted. |
| `snapshot-not-found` | The store has no snapshot with that identity, for example after a `prune()` that did not keep it. |
| `snapshot-mismatch` | A stored snapshot has that identity but different bytes or metadata. |
| `snapshot-corrupt`, `snapshot-store-error` | The store could not produce a trustworthy record, or does not implement `findExact`. |

A text capture made by 1.0.0 or later has a different `sourceRef`, and
possibly a different `bodyHash`, than an earlier-format capture of the same
response. Older references still resolve against the records they were made
from.
