# Reference

The public surface of `@kontourai/forage` 1.x. The package has three entry
points, defined by `exports` in `package.json`, and no CLI.

| Import | Purpose |
| --- | --- |
| `@kontourai/forage` | `crawl()`, snapshot stores, text decoding, and the pinned browser renderer. |
| `@kontourai/forage/egress` | The SSRF and DNS-rebinding guard for single requests. |
| `@kontourai/forage/fetch` | `fetchSource()` and the provenance reference helpers. |

## `@kontourai/forage`

### crawl()

```ts
crawl(seed: Seed, policy?: CrawlPolicy): Promise<CrawlManifest>
```

Throws only `InvalidCrawlConfigError` (a `TypeError`). Everything else is
reported in `CrawlManifest.warnings`.

#### Seed

| Field | Type | Meaning |
| --- | --- | --- |
| `url` | `string` | Required. An absolute `http:` or `https:` URL. Its fragment is dropped. |
| `render` | `boolean` | Render the seed page (depth 0) in a browser. Other pages follow `policy.render`. |
| `headers` | `Record<string, string>` | Extra request headers. Sent only to URLs on the seed's origin. |
| `userAgent` | `string` | The `User-Agent` for plain requests and robots.txt matching. The browser renderer always sends forage's own user agent and does not use `userAgent` or `headers`. The default is `kontourai-forage-bot/0.x (...)` with a placeholder contact, so set your own. |

#### CrawlPolicy

