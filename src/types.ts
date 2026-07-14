/**
 * forage public types — the survey-neutral crawler contract.
 *
 * These are the STABLE surface consumers depend on. Implementations (frontier,
 * fetch, SSRF-pinned egress, snapshot store) are lifted from traverse/fetch +
 * campfit's egress policy in the migration (see DESIGN.md) — the types here are
 * the target they conform to.
 */

/** A durable, byte-identical record of one fetched page (for replay + provenance). */
export interface Snapshot {
  url: string;
  status: number;
  fetchedAt: string;
  body: string | Uint8Array;
  headers?: Record<string, string>;
  bodyHash: string;
  rendered?: boolean;
}

/** Persist/replay snapshots. A filesystem and an object-store impl both satisfy this. */
export interface SnapshotStore {
  put(snapshot: Snapshot): Promise<void>;
  latest(sourceId: string): Promise<Snapshot | undefined>;
  get(sourceId: string, bodyHash: string): Promise<Snapshot | undefined>;
  list(sourceId: string): Promise<Snapshot[]>;
}

/** SSRF egress policy. Default construction is guarded (pin-on); opting out is explicit. */
export interface EgressPolicy {
  /** deny classification for a resolved address family (private/loopback/link-local/metadata/NAT64…). */
  guarded: boolean;
  /** test-only escape hatch for loopback origins; never for production hostnames. */
  testOnlyAllowedLoopbackOrigins?: readonly string[];
}

export interface Seed {
  url: string;
  render?: boolean;
  headers?: Record<string, string>;
  userAgent?: string;
}

export interface DiscoveredLink {
  url: string;
  depth: number;
  fromUrl: string;
}

export interface FrontierContext {
  seedHost: string;
  visited: number;
}

export interface CrawlPolicy {
  maxPages?: number;
  maxDepth?: number;
  sameHost?: boolean;
  discovery?: "links" | "sitemap" | "both";
  render?: "never" | "on-shell" | "always";
  politeness?: { delayMs?: number; concurrency?: number };
  robots?: boolean;
  egress?: EgressPolicy;
  mode?: "live" | "replay";
  store?: SnapshotStore;
  /** Optional frontier scorer — a seam a consumer may fill. forage core ships no AI. */
  shouldFollow?: (link: DiscoveredLink, ctx: FrontierContext) => boolean | number;
}

export interface Page {
  url: string;
  status: number;
  body: string | Uint8Array;
  snapshot: Snapshot;
  /** durable, citable pointer to the exact snapshot this page came from. */
  sourceRef: string;
  depth: number;
  rendered: boolean;
  warnings: string[];
}

export interface CrawlManifest {
  seed: string;
  pages: Page[];
  /** true when the frontier still held undiscovered URLs when maxPages stopped it. */
  truncated: boolean;
  warnings: string[];
}
