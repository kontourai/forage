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
  /** Stable crawl-owned identity used to group captures in a SnapshotStore. */
  sourceId: string;
  url: string;
  status: number;
  fetchedAt: string;
  /**
   * Binary responses: the raw bytes. Textual responses: the text decoded from
   * `bytes` with `declaredCharset` (see `decodeTextBody`).
   */
  body: string | Uint8Array;
  /**
   * The exact bytes of a textual response, as received. Present exactly when
   * `declaredCharset` is. When present, `bodyHash` is SHA-256 of these bytes
   * and `body` is derived from them.
   *
   * Absent on binary snapshots (where `body` is the bytes), on rendered
   * snapshots (a serialized DOM has no wire bytes), and on text snapshots
   * in the earlier record format, whose `bodyHash` was taken over the UTF-8
   * encoding of the decoded text. `snapshotHashBasis` reports which applies.
   */
  bytes?: Uint8Array;
  /** Lower-cased `charset` parameter of `Content-Type`, or `null` when none was declared. */
  declaredCharset?: string | null;
  headers?: Record<string, string>;
  bodyHash: string;
  /** Ordered URLs visited before `url`, when a same-host redirect occurred. */
  redirects?: string[];
  rendered?: boolean;
  /**
   * True ONLY on the snapshot RETURNED when a conditional GET (validators
   * drawn from a matching prior snapshot in a `SnapshotStore`) produced a
   * `304 Not Modified` — i.e. this is the byte-identical PRIOR snapshot,
   * re-served without a body transfer because the resource is unchanged. A
   * normal live fetch (200, or a validator-free re-fetch) never sets this.
   * PRESENCE (never explicit `false`) is the marker — same convention as
   * `rendered`. TRANSIENT: `fetchSource` only READS a `SnapshotStore` (via
   * `latest()`), it never writes one, so this flag is never persisted by
   * `fetchSource` itself and can never corrupt a later revalidation
   * comparison (which reads `headers` etag/last-modified, not this field).
   * Matches traverse's `Snapshot.notModified` contract (traverse/src/fetch/types.ts).
   */
  notModified?: boolean;
}

/**
 * What `bodyHash` was computed over.
 *
 * - `"bytes"`: the exact bytes received (binary bodies, and text bodies that
 *   carry `Snapshot.bytes`).
 * - `"decoded-utf8"`: the UTF-8 encoding of a text body. Text snapshots in
 *   the earlier record format and rendered snapshots use this basis.
 */
export type SnapshotHashBasis = "bytes" | "decoded-utf8";

/** Persist/replay snapshots. A filesystem and an object-store impl both satisfy this. */
export interface SnapshotStore {
  put(snapshot: Snapshot): Promise<void>;
  latest(sourceId: string): Promise<Snapshot | undefined>;
  get(sourceId: string, bodyHash: string): Promise<Snapshot | undefined>;
  list(sourceId: string): Promise<Snapshot[]>;
  /** Optional exact-lookup capability added after the released v0.3 store contract. */
  findExact?(reference: SnapshotLookup): Promise<ExactSnapshotLookupResult>;
  /** Optional retention capability; stores written against the earlier contract need not implement it. */
  prune?(sourceId: string, options: SnapshotPruneOptions): Promise<SnapshotPruneResult>;
}

/** A store that implements the retention capability. */
export interface PrunableSnapshotStore extends SnapshotStore {
  prune(sourceId: string, options: SnapshotPruneOptions): Promise<SnapshotPruneResult>;
}

/** An explicit retention rule for one source's history. */
export interface SnapshotPruneOptions {
  /** Keep this many of the newest snapshots (the head is always kept, even for 0). */
  keepLast: number;
  /** Snapshots to keep regardless of age, e.g. every snapshot a caller still cites. */
  keep?: readonly SnapshotLookup[];
}

export interface SnapshotPruneResult {
  /** Snapshots removed by this call. */
  removed: number;
  /** Snapshots of this source that remained when the call finished its scan. */
  retained: number;
}

export interface SnapshotLookup {
  sourceId: string;
  url: string;
  bodyHash: string;
  fetchedAt: string;
  snapshotDigest?: string;
}

export type ExactSnapshotLookupResult =
  | { kind: "found"; snapshot: Snapshot }
  | { kind: "missing" }
  | { kind: "mismatch" };

export interface ExactSnapshotStore extends SnapshotStore {
  /** Full identity lookup: no hash prefixes and no unbounded history scan. */
  findExact(reference: SnapshotLookup): Promise<ExactSnapshotLookupResult>;
}

/**
 * Caller-narrowable ceilings for filesystem source-head verification.  They
 * are ceilings, never requests for more work than the store owner permits.
 */
export interface VerifiedHeadLimits {
  /** At most this many immutable snapshot records may be considered. */
  maxEntries?: number;
  /** At most this many bytes of capacity and identity-index metadata may be read. */
  maxIndexBytes?: number;
  /** At most this many serialized snapshot-record bytes may be authenticated. */
  maxVerifiedBodyBytes?: number;
}

/** A versioned, opaque, filesystem-local assertion about one authenticated head. */
export interface SourceHeadWitness {
  format: "forage.source-head-witness/v1";
  sourceId: string;
  headSnapshotRef: SnapshotLookup & { snapshotDigest: string };
  /** Opaque token; binds the complete head identity and this physical store. */
  token: string;
}

export type ReadVerifiedHeadResult =
  | { kind: "found"; headSnapshotRef: SnapshotLookup & { snapshotDigest: string }; witness: SourceHeadWitness }
  | { kind: "missing" }
  | { kind: "unavailable" }
  | { kind: "corrupt" }
  | { kind: "unsupported" };

/** Metadata-only result.  A changed result deliberately does not name a new head. */
export type HeadWitnessComparisonResult =
  | { kind: "matches" }
  | { kind: "changed" }
  | { kind: "missing" }
  | { kind: "unavailable" }
  | { kind: "corrupt" }
  | { kind: "unsupported" };

/** Additive concrete-store capability; generic SnapshotStore implementations remain valid. */
export interface VerifiedHeadSnapshotStore extends ExactSnapshotStore {
  readVerifiedHead(sourceId: string, limits?: VerifiedHeadLimits): Promise<ReadVerifiedHeadResult>;
  compareHeadWitness(
    witness: SourceHeadWitness,
    limits?: VerifiedHeadLimits,
  ): Promise<HeadWitnessComparisonResult>;
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
  /** Present when sitemap discovery ran. Counts successfully read documents and accepted same-host URLs. */
  sitemap?: {
    documentsRead: number;
    urlsDiscovered: number;
  };
}

/** The only error class crawl() throws: the caller supplied an invalid policy or seed. */
export class InvalidCrawlConfigError extends TypeError {
  readonly name = "InvalidCrawlConfigError";
}
