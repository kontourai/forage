/** Bounded BFS frontier lifted from traverse/fetch/crawl.ts. */
import { fetchSource } from "./fetch-source.js";
import type {
  FetchSourceOptions,
  RobotsRules,
  SourceConfig,
} from "./internal-types.js";
import { buildSnapshotSourceRef } from "./provenance.js";
import { replaySource } from "./snapshot-store.js";
import { discoverSitemapUrls } from "./sitemap.js";
import {
  InvalidCrawlConfigError,
  type CrawlManifest,
  type CrawlPolicy,
  type Page,
  type Seed,
} from "./types.js";

export const DEFAULT_MAX_PAGES = 20;
export const MAX_CRAWL_PAGES = 500;
export const DEFAULT_MAX_DEPTH = 2;
export const MAX_CRAWL_DEPTH = 10;

interface FrontierEntry {
  url: string;
  depth: number;
}

function requireFiniteNumber(
  value: number | undefined,
  name: string,
): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new InvalidCrawlConfigError(`${name} must be a non-negative number`);
  }
}

function validate(seed: Seed, policy: CrawlPolicy): URL {
  if (!seed || typeof seed.url !== "string") {
    throw new InvalidCrawlConfigError("seed.url is required");
  }
  let url: URL;
  try {
    url = new URL(seed.url);
  } catch {
    throw new InvalidCrawlConfigError("seed.url must be an absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvalidCrawlConfigError("seed.url must use http or https");
  }
  requireFiniteNumber(policy.maxPages, "maxPages");
  requireFiniteNumber(policy.maxDepth, "maxDepth");
  requireFiniteNumber(policy.politeness?.delayMs, "politeness.delayMs");
  requireFiniteNumber(
    policy.politeness?.concurrency,
    "politeness.concurrency",
  );
  if (
    policy.politeness?.concurrency !== undefined &&
    policy.politeness.concurrency < 1
  ) {
    throw new InvalidCrawlConfigError(
      "politeness.concurrency must be at least 1",
    );
  }
  if (policy.mode === "replay" && !policy.store) {
    throw new InvalidCrawlConfigError("mode 'replay' requires a store");
  }
  if (
    policy.egress !== undefined &&
    typeof policy.egress.guarded !== "boolean"
  ) {
    throw new InvalidCrawlConfigError("egress.guarded must be a boolean");
  }
  if (policy.sameHost !== undefined && typeof policy.sameHost !== "boolean") {
    throw new InvalidCrawlConfigError("sameHost must be a boolean");
  }
  if (policy.robots !== undefined && typeof policy.robots !== "boolean") {
    throw new InvalidCrawlConfigError("robots must be a boolean");
  }
  if (
    policy.mode !== undefined &&
    policy.mode !== "live" &&
    policy.mode !== "replay"
  ) {
    throw new InvalidCrawlConfigError("mode must be 'live' or 'replay'");
  }
  if (
    policy.discovery !== undefined &&
    !["links", "sitemap", "both"].includes(policy.discovery)
  ) {
    throw new InvalidCrawlConfigError(
      "discovery must be 'links', 'sitemap', or 'both'",
    );
  }
  if (
    policy.render !== undefined &&
    !["never", "on-shell", "always"].includes(policy.render)
  ) {
    throw new InvalidCrawlConfigError(
      "render must be 'never', 'on-shell', or 'always'",
    );
  }
  for (const rawOrigin of policy.egress?.testOnlyAllowedLoopbackOrigins ?? []) {
    let allowed: URL;
    try {
      allowed = new URL(rawOrigin);
    } catch {
      throw new InvalidCrawlConfigError(
        "testOnlyAllowedLoopbackOrigins contains an invalid origin",
      );
    }
    const hostname = allowed.hostname.replace(/^\[|\]$/g, "");
    if (
      allowed.origin !== rawOrigin ||
      allowed.protocol !== "http:" ||
      !allowed.port ||
      (hostname !== "127.0.0.1" && hostname !== "::1")
    ) {
      throw new InvalidCrawlConfigError(
        "testOnlyAllowedLoopbackOrigins entries must be exact HTTP loopback origins with an explicit port",
      );
    }
  }
  return url;
}

function pageId(seedUrl: string, url: string): string {
  return `${encodeURIComponent(seedUrl)}::${url}`;
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

/**
 * Dependency-free adaptation of the reference's linkedom anchor selection.
 * It recognizes quoted and unquoted href attributes; URL parsing remains the
 * authority and malformed/non-http links are ignored.
 */
function discoverLinks(
  html: string,
  baseHref: string,
  seedOrigin: string,
  sameHost: boolean,
): string[] {
  const found: string[] = [];
  try {
    const anchorPattern = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
    for (const match of html.matchAll(anchorPattern)) {
      const href = decodeHtmlAttribute(match[1] ?? match[2] ?? match[3] ?? "");
      if (!href) continue;
      let url: URL;
      try {
        url = new URL(href, baseHref);
      } catch {
        continue;
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      url.hash = "";
      if (sameHost && url.origin !== seedOrigin) continue;
      found.push(url.href);
    }
  } catch {
    return [];
  }
  return found;
}

function isHtml(headers: Record<string, string> | undefined): boolean {
  return (headers?.["content-type"] ?? "").toLowerCase().includes("html");
}

/**
 * Crawl a seed using a bounded, breadth-first frontier. Invalid caller config
 * throws; every operational failure becomes a warning and crawling continues.
 */
export async function crawlWithOptions(
  seed: Seed,
  policy: CrawlPolicy = {},
  internalFetchOptions: FetchSourceOptions = {},
): Promise<CrawlManifest> {
  const parsedSeed = validate(seed, policy);
  parsedSeed.hash = "";
  const seedUrl = parsedSeed.href;
  const maxPages = Math.floor(
    Math.min(policy.maxPages ?? DEFAULT_MAX_PAGES, MAX_CRAWL_PAGES),
  );
  const maxDepth = Math.floor(
    Math.min(policy.maxDepth ?? DEFAULT_MAX_DEPTH, MAX_CRAWL_DEPTH),
  );
  const sameHost = policy.sameHost ?? true;
  const mode = policy.mode ?? "live";
  const egress = policy.egress ?? { guarded: true };
  const warnings: string[] = [];

  const discovery = policy.discovery ?? "links";
  const linksEnabled = policy.discovery !== "sitemap";
  if (policy.shouldFollow) {
    warnings.push(
      "shouldFollow scoring is deferred in this MVP; the deterministic host/depth policy was used",
    );
  }
  if ((policy.politeness?.concurrency ?? 1) !== 1) {
    warnings.push(
      "politeness.concurrency is deferred in this MVP; the frontier ran sequentially",
    );
  }

  const fetchOptions: FetchSourceOptions = {
    ...internalFetchOptions,
    politenessState: new Map<string, number>(),
    robotsCache: new Map<string, RobotsRules>(),
    store: policy.store,
  };
  const queue: FrontierEntry[] = [{ url: seedUrl, depth: 0 }];
  const seen = new Set([seedUrl]);
  let sitemap: CrawlManifest["sitemap"];
  if (discovery === "sitemap" || discovery === "both") {
    sitemap = { documentsRead: 0, urlsDiscovered: 0 };
    if (maxPages > 1 && maxDepth >= 1) {
      try {
        const result = await discoverSitemapUrls(
          seed,
          parsedSeed,
          policy,
          fetchOptions,
          maxPages,
        );
        sitemap = {
          documentsRead: result.documentsRead,
          urlsDiscovered: result.urls.length,
        };
        warnings.push(...result.warnings);
        for (const url of result.urls) {
          if (seen.has(url)) continue;
          seen.add(url);
          queue.push({ url, depth: 1 });
        }
      } catch (error) {
        warnings.push(
          `sitemap discovery failed unexpectedly (${error instanceof Error ? error.message : String(error)}); continuing`,
        );
      }
    }
  }
  const pages: Page[] = [];
  let attempts = 0;

  while (queue.length && attempts < maxPages) {
    const current = queue.shift()!;
    attempts++;
    try {
      const id = pageId(seedUrl, current.url);
      const source: SourceConfig = {
        id,
        url: current.url,
        minDelayMs: policy.politeness?.delayMs,
        headers:
          new URL(current.url).origin === parsedSeed.origin
            ? seed.headers
            : undefined,
        userAgent: seed.userAgent,
        respectRobots: policy.robots ?? true,
        render:
          current.depth === 0 && seed.render
            ? true
            : policy.render === "always"
              ? true
              : policy.render === "on-shell"
                ? "on-shell"
                : false,
        egress,
      };
      const result =
        mode === "replay"
          ? await replaySource(policy.store!, id)
          : await fetchSource(source, fetchOptions);
      for (const warning of result.warnings ?? []) {
        warnings.push(`[depth ${current.depth}] ${current.url}: ${warning}`);
      }
      if (!result.snapshot) {
        const error = result.error;
        warnings.push(
          `[depth ${current.depth}] ${current.url}: ${error?.kind ?? "network"}: ${error?.message ?? "page acquisition failed"}`,
        );
        continue;
      }

      const snapshot = result.snapshot;
      const sourceRef = buildSnapshotSourceRef(snapshot);
      const pageWarnings = [...(result.warnings ?? [])];
      const page: Page = {
        url: snapshot.url,
        status: snapshot.status,
        body: snapshot.body,
        snapshot,
        sourceRef,
        depth: current.depth,
        rendered: snapshot.rendered ?? false,
        warnings: pageWarnings,
      };
      pages.push(page);

      if (mode === "live" && policy.store) {
        try {
          await policy.store.put(snapshot);
        } catch (error) {
          const warning = `store.put failed (${error instanceof Error ? error.message : String(error)}); page kept in memory`;
          page.warnings.push(warning);
          warnings.push(`[depth ${current.depth}] ${current.url}: ${warning}`);
        }
      }

      if (
        !linksEnabled ||
        current.depth >= maxDepth ||
        typeof snapshot.body !== "string" ||
        !isHtml(snapshot.headers)
      ) {
        continue;
      }
      const finalUrl = new URL(snapshot.url);
      if (sameHost && finalUrl.origin !== parsedSeed.origin) {
        warnings.push(
          `[depth ${current.depth}] ${current.url}: fetched page resolved off-host; its links were not followed`,
        );
        continue;
      }
      for (const link of discoverLinks(
        snapshot.body,
        snapshot.url,
        parsedSeed.origin,
        sameHost,
      )) {
        if (seen.has(link)) continue;
        seen.add(link);
        queue.push({ url: link, depth: current.depth + 1 });
      }
    } catch (error) {
      warnings.push(
        `[depth ${current.depth}] ${current.url}: unexpected error (${error instanceof Error ? error.message : String(error)}); continuing`,
      );
    }
  }

  const truncated = queue.length > 0;
  if (truncated) {
    warnings.push(
      `maxPages cap (${maxPages}) reached; ${queue.length} further URL(s) discovered but not fetched`,
    );
  }
  return {
    seed: seedUrl,
    pages,
    truncated,
    warnings,
    ...(sitemap ? { sitemap } : {}),
  };
}

/** Public crawl entrypoint. Network injection is intentionally not exposed. */
export async function crawl(
  seed: Seed,
  policy: CrawlPolicy = {},
): Promise<CrawlManifest> {
  return crawlWithOptions(seed, policy);
}
