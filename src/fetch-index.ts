/**
 * `@kontourai/forage/fetch` — the single-page fetch + conditional-revalidation
 * surface, exported for consumers that need drop-in `fetchSource()` semantics
 * without the full crawl frontier (e.g. `@kontourai/lookout`'s drift checks,
 * kontourai/lookout#11).
 *
 * Mirrors traverse's `./fetch` subpath contract exactly — `fetchSource`,
 * `SourceConfig` / `FetchResult` / `FetchError` / `FetchLike` /
 * `FetchSourceOptions`, and `buildSnapshotSourceRef` / `parseSnapshotSourceRef`
 * — so a caller can re-point from `@kontourai/traverse/fetch` to
 * `@kontourai/forage/fetch` with the same import names. See
 * `src/fetch-source.ts` for the validator-scoped conditional-304 implementation
 * (traverse#49 hardening) and `Snapshot.notModified` for the transient
 * revalidation marker this surface returns.
 *
 * This mirrors the `./egress` subpath discipline (see `egress-index.ts`):
 * the package root (`@kontourai/forage`) stays focused on `crawl()`; this
 * subpath is an explicit opt-in to the lower-level single-page primitive.
 *
 * The fetch contract types are the curated public subset of the shared
 * implementation module `internal-types.ts`; re-exporting the named subset
 * here (rather than through a separate facade module) keeps this barrel the
 * single public surface without widening `internal-types.ts`'s own visibility
 * — the same discipline `egress-index.ts` applies to `types.ts`.
 */

export { fetchSource } from "./fetch-source.js";
export type {
  FetchError,
  FetchErrorKind,
  FetchLike,
  FetchResult,
  FetchSourceOptions,
  SourceConfig,
} from "./internal-types.js";
export {
  buildSnapshotSourceRef,
  parseSnapshotSourceRef,
  resolveSnapshotSourceRef,
} from "./provenance.js";
export type {
  ParsedSnapshotSourceRef,
  SnapshotSourceRefResolution,
} from "./provenance.js";
export type { Snapshot, SnapshotStore } from "./types.js";
