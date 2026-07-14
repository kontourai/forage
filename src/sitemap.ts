import { gunzipSync } from "node:zlib";
import { fetchSource } from "./fetch-source.js";
import type {
  FetchResult,
  FetchSourceOptions,
  SourceConfig,
} from "./internal-types.js";
import { parseRobots } from "./robots.js";
import { replaySource } from "./snapshot-store.js";
import type { CrawlPolicy, Seed, Snapshot } from "./types.js";

export const MAX_SITEMAP_DOCUMENTS = 50;
export const MAX_SITEMAP_DEPTH = 3;
export const MAX_SITEMAP_BYTES = 5 * 1024 * 1024;

interface SitemapEntry {
  url: string;
  depth: number;
}

export interface SitemapDiscoveryResult {
  urls: string[];
  documentsRead: number;
  warnings: string[];
}

function decodeXml(value: string): string {
  const codePoint = (raw: string, radix: number, fallback: string): string => {
    const parsed = Number.parseInt(raw, radix);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 0x10ffff
      ? String.fromCodePoint(parsed)
      : fallback;
  };
  return value
    .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/i, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (entity: string, hex: string) =>
      codePoint(hex, 16, entity),
    )
    .replace(/&#([0-9]+);/g, (entity: string, decimal: string) =>
      codePoint(decimal, 10, entity),
    )
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function parseSitemapXml(
  xml: string,
): {
  kind: "urlset" | "index" | "unknown";
  locations: string[];
  malformed: boolean;
} {
  const urlset = /<(?:[\w.-]+:)?urlset\b/i.test(xml);
  const index = /<(?:[\w.-]+:)?sitemapindex\b/i.test(xml);
  const openLocs = [...xml.matchAll(/<(?:[\w.-]+:)?loc\b[^>]*>/gi)].length;
  const closeLocs = [...xml.matchAll(/<\/(?:[\w.-]+:)?loc\s*>/gi)].length;
  const locations: string[] = [];
  for (const match of xml.matchAll(
    /<(?:[\w.-]+:)?loc\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?loc\s*>/gi,
  )) {
    const value = decodeXml(match[1] ?? "").trim();
    if (value) locations.push(value);
  }
  return {
    kind: index ? "index" : urlset ? "urlset" : "unknown",
    locations,
    malformed: (!urlset && !index) || openLocs !== closeLocs,
  };
}

function snapshotBytes(snapshot: Snapshot): Uint8Array {
  return typeof snapshot.body === "string"
    ? new TextEncoder().encode(snapshot.body)
    : snapshot.body;
}

function sitemapText(
  snapshot: Snapshot,
  requestedUrl: string,
): { text?: string; warning?: string } {
  let bytes = snapshotBytes(snapshot);
  const headers = snapshot.headers ?? {};
  const gzip =
    requestedUrl.toLowerCase().endsWith(".gz") ||
    snapshot.url.toLowerCase().endsWith(".gz") ||
    (headers["content-type"] ?? "").toLowerCase().includes("gzip") ||
    (headers["content-encoding"] ?? "").toLowerCase().includes("gzip");
  if (bytes.byteLength > MAX_SITEMAP_BYTES) {
    return { warning: `sitemap exceeded ${MAX_SITEMAP_BYTES} byte input limit` };
  }
  if (gzip) {
    try {
      bytes = new Uint8Array(
        gunzipSync(bytes, { maxOutputLength: MAX_SITEMAP_BYTES }),
      );
    } catch (error) {
      return {
        warning: `could not gunzip sitemap (${error instanceof Error ? error.message : String(error)})`,
      };
    }
  }
  if (bytes.byteLength > MAX_SITEMAP_BYTES) {
    return {
      warning: `sitemap exceeded ${MAX_SITEMAP_BYTES} byte uncompressed limit`,
    };
  }
  return { text: new TextDecoder().decode(bytes) };
}

function sourceConfig(
  id: string,
  url: string,
  seed: Seed,
  seedOrigin: string,
  policy: CrawlPolicy,
): SourceConfig {
  return {
    id,
    url,
    minDelayMs: policy.politeness?.delayMs,
    headers: new URL(url).origin === seedOrigin ? seed.headers : undefined,
    userAgent: seed.userAgent,
    respectRobots: false,
    egress: policy.egress ?? { guarded: true },
  };
}

async function acquire(
  config: SourceConfig,
  policy: CrawlPolicy,
  options: FetchSourceOptions,
): Promise<FetchResult> {
  if ((policy.mode ?? "live") === "replay") {
    return replaySource(policy.store!, config.id);
  }
  const result = await fetchSource(config, options);
  if (result.snapshot && policy.store) {
    try {
      await policy.store.put(result.snapshot);
    } catch (error) {
      result.warnings = [
        ...(result.warnings ?? []),
        `store.put failed (${error instanceof Error ? error.message : String(error)})`,
      ];
    }
  }
  return result;
}

function operationalWarnings(
  label: string,
  result: FetchResult,
  warnings: string[],
): void {
  for (const warning of result.warnings ?? []) warnings.push(`${label}: ${warning}`);
  if (!result.snapshot) {
    warnings.push(
      `${label}: ${result.error?.kind ?? "network"}: ${result.error?.message ?? "acquisition failed"}`,
    );
  }
}

