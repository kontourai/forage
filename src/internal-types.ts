import type { EgressPolicy, Snapshot, SnapshotStore } from "./types.js";

export type FetchErrorKind =
  | "invalid-config"
  | "invalid-url"
  | "robots-denied"
  | "timeout"
  | "network"
  | "egress-denied"
  | "http-error"
  | "too-many-redirects"
  | "no-snapshot";

export interface FetchError {
  kind: FetchErrorKind;
  message: string;
  status?: number;
}

export interface FetchResult {
  snapshot?: Snapshot;
  error?: FetchError;
  warnings?: string[];
}

export interface SourceConfig {
  id: string;
  url: string;
  minDelayMs?: number;
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
  userAgent?: string;
  respectRobots?: boolean;
  /** Render after plain fetch, always or only when the response is a JS shell. */
  render?: boolean | "on-shell";
  egress: EgressPolicy;
}

export interface RenderResult {
  html: string;
  warnings?: string[];
}

export type RenderImpl = (
  url: string,
  options?: { timeoutMs?: number },
) => Promise<RenderResult>;

export type FetchLike = (
  url: string,
  init: {
    method: "GET";
    headers: Record<string, string>;
    redirect: "manual";
    signal: AbortSignal;
  },
) => Promise<Response>;

export interface RobotsRules {
  rules: Array<{ path: string; allow: boolean }>;
  sitemaps: string[];
}

export interface FetchSourceOptions {
  fetch?: FetchLike;
  now?: () => number;
  clock?: () => string;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  schedule?: (ms: number, cb: () => void) => () => void;
  politenessState?: Map<string, number>;
  robotsCache?: Map<string, RobotsRules>;
  store?: SnapshotStore;
  /** Browser transport injection seam. Omit to load forage's optional renderer lazily. */
  renderImpl?: RenderImpl;
}

export const DEFAULT_MIN_DELAY_MS = 1_000;
export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_RETRIES = 2;
export const MAX_RETRIES = 5;
export const MAX_REDIRECTS = 5;
export const DEFAULT_USER_AGENT =
  "kontourai-forage-bot/0.x (+https://github.com/kontourai/forage; contact: set-a-real-contact@example.com)";
