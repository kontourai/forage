/**
 * Default-on SSRF and DNS-rebinding-safe egress.
 *
 * Lifted from campfit's egress-url-policy.ts. Address classification remains
 * byte based, every DNS answer must be public, and the connector receives only
 * the chosen validated IP literal while Host and TLS SNI retain the hostname.
 */
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

export type EgressAddress = { address: string; family: 4 | 6 };
export type EgressResolver = (
  hostname: string,
) => Promise<Array<{ address: string; family?: number }>>;
type EgressConnector = (request: {
  request: Request;
  url: URL;
  address: EgressAddress;
}) => Promise<Response>;

export interface EgressResponseOracle {
  responses: Array<{
    status?: number;
    headers?: HeadersInit;
    body?: string;
    bodyBytes?: number[];
    error?: true;
    urlSuffix?: string;
    whenHeaders?: Record<string, string>;
    withoutHeaders?: string[];
    repeat?: boolean;
  }>;
}

export type EgressPolicyErrorCode =
  | "INVALID_URL"
  | "INVALID_SCHEME"
  | "CREDENTIALS"
  | "INVALID_HOST"
  | "DENIED_HOST"
  | "INVALID_PORT"
  | "DNS_FAILURE"
  | "DENIED_ADDRESS"
  | "REDIRECT_INVALID"
  | "REDIRECT_LIMIT"
  | "REDIRECT_LOOP"
  | "REDIRECT_CROSS_HOST"
  | "REDIRECT_DOWNGRADE"
  | "CONNECT_FAILED";

export class EgressUrlPolicyError extends Error {
  readonly name = "EgressUrlPolicyError";

  constructor(
    readonly code: EgressPolicyErrorCode,
    readonly safeHost?: string,
  ) {
    super(`Server egress rejected (${code})${safeHost ? ` for ${safeHost}` : ""}`);
  }
}

const METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "metadata",
  "instance-data",
  "metadata.azure.internal",
]);

function fail(code: EgressPolicyErrorCode, host?: string): never {
  throw new EgressUrlPolicyError(code, host);
}

function ipv4Bytes(address: string): number[] | null {
  if (isIP(address) !== 4) return null;
  const parts = address.split(".").map(Number);
  return parts.length === 4 &&
    parts.every(
      (part) => Number.isInteger(part) && part >= 0 && part <= 255,
    )
    ? parts
    : null;
}