export async function discoverSitemapUrls(
  seed: Seed,
  seedUrl: URL,
  policy: CrawlPolicy,
  options: FetchSourceOptions,
  maxUrls: number,
): Promise<SitemapDiscoveryResult> {
  const warnings: string[] = [];
  const userAgent = seed.userAgent ?? "kontourai-forage-bot";
  const robotsId = `sitemap-robots::${seedUrl.origin}`;
  const robotsResult = await acquire(
    sourceConfig(
      robotsId,
      `${seedUrl.origin}/robots.txt`,
      seed,
      seedUrl.origin,
      policy,
    ),
    policy,
    options,
  );
  operationalWarnings("sitemap robots.txt", robotsResult, warnings);

  let directives: string[] = [];
  if (typeof robotsResult.snapshot?.body === "string") {
    const rules = parseRobots(robotsResult.snapshot.body, userAgent);
    options.robotsCache?.set(seedUrl.origin, rules);
    directives = rules.sitemaps;
  }
  const sources = directives.length
    ? directives
    : [`${seedUrl.origin}/sitemap.xml`];
  const pending: SitemapEntry[] = [];
  const seenDocuments = new Set<string>();
  let documentCapWarned = false;

  const addDocument = (raw: string, base: string, depth: number): void => {
    let parsed: URL;
    try {
      parsed = new URL(decodeXml(raw).trim(), base);
    } catch {
      warnings.push(`invalid sitemap URL ignored: ${raw}`);
      return;
    }
    parsed.hash = "";
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      warnings.push(`non-HTTP sitemap URL ignored: ${parsed.href}`);
      return;
    }
    if (seenDocuments.has(parsed.href)) return;
    if (seenDocuments.size >= MAX_SITEMAP_DOCUMENTS) {
      if (!documentCapWarned) {
        warnings.push(
          `sitemap document cap (${MAX_SITEMAP_DOCUMENTS}) reached; remaining documents were ignored`,
        );
        documentCapWarned = true;
      }
      return;
    }
    seenDocuments.add(parsed.href);
    pending.push({ url: parsed.href, depth });
  };
  for (const source of sources) addDocument(source, seedUrl.origin, 0);

  const found: string[] = [];
  const seenUrls = new Set<string>();
  let documentsRead = 0;
  let urlCapWarned = false;

  while (pending.length && found.length < maxUrls) {
    const current = pending.shift()!;
    const sourceHost = new URL(current.url).host;
    const result = await acquire(
      sourceConfig(
        `sitemap::${current.url}`,
        current.url,
        seed,
        seedUrl.origin,
        policy,
      ),
      policy,
      options,
    );
    operationalWarnings(`sitemap ${current.url}`, result, warnings);
    if (!result.snapshot) continue;
    documentsRead++;
    if (sourceHost !== seedUrl.host) {
      warnings.push(
        `off-host sitemap document ignored after guarded acquisition: ${current.url}`,
      );
      continue;
    }
    const decoded = sitemapText(result.snapshot, current.url);
    if (!decoded.text) {
      warnings.push(`sitemap ${current.url}: ${decoded.warning}`);
      continue;
    }
    const parsed = parseSitemapXml(decoded.text);
    if (parsed.malformed) {
      warnings.push(
        `sitemap ${current.url}: malformed or unrecognized XML; parsed locations were retained where possible`,
      );
    }
    if (parsed.kind === "index") {
      if (current.depth >= MAX_SITEMAP_DEPTH) {
        if (parsed.locations.length) {
          warnings.push(
            `sitemap nesting depth cap (${MAX_SITEMAP_DEPTH}) reached at ${current.url}`,
          );
        }
        continue;
      }
      for (const location of parsed.locations) {
        let nested: URL;
        try {
          nested = new URL(location, current.url);
        } catch {
          warnings.push(`invalid nested sitemap URL ignored: ${location}`);
          continue;
        }
        if (nested.host !== seedUrl.host) {
          warnings.push(`off-host nested sitemap ignored: ${nested.href}`);
          continue;
        }
        addDocument(nested.href, current.url, current.depth + 1);
      }
      continue;
    }
    for (const location of parsed.locations) {
      let url: URL;
      try {
        url = new URL(location, current.url);
      } catch {
        warnings.push(`invalid sitemap page URL ignored: ${location}`);
        continue;
      }
      url.hash = "";
      if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        url.host !== seedUrl.host
      ) {
        if (url.host !== seedUrl.host) {
          warnings.push(`off-host sitemap page URL ignored: ${url.href}`);
        }
        continue;
      }
      if (seenUrls.has(url.href)) continue;
      if (found.length >= maxUrls) {
        if (!urlCapWarned) {
          warnings.push(
            `sitemap URL cap (${maxUrls}) reached; remaining page URLs were ignored`,
          );
          urlCapWarned = true;
        }
        break;
      }
      seenUrls.add(url.href);
      found.push(url.href);
    }
  }
  if (pending.length && found.length >= maxUrls && !urlCapWarned) {
    warnings.push(
      `sitemap URL cap (${maxUrls}) reached; remaining sitemap documents were ignored`,
    );
  }
  return { urls: found, documentsRead, warnings };
}