| Field | Default | Meaning |
| --- | --- | --- |
| `maxPages` | `20` | Maximum acquisition attempts, failed ones included. Capped at 500 and rounded down. |
| `maxDepth` | `2` | Maximum link depth; the seed is depth 0. Capped at 10 and rounded down. |
| `sameHost` | `true` | Queue only links on the seed's origin. Sitemap page URLs are always limited to the seed's host, whatever this is set to. |
| `discovery` | `"links"` | `"links"` follows `<a href>`, `"sitemap"` reads sitemaps and follows no links, `"both"` does both. |
| `render` | `"never"` | `"on-shell"` renders pages that look like a JavaScript shell; `"always"` renders every page. |
| `politeness.delayMs` | `1000` | Minimum time between requests to one origin. |
| `politeness.concurrency` | `1` | Accepted, but the frontier is sequential. Any other value adds a warning. Must be at least 1. |
| `robots` | `true` | Honor robots.txt. |
| `egress` | `{ guarded: true }` | See [EgressPolicy](#egresspolicy). |
| `mode` | `"live"` | `"replay"` serves every page from `store` with no network. Requires `store`. |
| `store` | none | A `SnapshotStore`. In live mode every acquired page is put into it, and so are the robots.txt and sitemap documents that sitemap discovery reads. |
| `shouldFollow` | none | Accepted, but not used yet. Setting it adds a warning. |

Numbers must be finite and non-negative. Sitemap discovery runs only when
`maxPages` is above 1 and `maxDepth` is at least 1, and accepts at most
`maxPages` page URLs. `crawl()` has no response-size option.

#### CrawlManifest and Page

`CrawlManifest` has `seed` (the normalized seed URL), `pages`, `truncated`
(true when URLs were still queued at the `maxPages` cap), `warnings`, and,
when `discovery` is `"sitemap"` or `"both"`, `sitemap: { documentsRead, urlsDiscovered }`
(zeros when discovery was skipped).

Each `Page` has `url` (after redirects), `status`, `body`, `snapshot`,
`sourceRef`, `depth`, `rendered`, and its own `warnings`.

#### EgressPolicy

| Field | Meaning |
| --- | --- |
| `guarded` | `true` routes every plain HTTP request through the guard. `false` uses `globalThis.fetch` with no SSRF protection for those requests. Browser rendering is always guarded. |
| `testOnlyAllowedLoopbackOrigins` | Exact `http://127.0.0.1:<port>` or `http://[::1]:<port>` origins the guard may reach, for local test servers. |

### Snapshot stores

```ts
createInMemorySnapshotStore(): ExactSnapshotStore & PrunableSnapshotStore
createFilesystemSnapshotStore(options: {
  root: string;
  maxHistoryFiles?: number; // 1 to 10,000; default 10,000
}): VerifiedHeadSnapshotStore & PrunableSnapshotStore
```

The `SnapshotStore` interface:

| Method | Meaning |
| --- | --- |
| `put(snapshot)` | Store one snapshot. |
| `latest(sourceId)` | The newest snapshot of a source, or `undefined`. |
| `get(sourceId, bodyHash)` | The newest snapshot whose body hash equals, or starts with, `bodyHash` (both built-in stores accept a prefix), or `undefined`. For an exact citation, use `findExact` or `resolveSnapshotSourceRef`. |
| `list(sourceId)` | Every snapshot of a source. |
| `findExact(lookup)` | Optional. Full-identity lookup: `{ kind: "found", snapshot }`, `{ kind: "missing" }`, or `{ kind: "mismatch" }`. |
| `prune(sourceId, { keepLast, keep? })` | Optional. Remove all but the newest `keepLast` snapshots and those matching a `keep` reference. The head is always kept. Returns `{ removed, retained }`. |

Filesystem store limits and behaviour:

- At most `maxHistoryFiles` records per source. At the cap, `put()` rejects
  with `SnapshotHistoryFullError` (`code: "history-full"`) until you `prune()`.
  `maxHistoryFiles` cannot change after a source directory is initialized.
- Each record is at most 96 MiB, and a durable body at most 64 MiB.
- Reads are fail-closed. A malformed, mismatched, or foreign record makes
  `list`, `get`, and `latest` reject with `SnapshotStoreReadError`, whose
  `code` is `"snapshot-corrupt"`, or `"snapshot-store-error"` for storage and
  race failures. `reason` gives the detail, such as `"malformed-record"` or
  `"store-busy"`.
- `put()` and `prune()` take a per-source lock file, `source.lock`. A writer
  waits up to 90 seconds for it, then fails with reason `store-busy`. Every
  process writing to one store must run a forage version that takes this lock.

`isSnapshotStoreReadError()` and `isSnapshotHistoryFullError()` are type
guards for the two error classes.

#### Verified source-head witnesses

Only the filesystem store has these two methods:

```ts
readVerifiedHead(sourceId, limits?): Promise<ReadVerifiedHeadResult>
compareHeadWitness(witness, limits?): Promise<HeadWitnessComparisonResult>
```

`readVerifiedHead` fingerprints the source's record and index files,
authenticates the latest record, and fingerprints them again. On success it
returns `{ kind: "found", headSnapshotRef, witness }`, where `witness` is a
`forage.source-head-witness/v1` object with an opaque `token`. Otherwise it
returns `missing`, `unavailable`, `corrupt`, or `unsupported`.

`compareHeadWitness` reads only metadata and returns `matches`, `changed`,
`missing`, `unavailable`, `corrupt`, or `unsupported`. A `changed` result does
not name the new head.

`limits` can only lower the defaults: `maxEntries` (the store's
`maxHistoryFiles`), `maxIndexBytes` (8 MiB), and `maxVerifiedBodyBytes`
(96 MiB). The token is local to the physical store, so a copy or restore can
invalidate it.

### Text bodies

| Export | Meaning |
| --- | --- |
| `parseDeclaredCharset(contentType)` | The lower-cased `charset` parameter, or `null`, with warnings for a malformed value. |
| `decodeTextBody(bytes, charset)` | `{ text, encoding, warnings }`. An unknown charset falls back to UTF-8; invalid bytes become U+FFFD; a matching byte-order mark is dropped from `text`. |
| `snapshotHashBasis(snapshot)` | `"bytes"` or `"decoded-utf8"`: what `bodyHash` was computed over. |

### Rendering

`crawl()` and `fetchSource()` load the renderer on their own when rendering is
requested. These exports are for callers that drive a browser themselves:

| Export | Meaning |
| --- | --- |
| `createForageRenderImpl(options?)` | A `RenderImpl` that launches a dedicated headless Chromium per call through the optional `playwright` peer. Options: `timeoutMs` (default 30,000), `resolver`, `testOnlyAllowedLoopbackOrigins`. |
| `preparePinnedBrowserNavigation(url, resolver?, origins?)` | Resolve a URL through the guard and return the pinned IP and a Chromium `--host-resolver-rules` value. |
| `installGuardedPageNetwork(page, pinned, origins?)` | Install a route handler that aborts every request to another hostname, and every `https:` to `http:` redirect. |

## `@kontourai/forage/egress`

```ts
createGuardedFetch(options?: {
  resolver?: EgressResolver;
  testOnlyAllowedLoopbackOrigins?: readonly string[];
  maxRedirects?: number; // default 5
}): typeof fetch
```

A `fetch`-shaped function. For each request and each redirect hop it validates
the URL, resolves the hostname once, requires every answer to be a public
address, and connects to the first validated IP while keeping the hostname for
`Host` and TLS SNI. With the default `redirect: "follow"` it follows redirects
itself and refuses a redirect to another origin or from `https:` to `http:`.
With `redirect: "manual"` it returns the redirect response.

`evaluateEgressUrl(url, deps?)` runs the same checks without a request and
returns `{ url, addresses }`. `classifyAddress(address, safeHost?)` checks one
IP literal and returns `{ address, family }`. All three throw
`EgressUrlPolicyError` with one of these `code` values:

| Code | Cause |
| --- | --- |
| `INVALID_URL` | The URL does not parse. |
| `INVALID_SCHEME` | Not `http:` or `https:`. |
| `CREDENTIALS` | The URL has a user name or password. |
| `INVALID_HOST` | A non-canonical numeric host such as `0x7f.1`, or an address that does not parse. |
| `DENIED_HOST` | `localhost`, `*.localhost`, or a metadata hostname such as `metadata.google.internal`. |
| `INVALID_PORT` | A port other than 80 for `http:` or 443 for `https:`, unless the origin is in `testOnlyAllowedLoopbackOrigins`. |
| `DNS_FAILURE` | The lookup failed or returned no answers. |
| `DENIED_ADDRESS` | An answer is private, loopback, link-local, metadata, carrier-grade NAT, multicast, documentation, reserved, or an IPv6 form embedding such an IPv4 address. |
| `REDIRECT_INVALID`, `REDIRECT_LIMIT`, `REDIRECT_LOOP` | A bad `Location`, more than `maxRedirects` hops, or a revisited URL. |
| `REDIRECT_CROSS_HOST`, `REDIRECT_DOWNGRADE` | A redirect to another origin, or from `https:` to `http:`. |
| `CONNECT_FAILED` | The connection to the validated address failed. |

## `@kontourai/forage/fetch`

### fetchSource()

```ts
fetchSource(config: SourceConfig, options?: FetchSourceOptions): Promise<FetchResult>
```

Returns `{ snapshot?, error?, warnings? }` and never throws for an operational
failure. It reads `options.store` but never writes to it.

#### SourceConfig

| Field | Default | Meaning |
| --- | --- | --- |
| `id` | required | The `sourceId` of the snapshot, and the key for revalidation. |
| `url` | required | An `http:` or `https:` URL. |
| `egress` | required | An [EgressPolicy](#egresspolicy). |
| `minDelayMs` | `1000` | Minimum time between requests to one origin. |
| `timeoutMs` | `15000` | Per-request timeout. The renderer gets the same value per navigation attempt, not its own 30 s default; a render that falls back from `networkidle` to `domcontentloaded` can take up to twice this. |
| `retries` | `2` | Retries for timeouts, network errors, 429, and 5xx. Capped at 5. |
| `headers` | none | Extra request headers. |
| `userAgent` | forage default | The `User-Agent` header. |
| `respectRobots` | `true` | Check robots.txt. Unreachable, 429, and 5xx robots.txt responses are treated as allow-all, with a warning. Rules match by plain path prefix; `*` and `$` wildcards are not supported. |
| `render` | `false` | `true` always renders; `"on-shell"` renders a JavaScript shell. |
| `revalidate` | `true` | Send `If-None-Match` and `If-Modified-Since` from the source's latest stored snapshot (read from `options.store`), when its URL is the one being requested. Set `false` when you need a body every time. |

#### FetchSourceOptions

| Field | Meaning |
| --- | --- |
| `fetch` | A `FetchLike` to use instead of the guard. |
| `store` | A `SnapshotStore` read for revalidation. |
| `maxResponseBytes` | A positive integer ceiling on the body kept. A larger declared `Content-Length` fails early. Otherwise the body is checked as it is read, but the guard downloads the whole response before returning it, so with the guard this limits what is kept, not what is downloaded. Rendered HTML over the limit falls back to the plain snapshot with a warning. |
| `renderImpl` | A `RenderImpl` to use instead of loading `playwright`. |
| `now`, `clock`, `sleep`, `random`, `schedule` | Injectable time and randomness, for tests. |
| `politenessState`, `robotsCache` | Maps that share politeness timing and robots.txt rules across calls. They default to process-wide maps. |

#### FetchErrorKind

| Kind | Cause |
| --- | --- |
| `invalid-config` | Missing `id`, or an invalid `maxResponseBytes`. |
| `invalid-url` | The URL is invalid or not HTTP, or a redirect `Location` does not parse. |
| `robots-denied` | robots.txt disallows the path for your user agent's product token. |
| `timeout` | The request did not finish within `timeoutMs`, after retries. |
| `network` | A transport failure, or a redirect to another host or from `https:` to `http:`. |
| `egress-denied` | The guard refused the target. The message carries the `EgressPolicyErrorCode`. |
| `http-error` | A non-2xx status (with `status` set), a redirect without `Location`, or an unexpected 304. |
| `response-too-large` | The body exceeded `maxResponseBytes`. |
| `too-many-redirects` | More than 5 redirects. |
| `no-snapshot` | Replay found no stored snapshot for the source. |
| `snapshot-corrupt`, `snapshot-store-error` | Replay could not read a trustworthy snapshot. |

### Provenance references

| Export | Meaning |
| --- | --- |
| `buildSnapshotSourceRef(snapshot)` | The `forage-snapshot:` reference for a snapshot. Throws if it would exceed 16 KiB. |
| `parseSnapshotSourceRef(ref)` | `{ sourceId, url, bodyHash, fetchedAt, snapshotDigest? }`, or `undefined` for anything that is not a reference. |
| `resolveSnapshotSourceRef(store, ref)` | Look the reference up with `store.findExact` and verify it. |

`resolveSnapshotSourceRef` returns `{ ok: true, reference, snapshot, integrity }`,
where `integrity` is `"snapshot-envelope"` for current references and
`"body-and-identity"` for references from the 0.3 grammar (no
`snapshotSha256`). On failure it returns `{ ok: false, error }` with
`error.kind` one of `invalid-reference`, `snapshot-not-found`,
`snapshot-mismatch`, `snapshot-corrupt`, or `snapshot-store-error`. A store
without `findExact` gives `snapshot-store-error`.

The subpath also re-exports `decodeTextBody`, `parseDeclaredCharset`,
`snapshotHashBasis`, the snapshot and store types, and the store error classes.

## Fixed limits

| Limit | Value |
| --- | --- |
| Pages per crawl | 500 |
| Crawl depth | 10 |
| Redirects per fetch | 5 |
| Retries per request | 5 |
| robots.txt size | 256 KiB |
| Sitemap documents per crawl | 50 |
| Sitemap index nesting | 3 levels |
| Sitemap size, compressed or not | 5 MiB |
| Reference length | 16 KiB (1 MiB for 0.3 references) |
| Durable body | 64 MiB |
| Filesystem record | 96 MiB |
| Records per source | 10,000 |
