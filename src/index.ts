/**
 * forage — safe, replayable web crawling for review pipelines.
 *
 * A crawler for UNTRUSTED URLs: SSRF/DNS-rebinding-safe egress by default,
 * deterministic replay, and per-page provenance. Survey-neutral — knows nothing
 * about extraction. See README.md / DESIGN.md.
 *
 * This index exports the stable public surface. The implementation is being
 * lifted from traverse/fetch + campfit's egress policy (DESIGN.md "Migration");
 * `crawl` throws `not-implemented` until that lands so the contract is importable
 * and typecheckable now.
 */
export type {
  Seed,
  CrawlPolicy,
  CrawlManifest,
  Page,
  Snapshot,
  SnapshotStore,
  EgressPolicy,
  DiscoveredLink,
  FrontierContext,
} from "./types.js";

import type { Seed, CrawlPolicy, CrawlManifest } from "./types.js";

/**
 * Crawl a seed under a policy, returning a bounded, provenance-bearing page set.
 * SSRF-pinned egress and robots/politeness are ON by default.
 *
 * NOT YET IMPLEMENTED — see DESIGN.md. The signature is stable; the frontier +
 * pinned-egress + snapshot implementation lands in the migration.
 */
export async function crawl(
  _seed: Seed,
  _policy: CrawlPolicy = {},
): Promise<CrawlManifest> {
  throw new Error(
    "forage: crawl() is not yet implemented — migration in progress (see DESIGN.md).",
  );
}
