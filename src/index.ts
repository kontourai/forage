/**
 * forage — safe, replayable web crawling for review pipelines.
 *
 * A crawler for UNTRUSTED URLs: SSRF/DNS-rebinding-safe egress by default,
 * deterministic replay, and per-page provenance. Survey-neutral — knows nothing
 * about extraction. See README.md / DESIGN.md.
 *
 * The implementation is lifted from traverse/fetch + campfit's egress policy
 * (DESIGN.md "Migration").
 */
export type {
  Seed,
  CrawlPolicy,
  CrawlManifest,
  Page,
  Snapshot,
  ExactSnapshotLookupResult,
  ExactSnapshotStore,
  SnapshotLookup,
  SnapshotStore,
  EgressPolicy,
  DiscoveredLink,
  FrontierContext,
} from "./types.js";
export { InvalidCrawlConfigError } from "./types.js";
export { crawl } from "./crawl.js";
export {
  createFilesystemSnapshotStore,
  createInMemorySnapshotStore,
} from "./snapshot-store.js";
export type { FilesystemSnapshotStoreOptions } from "./snapshot-store.js";
export {
  createForageRenderImpl,
  installGuardedPageNetwork,
  preparePinnedBrowserNavigation,
} from "./render.js";
export type {
  BrowserInstance,
  BrowserLauncher,
  BrowserPage,
  CreateForageRenderImplOptions,
  PinnedBrowserNavigation,
} from "./render.js";
export type { RenderImpl, RenderResult } from "./internal-types.js";
