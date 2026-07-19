/** DNS-pinned, fail-closed browser transport for adaptive rendering. */
import { isIP } from "node:net";
import {
  EgressUrlPolicyError,
  evaluateEgressUrl,
  type EgressAddress,
  type EgressResolver,
} from "./egress.js";
import type { RenderImpl } from "./internal-types.js";

export const DEFAULT_RENDER_TIMEOUT_MS = 30_000;
const RENDER_USER_AGENT =
  "kontourai-forage-bot/0.x (+https://github.com/kontourai/forage)";

interface BrowserRequest {
  url(): string;
  redirectedFrom(): BrowserRequest | null;
}

interface BrowserRoute {
  request(): BrowserRequest;
  continue(): Promise<void>;
  abort(errorCode?: string): Promise<void>;
}

export interface BrowserPage {
  route(pattern: string, handler: (route: BrowserRoute) => Promise<void>): Promise<void>;
  goto(url: string, options: { waitUntil: "networkidle" | "domcontentloaded"; timeout: number }): Promise<unknown>;
  content(): Promise<string>;
  close(): Promise<void>;
}

export interface BrowserInstance {
  newPage(options: { userAgent: string; serviceWorkers: "block" }): Promise<BrowserPage>;
  close(): Promise<void>;
}

export type BrowserLauncher = (options: {
  headless: true;
  args: string[];
}) => Promise<BrowserInstance>;

export interface PinnedBrowserNavigation {
  url: URL;
  hostname: string;
  address: EgressAddress;
  hostResolverRule?: string;
}

function normalizeTestLoopbackOrigins(origins: readonly string[]): ReadonlySet<string> {
  return new Set(origins.map((rawOrigin) => {
    const url = new URL(rawOrigin);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (
      url.origin !== rawOrigin ||
      url.protocol !== "http:" ||
      url.port === "" ||
      (hostname !== "127.0.0.1" && hostname !== "::1")
    ) {
      throw new TypeError(
        "testOnlyAllowedLoopbackOrigins entries must be exact loopback URL origins",
      );
    }
    return url.origin;
  }));
}

function assertResolverRuleHostname(hostname: string): void {
  if (
    hostname.length > 253 ||
    !hostname.split(".").every((label) =>
      label.length >= 1 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))
  ) {
    throw new EgressUrlPolicyError("INVALID_HOST", hostname);
  }
}

/** Resolve through forage's egress policy once, then freeze its first approved IP. */
export async function preparePinnedBrowserNavigation(
  rawUrl: string,
  resolver?: EgressResolver,
  testOnlyAllowedLoopbackOrigins: readonly string[] = [],
): Promise<PinnedBrowserNavigation> {
  const evaluated = await evaluateEgressUrl(rawUrl, {
    resolver,
    testOnlyAllowedLoopbackOrigins,
  });
  const hostname = evaluated.url.hostname.replace(/^\[|\]$/g, "");
  const address = evaluated.addresses[0]!;
  if (isIP(hostname)) return { url: evaluated.url, hostname, address };
  assertResolverRuleHostname(hostname);
  const replacement = address.family === 6 ? `[${address.address}]` : address.address;
  return {
    url: evaluated.url,
    hostname,
    address,
    hostResolverRule: `MAP ${hostname} ${replacement}`,
  };
}

