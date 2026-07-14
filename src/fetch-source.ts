/**
 * Polite, retrying, redirect-aware single-page fetch lifted from
 * traverse/fetch/fetch-source.ts and adapted to forage's Snapshot shape.
 */
import { createHash } from "node:crypto";
import { EgressUrlPolicyError, createGuardedFetch } from "./egress.js";
import {
  DEFAULT_MIN_DELAY_MS,
  DEFAULT_RETRIES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  MAX_REDIRECTS,
  MAX_RETRIES,
  type FetchError,
  type FetchLike,
  type FetchResult,
  type FetchSourceOptions,
  type RobotsRules,
  type SourceConfig,
} from "./internal-types.js";
import { isPathAllowed, parseRobots, productToken } from "./robots.js";
import type { Snapshot } from "./types.js";

const GLOBAL_POLITENESS = new Map<string, number>();
const GLOBAL_ROBOTS = new Map<string, RobotsRules>();

export function sha256Hex(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export function sha256Bytes(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultSchedule(ms: number, callback: () => void): () => void {
  const timer = setTimeout(callback, ms);
  return () => clearTimeout(timer);
}

interface ResolvedOptions {
  fetchImpl: FetchLike;
  now: () => number;
  clock: () => string;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  schedule: (ms: number, callback: () => void) => () => void;
  politeness: Map<string, number>;
  robotsCache: Map<string, RobotsRules>;
}

function resolveOptions(
  config: SourceConfig,
  options: FetchSourceOptions,
): ResolvedOptions {
  const fetchImpl =
    options.fetch ??
    (config.egress.guarded
      ? createGuardedFetch({
          testOnlyAllowedLoopbackOrigins:
            config.egress.testOnlyAllowedLoopbackOrigins,
        })
      : globalThis.fetch);
  return {
    fetchImpl: fetchImpl as FetchLike,
    now: options.now ?? Date.now,
    clock: options.clock ?? (() => new Date().toISOString()),
    sleep: options.sleep ?? defaultSleep,
    random: options.random ?? Math.random,
    schedule: options.schedule ?? defaultSchedule,
    politeness: options.politenessState ?? GLOBAL_POLITENESS,
    robotsCache: options.robotsCache ?? GLOBAL_ROBOTS,
  };
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function backoffMs(attempt: number, random: () => number): number {
  return Math.floor(random() * 250 * 2 ** attempt);
}

async function timedGet(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  resolved: ResolvedOptions,
): Promise<{ response?: Response; error?: FetchError }> {
  const controller = new AbortController();
  let timedOut = false;
  const cancel = resolved.schedule(timeoutMs, () => {
    timedOut = true;
    controller.abort(new Error("request timed out"));
  });
  try {
    const response = await resolved.fetchImpl(url, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: controller.signal,
    });
    return { response };
  } catch (error) {
    if (
      timedOut ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      return {
        error: {
          kind: "timeout",
          message: `request to ${url} timed out after ${timeoutMs}ms`,
        },
      };
    }
    return {
      error: {
        kind: error instanceof EgressUrlPolicyError ? "egress-denied" : "network",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    cancel();
  }
}

async function loadRobots(
  origin: string,
  userAgent: string,
  timeoutMs: number,
  resolved: ResolvedOptions,
): Promise<{ rules: RobotsRules; warning?: string }> {
  const cached = resolved.robotsCache.get(origin);
  if (cached) return { rules: cached };
  const { response, error } = await timedGet(
    `${origin}/robots.txt`,
    { "User-Agent": userAgent, Accept: "text/plain,*/*" },
    timeoutMs,
    resolved,
  );
  if (error || !response) {
    const rules: RobotsRules = { rules: [], sitemaps: [] };
    resolved.robotsCache.set(origin, rules);
    return {
      rules,
      warning: `robots.txt for ${origin} unreachable (${error?.kind ?? "no response"}); proceeding (fail-open)`,
    };
  }
  if (response.status >= 500 || response.status === 429) {
    const rules: RobotsRules = { rules: [], sitemaps: [] };
    resolved.robotsCache.set(origin, rules);
    return {
      rules,
      warning: `robots.txt for ${origin} returned ${response.status}; proceeding (fail-open)`,
    };
  }
  if (response.status >= 400) {
    const rules: RobotsRules = { rules: [], sitemaps: [] };
    resolved.robotsCache.set(origin, rules);
    return { rules };
  }
  const rules = parseRobots(await response.text(), userAgent);
  resolved.robotsCache.set(origin, rules);
  return { rules };
}

async function requestWithRetries(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  retries: number,
  resolved: ResolvedOptions,
  warnings: string[],
): Promise<{ response?: Response; error?: FetchError }> {
  let last: { response?: Response; error?: FetchError } = {};
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await resolved.sleep(backoffMs(attempt, resolved.random));
    }
    last = await timedGet(url, headers, timeoutMs, resolved);
    const retryable =
      (last.error &&
        (last.error.kind === "timeout" || last.error.kind === "network")) ||
      (last.response !== undefined && isRetryableStatus(last.response.status));
    if (!retryable) return last;
    if (attempt < retries) {
      warnings.push(
        `retry ${attempt + 1}/${retries} for ${url} after ${last.error?.kind ?? `HTTP ${last.response!.status}`}`,
      );
    }
  }
  return last;
}

function withoutConditionalHeaders(
  base: Record<string, string>,
): Record<string, string> {
  const headers = { ...base };
  for (const name of Object.keys(headers)) {
    if (
      name.toLowerCase() === "if-none-match" ||
      name.toLowerCase() === "if-modified-since"
    ) {
      delete headers[name];
    }
  }
  return headers;
}

function sameResource(left: string, right: string): boolean {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    leftUrl.hash = "";
    rightUrl.hash = "";
    return leftUrl.href === rightUrl.href;
  } catch {
    return false;
  }
}

function isTextual(contentType: string | null): boolean {
  const value = (contentType ?? "").toLowerCase();
  return (
    value === "" ||
    value.startsWith("text/") ||
    value.includes("json") ||
    value.includes("xml") ||
    value.includes("javascript") ||
    value.includes("x-www-form-urlencoded")
  );
}

function withWarnings(result: FetchResult, warnings: string[]): FetchResult {
  return warnings.length ? { ...result, warnings } : result;
}

/** Fetch one source. Operational outcomes are returned, never thrown. */
export async function fetchSource(
  config: SourceConfig,
  options: FetchSourceOptions = {},
): Promise<FetchResult> {
  const warnings: string[] = [];
  try {
    if (!config || typeof config.id !== "string" || !config.id.trim()) {
      return {
        error: { kind: "invalid-config", message: "SourceConfig.id is required" },
      };
    }
    let startUrl: URL;
    try {
      startUrl = new URL(config.url);
    } catch {
      return {
        error: {
          kind: "invalid-url",
          message: `SourceConfig.url is not a valid URL: ${String(config.url)}`,
        },
      };
    }
    if (startUrl.protocol !== "http:" && startUrl.protocol !== "https:") {
      return {
        error: {
          kind: "invalid-url",
          message: `unsupported URL protocol: ${startUrl.protocol}`,
        },
      };
    }

    const userAgent = config.userAgent ?? DEFAULT_USER_AGENT;
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const minDelayMs = config.minDelayMs ?? DEFAULT_MIN_DELAY_MS;
    const retries = Math.max(
      0,
      Math.min(config.retries ?? DEFAULT_RETRIES, MAX_RETRIES),
    );
    const respectRobots = config.respectRobots ?? true;
    const resolved = resolveOptions(config, options);
    const baseHeaders: Record<string, string> = {
      Accept: "text/html,application/xhtml+xml,text/plain,*/*",
      ...(config.headers ?? {}),
      "User-Agent": userAgent,
    };

    let prior: Snapshot | undefined;
    if (options.store) {
      try {
        prior = await options.store.latest(config.id);
      } catch (error) {
        warnings.push(
          `revalidate: prior-snapshot lookup failed (${error instanceof Error ? error.message : String(error)}); fetching unconditionally`,
        );
      }
    }

    const redirects: string[] = [];
    let currentUrl = startUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const origin = currentUrl.origin;
      if (respectRobots) {
        const robots = await loadRobots(
          origin,
          userAgent,
          timeoutMs,
          resolved,
        );
        if (robots.warning) warnings.push(robots.warning);
        if (
          !isPathAllowed(
            robots.rules,
            currentUrl.pathname + currentUrl.search,
          )
        ) {
          return withWarnings(
            {
              error: {
                kind: "robots-denied",
                message: `robots.txt disallows ${productToken(userAgent)} from ${currentUrl.href}`,
              },
            },
            warnings,
          );
        }
      }

      if (minDelayMs > 0) {
        const last = resolved.politeness.get(origin);
        if (last !== undefined) {
          const wait = minDelayMs - (resolved.now() - last);
          if (wait > 0) await resolved.sleep(wait);
        }
      }

      let headers =
        hop === 0 ? { ...baseHeaders } : withoutConditionalHeaders(baseHeaders);
      const matchesPrior =
        prior !== undefined && sameResource(currentUrl.href, prior.url);
      let sentPriorValidator = false;
      if (prior && matchesPrior) {
        headers = withoutConditionalHeaders(headers);
        const etag = prior.headers?.etag;
        const lastModified = prior.headers?.["last-modified"];
        if (etag) {
          headers["If-None-Match"] = etag;
          sentPriorValidator = true;
        }
        if (lastModified) {
          headers["If-Modified-Since"] = lastModified;
          sentPriorValidator = true;
        }
      }

      const attempt = await requestWithRetries(
        currentUrl.href,
        headers,
        timeoutMs,
        retries,
        resolved,
        warnings,
      );
      if (minDelayMs > 0) resolved.politeness.set(origin, resolved.now());
      if (attempt.error) return withWarnings({ error: attempt.error }, warnings);
      const response = attempt.response!;

      if (response.status === 304) {
        if (!prior || !matchesPrior || !sentPriorValidator) {
          return withWarnings(
            {
              error: {
                kind: "http-error",
                status: 304,
                message: `unexpected 304 Not Modified from ${currentUrl.href} without validators from a matching prior snapshot`,
              },
            },
            warnings,
          );
        }
        return withWarnings({ snapshot: prior }, warnings);
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          return withWarnings(
            {
              error: {
                kind: "http-error",
                status: response.status,
                message: `redirect ${response.status} with no Location header from ${currentUrl.href}`,
              },
            },
            warnings,
          );
        }
        if (hop === MAX_REDIRECTS) {
          return withWarnings(
            {
              error: {
                kind: "too-many-redirects",
                message: `exceeded ${MAX_REDIRECTS} redirects starting at ${startUrl.href}`,
              },
            },
            warnings,
          );
        }
        let next: URL;
        try {
          next = new URL(location, currentUrl);
        } catch {
          return withWarnings(
            {
              error: {
                kind: "invalid-url",
                message: `redirect to invalid URL from ${currentUrl.href}`,
              },
            },
            warnings,
          );
        }
        if (currentUrl.protocol === "https:" && next.protocol === "http:") {
          return withWarnings(
            {
              error: {
                kind: "network",
                message: `redirect rejected: HTTPS downgrade to ${next.hostname}`,
              },
            },
            warnings,
          );
        }
        if (next.host !== startUrl.host) {
          return withWarnings(
            {
              error: {
                kind: "network",
                message: `redirect rejected: cross-host target ${next.hostname}`,
              },
            },
            warnings,
          );
        }
        redirects.push(currentUrl.href);
        currentUrl = next;
        continue;
      }

      if (response.status < 200 || response.status >= 300) {
        return withWarnings(
          {
            error: {
              kind: "http-error",
              status: response.status,
              message: `HTTP ${response.status} from ${currentUrl.href}`,
            },
          },
          warnings,
        );
      }

      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await response.arrayBuffer());
      } catch (error) {
        return withWarnings(
          {
            error: {
              kind: "network",
              message: `failed to read body from ${currentUrl.href}: ${error instanceof Error ? error.message : String(error)}`,
            },
          },
          warnings,
        );
      }
      const contentType = response.headers.get("content-type");
      const body = isTextual(contentType)
        ? new TextDecoder().decode(bytes)
        : bytes;
      const headersRecord = Object.fromEntries(response.headers.entries());
      const snapshot: Snapshot = {
        sourceId: config.id,
        url: currentUrl.href,
        status: response.status,
        fetchedAt: resolved.clock(),
        body,
        headers: headersRecord,
        bodyHash:
          typeof body === "string" ? sha256Hex(body) : sha256Bytes(body),
      };
      if (redirects.length) snapshot.redirects = redirects;
      return withWarnings({ snapshot }, warnings);
    }
    return withWarnings(
      {
        error: {
          kind: "too-many-redirects",
          message: `exceeded ${MAX_REDIRECTS} redirects starting at ${startUrl.href}`,
        },
      },
      warnings,
    );
  } catch (error) {
    return withWarnings(
      {
        error: {
          kind: "network",
          message: error instanceof Error ? error.message : String(error),
        },
      },
      warnings,
    );
  }
}
