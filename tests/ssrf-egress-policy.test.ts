import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, describe, it, mock } from "node:test";
import {
  EgressUrlPolicyError,
  createGuardedFetch,
  evaluateEgressUrl,
  type EgressResolver,
  type EgressResponseOracle,
} from "../src/egress.js";

const resolver = (answers: Record<string, string[]>): EgressResolver =>
  async (hostname) =>
    (answers[hostname] ?? []).map((address) => ({ address }));
const oracle = (
  ...responses: EgressResponseOracle["responses"]
): EgressResponseOracle => ({ responses });

afterEach(() => mock.restoreAll());

describe("server egress URL policy threat matrix", () => {
  for (const raw of [
    "http://0.0.0.0",
    "http://127.0.0.1",
    "http://10.0.0.1",
    "http://172.16.0.1",
    "http://192.168.1.1",
    "http://100.64.0.1",
    "http://169.254.169.254",
    "http://192.0.2.1",
    "http://198.18.0.1",
    "http://224.0.0.1",
    "http://255.255.255.255",
    "http://[::]",
    "http://[::1]",
    "http://[fc00::1]",
    "http://[fe80::1]",
    "http://[fec0::1]",
    "http://[100::1]",
    "http://[2001::1]",
    "http://[2001:db8::1]",
    "http://[2002::1]",
    "http://[ff00::1]",
    "http://[::ffff:169.254.169.254]",
    "http://metadata.google.internal",
  ]) {
    it(`denies non-global destination ${raw} using parsed address bytes`, async () => {
      await assert.rejects(
        evaluateEgressUrl(raw, { resolver: resolver({}) }),
        EgressUrlPolicyError,
      );
    });
  }

  for (const raw of [
    "http://2130706433",
    "http://0177.0.0.1",
    "http://0x7f000001",
    "http://127.1",
  ]) {
    it(`rejects ambiguous numeric host ${raw}`, async () => {
      await assert.rejects(
        evaluateEgressUrl(raw, { resolver: resolver({}) }),
        (error: unknown) =>
          error instanceof EgressUrlPolicyError && error.code === "INVALID_HOST",
      );
    });
  }

  it("normalizes a public hostname and strips fragments", async () => {
    const result = await evaluateEgressUrl(
      "https://Example.COM./path?q=secret#fragment",
      { resolver: resolver({ "example.com": ["93.184.216.34"] }) },
    );
    assert.equal(result.url.href, "https://example.com/path?q=secret");
    assert.deepEqual(result.addresses, [
      { address: "93.184.216.34", family: 4 },
    ]);
  });

  for (const raw of [
    "ftp://example.com",
    "https://user:secret@example.com",
    "http://example.com:443",
    "https://example.com:80",
    "https://example.com:444",
  ]) {
    it(`rejects disallowed scheme, credentials, or port: ${raw}`, async () => {
      await assert.rejects(
        evaluateEgressUrl(raw, {
          resolver: resolver({ "example.com": ["93.184.216.34"] }),
        }),
        EgressUrlPolicyError,
      );
    });
  }

  it("permits only an explicitly allowlisted exact loopback test origin", async () => {
    const allowedOrigin = "http://127.0.0.1:43127";
    const guarded = createGuardedFetch({
      testOnlyAllowedLoopbackOrigins: [allowedOrigin],
      responseOracle: oracle({ body: "fixture" }),
    });
    assert.equal((await guarded(`${allowedOrigin}/page`)).status, 200);
    await assert.rejects(
      guarded("http://127.0.0.1:43128/page"),
      (error: unknown) =>
        error instanceof EgressUrlPolicyError && error.code === "INVALID_PORT",
    );
    await assert.rejects(
      guarded("http://127.0.0.1/page"),
      (error: unknown) =>
        error instanceof EgressUrlPolicyError && error.code === "DENIED_ADDRESS",
    );
  });

  it("rejects broad or non-canonical loopback test allowances", async () => {
    for (const origin of [
      "http://127.0.0.1",
      "http://127.0.0.1:43127/",
      "https://127.0.0.1:43127",
      "http://localhost:43127",
    ]) {
      await assert.rejects(
        evaluateEgressUrl("http://127.0.0.1:43127/page", {
          testOnlyAllowedLoopbackOrigins: [origin],
        }),
        TypeError,
      );
    }
  });

  it("rejects mixed public/private DNS before connecting", async () => {
    const guarded = createGuardedFetch({
      resolver: resolver({
        "example.test": ["93.184.216.34", "10.0.0.1"],
      }),
      responseOracle: oracle({ body: "must-not-connect" }),
    });
    await assert.rejects(
      guarded("https://example.test/"),
      (error: unknown) =>
        error instanceof EgressUrlPolicyError && error.code === "DENIED_ADDRESS",
    );
  });

  it("fails closed on resolver failure and an empty answer set", async () => {
    await assert.rejects(
      evaluateEgressUrl("https://unresolvable.test", {
        resolver: async () => {
          throw new Error("resolver unavailable");
        },
      }),
      (error: unknown) =>
        error instanceof EgressUrlPolicyError && error.code === "DNS_FAILURE",
    );
    await assert.rejects(
      evaluateEgressUrl("https://unresolvable.test", { resolver: async () => [] }),
      (error: unknown) =>
        error instanceof EgressUrlPolicyError && error.code === "DNS_FAILURE",
    );
  });

  it("pins each connection to the address vetted by the resolver", async () => {
    let calls = 0;
    const guarded = createGuardedFetch({
      resolver: async () => [
        { address: ++calls === 1 ? "93.184.216.34" : "10.0.0.1" },
      ],
      responseOracle: oracle({ body: "ok" }),
    });
    assert.equal(await (await guarded("https://example.test/")).text(), "ok");
    assert.equal(calls, 1);
  });

  it("re-resolves, re-validates, and re-pins every same-host redirect hop", async () => {
    let calls = 0;
    const guarded = createGuardedFetch({
      resolver: async () => [
        { address: ++calls === 1 ? "93.184.216.34" : "10.0.0.1" },
      ],
      responseOracle: oracle(
        { status: 302, headers: { location: "/next" } },
        { body: "must-not-connect" },
      ),
    });
    await assert.rejects(
      guarded("https://example.test/start"),
      (error: unknown) =>
        error instanceof EgressUrlPolicyError && error.code === "DENIED_ADDRESS",
    );
    assert.equal(calls, 2);
  });

  it("follows a same-host redirect only after both hops validate public", async () => {
    let calls = 0;
    const guarded = createGuardedFetch({
      resolver: async () => [
        { address: calls++ === 0 ? "93.184.216.34" : "93.184.216.35" },
      ],
      responseOracle: oracle(
        { status: 302, headers: { location: "/next" } },
        { body: "ok" },
      ),
    });
    assert.equal(
      await (await guarded("https://example.test/start")).text(),
      "ok",
    );
    assert.equal(calls, 2);
  });

  it("invokes production transport with only the vetted IP literal", async () => {
    const destinations: string[] = [];
    mock.method(
      http,
      "request",
      ((options: http.RequestOptions, callback: (response: PassThrough) => void) => {
        destinations.push(String(options.hostname));
        const outgoing = new EventEmitter() as EventEmitter & {
          write: () => void;
          end: () => void;
          destroy: () => void;
        };
        outgoing.write = () => undefined;
        outgoing.destroy = () => undefined;
        outgoing.end = () => {
          const incoming = new PassThrough() as PassThrough & {
            statusCode: number;
            headers: http.IncomingHttpHeaders;
          };
          incoming.statusCode = 200;
          incoming.headers = { "content-type": "text/plain" };
          callback(incoming);
          incoming.end("ok");
        };
        return outgoing;
      }) as unknown as typeof http.request,
    );
    let resolutions = 0;
    const guarded = createGuardedFetch({
      resolver: async () => [
        {
          address:
            ++resolutions === 1 ? "93.184.216.34" : "127.0.0.1",
        },
      ],
    });
    assert.equal(await (await guarded("http://rebinding.example/")).text(), "ok");
    assert.deepEqual(destinations, ["93.184.216.34"]);
    assert.equal(resolutions, 1);
  });

  for (const raw of [
    "http://[::127.0.0.1]",
    "http://[::ffff:0:127.0.0.1]",
    "http://[::ffff:127.0.0.1]",
    "http://[64:ff9b::7f00:1]",
    "http://[64:ff9b:1::7f00:1]",
  ]) {
    it(`denies embedded or translated IPv4 loopback ${raw}`, async () => {
      await assert.rejects(
        evaluateEgressUrl(raw),
        (error: unknown) =>
          error instanceof EgressUrlPolicyError && error.code === "DENIED_ADDRESS",
      );
    });
  }

  it("rejects cross-host redirect before target DNS or connection", async () => {
    let resolutions = 0;
    const guarded = createGuardedFetch({
      resolver: async () => {
        resolutions++;
        return [{ address: "93.184.216.34" }];
      },
      responseOracle: oracle({
        status: 302,
        headers: { location: "https://169.254.169.254/latest/meta-data" },
      }),
    });
    await assert.rejects(
      guarded("https://safe.example/start"),
      (error: unknown) =>
        error instanceof EgressUrlPolicyError &&
        error.code === "REDIRECT_CROSS_HOST",
    );
    assert.equal(resolutions, 1);
  });

  it("rejects HTTPS to HTTP downgrade before second connection", async () => {
    const guarded = createGuardedFetch({
      resolver: resolver({ "safe.example": ["93.184.216.34"] }),
      responseOracle: oracle({
        status: 302,
        headers: { location: "http://safe.example/next" },
      }),
    });
    await assert.rejects(
      guarded("https://safe.example/start"),
      (error: unknown) =>
        error instanceof EgressUrlPolicyError &&
        error.code === "REDIRECT_DOWNGRADE",
    );
  });

  it("bounds redirects and exposes only typed non-secret errors", async () => {
    const guarded = createGuardedFetch({
      resolver: resolver({ "example.test": ["93.184.216.34"] }),
      responseOracle: oracle(
        { status: 302, headers: { location: "/again" } },
        { status: 302, headers: { location: "/again" } },
      ),
      maxRedirects: 2,
    });
    const error = await guarded(
      "https://example.test/?token=top-secret",
    ).catch((value: unknown) => value);
    assert.ok(error instanceof EgressUrlPolicyError);
    assert.equal(error.code, "REDIRECT_LOOP");
    assert.doesNotMatch(String(error), /top-secret/);
  });
});