function ipv6Bytes(address: string): number[] | null {
  const unbracketed = address.replace(/^\[|\]$/g, "");
  if (unbracketed.includes("%") || isIP(unbracketed) !== 6) return null;
  let value = unbracketed;
  const dottedAt = value.lastIndexOf(":");
  if (value.includes(".")) {
    const v4 = ipv4Bytes(value.slice(dottedAt + 1));
    if (!v4) return null;
    value = `${value.slice(0, dottedAt)}:${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const zeros = halves.length === 2 ? 8 - left.length - right.length : 0;
  const groups = [...left, ...Array(zeros).fill("0"), ...right];
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const group of groups) {
    const number = Number.parseInt(group, 16);
    if (!/^[0-9a-f]{1,4}$/i.test(group) || number > 0xffff) return null;
    bytes.push(number >> 8, number & 255);
  }
  return bytes;
}

function prefix(bytes: number[], network: number[], bits: number): boolean {
  const whole = Math.floor(bits / 8);
  const remainder = bits % 8;
  for (let index = 0; index < whole; index++) {
    if (bytes[index] !== network[index]) return false;
  }
  return (
    remainder === 0 ||
    (bytes[whole]! & (0xff << (8 - remainder))) ===
      (network[whole]! & (0xff << (8 - remainder)))
  );
}

const V4_DENY: Array<[number[], number]> = [
  [[0, 0, 0, 0], 8],
  [[10, 0, 0, 0], 8],
  [[100, 64, 0, 0], 10],
  [[127, 0, 0, 0], 8],
  [[169, 254, 0, 0], 16],
  [[172, 16, 0, 0], 12],
  [[192, 0, 0, 0], 24],
  [[192, 0, 2, 0], 24],
  [[192, 88, 99, 0], 24],
  [[192, 168, 0, 0], 16],
  [[198, 18, 0, 0], 15],
  [[198, 51, 100, 0], 24],
  [[203, 0, 113, 0], 24],
  [[224, 0, 0, 0], 4],
  [[240, 0, 0, 0], 4],
];

const V6_DENY: Array<[number[], number]> = [
  [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 128],
  [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], 128],
  [[0x01, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 64],
  [[0x20, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 23],
  [[0x20, 0x01, 0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 48],
  [[0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 32],
  [[0x20, 0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 16],
  [[0xfc, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 7],
  [[0xfe, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 10],
  [[0xfe, 0xc0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 10],
  [[0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 8],
];

export function classifyAddress(
  address: string,
  safeHost = address,
): EgressAddress {
  const v4 = ipv4Bytes(address);
  if (v4) {
    if (V4_DENY.some(([network, bits]) => prefix(v4, network, bits))) {
      fail("DENIED_ADDRESS", safeHost);
    }
    return { address: v4.join("."), family: 4 };
  }
  const v6 = ipv6Bytes(address);
  if (!v6) fail("INVALID_HOST", safeHost);
  const mapped = prefix(
    v6,
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0, 0, 0, 0],
    96,
  );
  if (mapped) return classifyAddress(v6.slice(12).join("."), safeHost);
  const compatible = v6.slice(0, 12).every((byte) => byte === 0);
  const translated = prefix(
    v6,
    [0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0, 0, 0, 0, 0, 0],
    96,
  );
  if (compatible || translated) {
    return classifyAddress(v6.slice(12).join("."), safeHost);
  }
  const wellKnownTranslation = prefix(
    v6,
    [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    96,
  );
  const localTranslation = prefix(
    v6,
    [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    48,
  );
  if (wellKnownTranslation) {
    return classifyAddress(v6.slice(12).join("."), safeHost);
  }
  if (localTranslation) fail("DENIED_ADDRESS", safeHost);
  if (V6_DENY.some(([network, bits]) => prefix(v6, network, bits))) {
    fail("DENIED_ADDRESS", safeHost);
  }
  return { address, family: 6 };
}

const defaultResolver: EgressResolver = async (hostname) =>
  dns.lookup(hostname, { all: true, verbatim: true });

function normalizeTestLoopbackOrigins(
  origins: readonly string[],
): ReadonlySet<string> {
  return new Set(
    origins.map((rawOrigin) => {
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
    }),
  );
}

export async function evaluateEgressUrl(
  raw: string | URL,
  deps: {
    resolver?: EgressResolver;
    testOnlyAllowedLoopbackOrigins?: readonly string[];
  } = {},
): Promise<{ url: URL; addresses: EgressAddress[] }> {
  const source = String(raw);
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    fail("INVALID_URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    fail("INVALID_SCHEME", url.hostname);
  }
  if (url.username || url.password) fail("CREDENTIALS", url.hostname);
  const rawAuthority =
    source
      .match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i)?.[1]
      ?.replace(/^[^@]*@/, "") ?? "";
  const rawHost = rawAuthority.startsWith("[")
    ? rawAuthority.slice(0, rawAuthority.indexOf("]") + 1)
    : rawAuthority.split(":")[0]!;
  if (/^(?:0x|0\d|\d+\.\d*$|\d+$)/i.test(rawHost) && isIP(rawHost) !== 4) {
    fail("INVALID_HOST", url.hostname);
  }
  let hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname.endsWith(".")) hostname = hostname.slice(0, -1);
  if (
    !hostname ||
    hostname.includes("%") ||
    METADATA_HOSTS.has(hostname) ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost")
  ) {
    fail("DENIED_HOST", hostname);
  }
  const allowedOrigins = normalizeTestLoopbackOrigins(
    deps.testOnlyAllowedLoopbackOrigins ?? [],
  );
  const loopbackAllowed = allowedOrigins.has(url.origin);
  const explicitPort = url.port;
  if (
    !loopbackAllowed &&
    ((url.protocol === "http:" && explicitPort && explicitPort !== "80") ||
      (url.protocol === "https:" && explicitPort && explicitPort !== "443"))
  ) {
    fail("INVALID_PORT", hostname);
  }
  url.hostname = hostname;
  url.hash = "";

  let answers: Array<{ address: string; family?: number }>;
  if (isIP(hostname)) {
    answers = [{ address: hostname }];
  } else {
    try {
      answers = await (deps.resolver ?? defaultResolver)(hostname);
    } catch {
      fail("DNS_FAILURE", hostname);
    }
  }
  if (!answers.length) fail("DNS_FAILURE", hostname);
  const addresses = answers.map(({ address }) => {
    if (!loopbackAllowed) return classifyAddress(address, hostname);
    const family = isIP(address);
    if (family !== 4 && family !== 6) fail("INVALID_HOST", hostname);
    return { address, family: family as 4 | 6 };
  });
  return { url, addresses };
}

const defaultConnector: EgressConnector = async ({ request, url, address }) => {
  const body = request.body
    ? Buffer.from(await request.arrayBuffer())
    : undefined;
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const headers = Object.fromEntries(request.headers);
    headers.host = url.host;
    const outgoing = transport.request(
      {
        protocol: url.protocol,
        hostname: address.address,
        family: address.family,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: request.method,
        headers,
        ...(url.protocol === "https:" ? { servername: url.hostname } : {}),
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        incoming.on("error", reject);
        incoming.on("end", () => {
          request.signal.removeEventListener("abort", abort);
          const bytes = Buffer.concat(chunks);
          resolve(
            new Response(bytes.length === 0 ? null : bytes, {
              status: incoming.statusCode ?? 500,
              headers: incoming.headers as HeadersInit,
            }),
          );
        });
      },
    );
    const abort = () => outgoing.destroy(request.signal.reason);
    outgoing.once("error", reject);
    if (request.signal.aborted) abort();
    else request.signal.addEventListener("abort", abort, { once: true });
    if (body) outgoing.write(body);
    outgoing.end();
  });
};

function cloneInert(value: unknown, seen = new Set<object>()): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value !== "object" || seen.has(value)) {
    throw new TypeError("Response oracle accepts acyclic inert data only");
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== Array.prototype) {
    throw new TypeError("Response oracle accepts plain data only");
  }
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length) {
    throw new TypeError("Response oracle rejects symbols");
  }
  const output: unknown[] | Record<string, unknown> = Array.isArray(value)
    ? []
    : {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (key === "length" && Array.isArray(value)) continue;
    if (!("value" in descriptor) || descriptor.get || descriptor.set) {
      throw new TypeError("Response oracle rejects accessors");
    }
    (output as Record<string, unknown>)[key] = cloneInert(
      descriptor.value,
      seen,
    );
  }
  seen.delete(value);
  return Object.freeze(output);
}

export function createGuardedFetch(
  options: {
    resolver?: EgressResolver;
    responseOracle?: EgressResponseOracle;
    testOnlyAllowedLoopbackOrigins?: readonly string[];
    maxRedirects?: number;
  } = {},
): typeof fetch {
  const inertOracle = options.responseOracle
    ? (cloneInert(options.responseOracle) as EgressResponseOracle)
    : undefined;
  const oracleResponses = inertOracle ? [...inertOracle.responses] : undefined;
  const connector: EgressConnector = oracleResponses
    ? async ({ request, url }) => {
        const index = oracleResponses.findIndex(
          (candidate) =>
            (!candidate.urlSuffix || url.href.endsWith(candidate.urlSuffix)) &&
            (!candidate.whenHeaders ||
              Object.entries(candidate.whenHeaders).every(
                ([name, value]) => request.headers.get(name) === value,
              )) &&
            (!candidate.withoutHeaders ||
              candidate.withoutHeaders.every(
                (name) => request.headers.get(name) === null,
              )),
        );
        const response = index < 0 ? undefined : oracleResponses[index];
        if (response && !response.repeat) oracleResponses.splice(index, 1);
        if (!response || response.error) throw new Error("fixture oracle failure");
        return new Response(
          response.bodyBytes
            ? new Uint8Array(response.bodyBytes)
            : response.body ?? null,
          {
            status: response.status ?? 200,
            headers: response.headers,
          },
        );
      }
    : defaultConnector;
  const maxRedirects = options.maxRedirects ?? 5;

  return async (input: string | URL | Request, init?: RequestInit) => {
    let request = new Request(input, init);
    const initialOrigin = new URL(request.url).origin;
    const seen = new Set<string>();
    for (let hop = 0; ; hop++) {
      const evaluated = await evaluateEgressUrl(request.url, {
        resolver: options.resolver,
        testOnlyAllowedLoopbackOrigins:
          options.testOnlyAllowedLoopbackOrigins,
      });
      if (seen.has(evaluated.url.href)) {
        fail("REDIRECT_LOOP", evaluated.url.hostname);
      }
      seen.add(evaluated.url.href);
      let response: Response;
      try {
        response = await connector({
          request,
          url: evaluated.url,
          address: evaluated.addresses[0]!,
        });
      } catch (error) {
        if (request.signal.aborted) throw error;
        fail("CONNECT_FAILED", evaluated.url.hostname);
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      if (request.redirect === "manual") return response;
      if (hop >= maxRedirects) fail("REDIRECT_LIMIT", evaluated.url.hostname);
      const location = response.headers.get("location");
      if (!location) return response;
      let next: URL;
      try {
        next = new URL(location, evaluated.url);
      } catch {
        fail("REDIRECT_INVALID", evaluated.url.hostname);
      }
      if (evaluated.url.protocol === "https:" && next.protocol === "http:") {
        fail("REDIRECT_DOWNGRADE", next.hostname);
      }
      if (next.origin !== initialOrigin) {
        fail("REDIRECT_CROSS_HOST", next.hostname);
      }
      const rewrite =
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) &&
          request.method === "POST");
      request = new Request(next, {
        method: rewrite ? "GET" : request.method,
        headers: request.headers,
        body:
          rewrite || request.method === "GET" || request.method === "HEAD"
            ? undefined
            : await request.clone().arrayBuffer(),
        redirect: request.redirect,
        signal: request.signal,
      });
    }
  };
}