/** Install before navigation; every browser request must remain on the frozen host/IP. */
export async function installGuardedPageNetwork(
  page: BrowserPage,
  pinned: PinnedBrowserNavigation,
  testOnlyAllowedLoopbackOrigins: readonly string[] = [],
): Promise<void> {
  const allowedLoopbackOrigins = normalizeTestLoopbackOrigins(
    testOnlyAllowedLoopbackOrigins,
  );
  await page.route("**/*", async (route) => {
    try {
      const request = route.request();
      const requestUrl = new URL(request.url());
      const requestHostname = requestUrl.hostname.replace(/^\[|\]$/g, "");
      const redirectedFrom = request.redirectedFrom();
      if (
        redirectedFrom &&
        new URL(redirectedFrom.url()).protocol === "https:" &&
        requestUrl.protocol === "http:"
      ) {
        await route.abort("blockedbyclient");
        return;
      }
      if (requestHostname !== pinned.hostname) {
        await route.abort("blockedbyclient");
        return;
      }
      await evaluateEgressUrl(requestUrl, {
        resolver: async () => [pinned.address],
        testOnlyAllowedLoopbackOrigins: allowedLoopbackOrigins.has(requestUrl.origin)
          ? [requestUrl.origin]
          : [],
      });
      await route.continue();
    } catch {
      await route.abort("blockedbyclient");
    }
  });
}

export interface CreateForageRenderImplOptions {
  timeoutMs?: number;
  resolver?: EgressResolver;
  testOnlyAllowedLoopbackOrigins?: readonly string[];
  /** Test seam; production dynamically imports the optional Playwright peer. */
  testOnlyBrowserLauncher?: BrowserLauncher;
}

async function loadPlaywrightLauncher(): Promise<BrowserLauncher> {
  try {
    // Keep the specifier non-literal so TypeScript and Node do not require the
    // optional peer until a render is actually requested.
    const moduleName = "playwright";
    const playwright = await import(moduleName) as {
      chromium?: { launch?: BrowserLauncher };
    };
    if (!playwright.chromium?.launch) throw new Error("Chromium launcher unavailable");
    return playwright.chromium.launch.bind(playwright.chromium);
  } catch (error) {
    const unavailable = new Error(
      "render unavailable: optional peer dependency 'playwright' is not installed",
    );
    unavailable.name = "PlaywrightUnavailableError";
    unavailable.cause = error;
    throw unavailable;
  }
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

/** Create a renderer. Each call launches a dedicated Chromium process for its DNS pin. */
export function createForageRenderImpl(
  opts: CreateForageRenderImplOptions = {},
): RenderImpl {
  const allowedLoopbackOrigins = opts.testOnlyAllowedLoopbackOrigins ?? [];
  normalizeTestLoopbackOrigins(allowedLoopbackOrigins);
  const fallbackTimeoutMs = opts.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;

  return async (url, renderOptions) => {
    const timeoutMs = renderOptions?.timeoutMs ?? fallbackTimeoutMs;
    const pinned = await preparePinnedBrowserNavigation(
      url,
      opts.resolver,
      allowedLoopbackOrigins,
    );
    const launch = opts.testOnlyBrowserLauncher ?? await loadPlaywrightLauncher();
    const args = ["--no-proxy-server"];
    if (pinned.hostResolverRule) {
      args.unshift(`--host-resolver-rules=${pinned.hostResolverRule}`);
    }
    const browser = await launch({ headless: true, args });
    let page: BrowserPage | undefined;
    let usedNetworkidleFallback = false;
    try {
      page = await browser.newPage({
        userAgent: RENDER_USER_AGENT,
        serviceWorkers: "block",
      });
      await installGuardedPageNetwork(page, pinned, allowedLoopbackOrigins);
      try {
        await page.goto(pinned.url.href, { waitUntil: "networkidle", timeout: timeoutMs });
      } catch (error) {
        if (!isTimeoutError(error)) throw error;
        usedNetworkidleFallback = true;
        await page.goto(pinned.url.href, {
          waitUntil: "domcontentloaded",
          timeout: timeoutMs,
        });
      }
      const html = await page.content();
      if (
        renderOptions?.maxResponseBytes !== undefined &&
        Buffer.byteLength(html, "utf8") > renderOptions.maxResponseBytes
      ) {
        throw new Error(`rendered response exceeds ${renderOptions.maxResponseBytes} bytes`);
      }
      return {
        html,
        ...(usedNetworkidleFallback
          ? { warnings: [`render: networkidle fallback used after ${timeoutMs}ms`] }
          : {}),
      };
    } finally {
      await page?.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    }
  };
}
