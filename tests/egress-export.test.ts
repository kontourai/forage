// Proves the PUBLIC `@kontourai/forage/egress` subpath surface (via the
// egress-index barrel) re-exports a working guard — the same primitive
// consumers like traverse (internal fetch swap) and taxes (fetchImpl) rely on.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createGuardedFetch,
  evaluateEgressUrl,
  classifyAddress,
  EgressUrlPolicyError,
  type EgressResolver,
  type EgressResponseOracle,
} from "../src/egress-index.js";

const resolver = (answers: Record<string, string[]>): EgressResolver =>
  async (hostname) => (answers[hostname] ?? []).map((address) => ({ address }));
const oracle = (...responses: EgressResponseOracle["responses"]): EgressResponseOracle => ({ responses });

describe("@kontourai/forage/egress public surface", () => {
  it("re-exports the primitives as callable values", () => {
    assert.equal(typeof createGuardedFetch, "function");
    assert.equal(typeof evaluateEgressUrl, "function");
    assert.equal(typeof classifyAddress, "function");
    assert.equal(typeof EgressUrlPolicyError, "function");
  });

  it("guards against a private-IP target through the public export (SSRF deny)", async () => {
    await assert.rejects(
      evaluateEgressUrl("http://internal.example", {
        resolver: resolver({ "internal.example": ["10.0.0.1"] }),
      }),
      (error: unknown) => error instanceof EgressUrlPolicyError,
    );
  });

  it("guards against the cloud-metadata address through the public export", async () => {
    await assert.rejects(
      evaluateEgressUrl("http://metadata.example", {
        resolver: resolver({ "metadata.example": ["169.254.169.254"] }),
      }),
      (error: unknown) => error instanceof EgressUrlPolicyError,
    );
  });

  it("createGuardedFetch from the subpath still fetches an allowlisted origin", async () => {
    const allowedOrigin = "http://127.0.0.1:43127";
    const guarded = createGuardedFetch({
      testOnlyAllowedLoopbackOrigins: [allowedOrigin],
      responseOracle: oracle({ body: "fixture" }),
    });
    assert.equal((await guarded(`${allowedOrigin}/page`)).status, 200);
  });
});
