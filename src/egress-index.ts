/**
 * `@kontourai/forage/egress` — the SSRF/DNS-rebinding-safe fetch primitive,
 * exported for consumers that need guarded *single-URL* egress without the full
 * crawl frontier.
 *
 * The package root (`@kontourai/forage`) stays focused on `crawl()`; this
 * subpath exposes the lower-level guard so a consumer can drop
 * `createGuardedFetch()` into any `fetch`-shaped seam (e.g. a `fetchImpl`
 * option) and get the exact same pinned-egress protection the crawler uses:
 * resolve the hostname once, validate every answer's IP against the
 * private/loopback/link-local/metadata deny-lists, connect to the one validated
 * public IP (defeating DNS rebinding), and re-validate every redirect hop.
 *
 * This mirrors traverse's `./fetch` subpath discipline — root import stays
 * lightweight; the guarded-egress surface is an explicit opt-in.
 */

export {
  createGuardedFetch,
  evaluateEgressUrl,
  classifyAddress,
  EgressUrlPolicyError,
} from "./egress.js";
export type {
  EgressAddress,
  EgressResolver,
  EgressResponseOracle,
  EgressPolicyErrorCode,
} from "./egress.js";
export type { EgressPolicy } from "./types.js";
