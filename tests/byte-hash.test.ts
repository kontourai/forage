// Byte-true text snapshots: bodyHash is SHA-256 of the bytes received, the
// declared charset is kept, and the text is a view derived from both. Records
// in the earlier (decoded-UTF-8) format still load and still resolve.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fetchSource } from "../src/fetch-source.js";
import {
  buildSnapshotSourceRef,
  resolveSnapshotSourceRef,
  snapshotHashBasis,
} from "../src/provenance.js";
import { createFilesystemSnapshotStore, createInMemorySnapshotStore } from "../src/snapshot-store.js";
import { decodeTextBody, parseDeclaredCharset } from "../src/text-body.js";
import type { FetchLike } from "../src/internal-types.js";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function serve(bytes: Uint8Array, contentType: string): FetchLike {
  return (async () => new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { "content-type": contentType },
  })) as unknown as FetchLike;
}

async function fetchBytes(bytes: Uint8Array, contentType: string, fetchedAt = "2026-09-01T00:00:00.000Z") {
  return fetchSource(
    { id: "charset-source", url: "https://example.test/page", respectRobots: false, egress: { guarded: false } },
    {
      fetch: serve(bytes, contentType),
      clock: () => fetchedAt,
      sleep: async () => {},
      politenessState: new Map(),
      robotsCache: new Map(),
    },
  );
}

const CAFE_E9 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]); // "café" in windows-1252
const CAFE_E8 = new Uint8Array([0x63, 0x61, 0x66, 0xe8]); // "cafè" in windows-1252

describe("fetchSource hashes the bytes received", () => {
  it("two windows-1252 bodies that differ in one byte get different hashes, each over the wire bytes", async () => {
    const first = await fetchBytes(CAFE_E9, "text/html; charset=windows-1252");
    const second = await fetchBytes(CAFE_E8, "text/html; charset=windows-1252");
    assert.equal(first.snapshot?.bodyHash, sha256(CAFE_E9));
    assert.equal(second.snapshot?.bodyHash, sha256(CAFE_E8));
    assert.notEqual(first.snapshot?.bodyHash, second.snapshot?.bodyHash);
    assert.equal(snapshotHashBasis(first.snapshot!), "bytes");
  });

  it("decodes the text view with the declared charset", async () => {
    const result = await fetchBytes(CAFE_E9, "text/html; charset=windows-1252");
    assert.equal(result.snapshot?.body, "café");
    assert.equal(result.snapshot?.declaredCharset, "windows-1252");
    assert.deepEqual([...result.snapshot!.bytes!], [...CAFE_E9]);
    assert.equal(result.warnings, undefined);
  });

  it("a UTF-8 page with a BOM keeps its bytes exactly through store and replay", async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("<p>naïve</p>")]);
    const result = await fetchBytes(bytes, "text/html; charset=utf-8");
    assert.equal(result.snapshot?.bodyHash, sha256(bytes));
    assert.equal(result.snapshot?.body, "<p>naïve</p>", "a matching BOM is not part of the text view");

    const root = await mkdtemp(path.join(tmpdir(), "forage-bom-"));
    try {
      const store = createFilesystemSnapshotStore({ root });
      await store.put(result.snapshot!);
      const replayed = await store.latest("charset-source");
      assert.deepEqual([...replayed!.bytes!], [...bytes]);
      assert.equal(replayed?.body, "<p>naïve</p>");
      assert.equal(replayed?.bodyHash, sha256(bytes));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("replay of a stored text snapshot returns the fetched bytes, and its reference resolves", async () => {
    const result = await fetchBytes(CAFE_E9, "text/plain; charset=\"Windows-1252\"");
    const root = await mkdtemp(path.join(tmpdir(), "forage-replay-bytes-"));
    try {
      const store = createFilesystemSnapshotStore({ root });
      await store.put(result.snapshot!);
      // The record keeps the bytes, never a second, possibly disagreeing copy of the text.
      const directory = path.join(root, (await readdir(root))[0]);
      const recordName = (await readdir(directory)).find((name) => name.endsWith(".json"))!;
      const record = JSON.parse(await readFile(path.join(directory, recordName), "utf8"));
      assert.equal(record.body, undefined);
      assert.equal(record.bodyBase64, Buffer.from(CAFE_E9).toString("base64"));
      assert.equal(record.declaredCharset, "windows-1252");

      const replayed = await createFilesystemSnapshotStore({ root }).latest("charset-source");
      assert.deepEqual([...replayed!.bytes!], [...CAFE_E9]);
      assert.equal(replayed?.body, "café");
      const resolved = await resolveSnapshotSourceRef(store, buildSnapshotSourceRef(result.snapshot!));
      assert.equal(resolved.ok, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("warns when bytes are invalid in the declared charset or the label is unknown", async () => {
    const invalid = await fetchBytes(CAFE_E9, "text/html; charset=utf-8");
    assert.equal(invalid.snapshot?.body, "caf�");
    assert.equal(invalid.snapshot?.bodyHash, sha256(CAFE_E9));
    assert.match(invalid.warnings?.join("\n") ?? "", /not valid utf-8/);

    const unknown = await fetchBytes(CAFE_E9, "text/html; charset=x-no-such-charset");
    assert.equal(unknown.snapshot?.declaredCharset, "x-no-such-charset");
    assert.match(unknown.warnings?.join("\n") ?? "", /unknown charset "x-no-such-charset"/);
    // The unknown label is still recorded, and the stored record re-derives the same text.
    const store = createInMemorySnapshotStore();
    await store.put(unknown.snapshot!);
    assert.equal((await store.latest("charset-source"))?.body, unknown.snapshot?.body);
  });

  it("refuses a snapshot whose text is not the decoding of its bytes", async () => {
    const result = await fetchBytes(CAFE_E9, "text/html; charset=windows-1252");
    const store = createInMemorySnapshotStore();
    await assert.rejects(store.put({ ...result.snapshot!, body: "cafe" }), /not the decoding of its bytes/);
  });
});

describe("text-body helpers", () => {
  it("parses the charset parameter and leaves the BOM choice explicit", () => {
    assert.deepEqual(parseDeclaredCharset("text/html; Charset=\"ISO-8859-1\""), { charset: "iso-8859-1", warnings: [] });
    assert.deepEqual(parseDeclaredCharset("text/html"), { charset: null, warnings: [] });
    assert.equal(parseDeclaredCharset("text/html; charset=a b").charset, null);
    assert.equal(decodeTextBody(CAFE_E9, "latin1").text, "café");
    assert.equal(decodeTextBody(CAFE_E9, "latin1").encoding, "windows-1252");
  });
});

describe("records in the earlier decoded-UTF-8 format", () => {
  // Written by the released filesystem store for a windows-1252 response of
  // bytes 63 61 66 E9 (fetched with the previous fetchSource, then put).
  const LEGACY_DIRECTORY = "legacy-source-0de14010";
  const LEGACY_NAME = "2026-09-01T00-00-00.000Z-8b74513f7d83bcc88d93d660930fb87f4163c18456afe3f977b34c1669c30a4b.json";
  const LEGACY_RECORD = "{\n  \"sourceId\": \"legacy-source\",\n  \"url\": \"https://example.test/legacy\",\n  \"status\": 200,\n  \"fetchedAt\": \"2026-09-01T00:00:00.000Z\",\n  \"body\": \"caf�\",\n  \"bodyHash\": \"fb1552c13c0c349659055113e153971759608ad969bc9f4f67f4542c75ab98db\",\n  \"headers\": {\n    \"content-type\": \"text/html; charset=windows-1252\"\n  }\n}";
  const LEGACY_REF = "forage-snapshot:legacy-source?url=https%3A%2F%2Fexample.test%2Flegacy&sha256=fb1552c13c0c349659055113e153971759608ad969bc9f4f67f4542c75ab98db&fetchedAt=2026-09-01T00%3A00%3A00.000Z&snapshotSha256=8b74513f7d83bcc88d93d660930fb87f4163c18456afe3f977b34c1669c30a4b";

  it("still load, report their hash basis, and resolve their existing references", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "forage-legacy-record-"));
    try {
      await mkdir(path.join(root, LEGACY_DIRECTORY));
      await writeFile(path.join(root, LEGACY_DIRECTORY, LEGACY_NAME), LEGACY_RECORD);
      const store = createFilesystemSnapshotStore({ root });

      const loaded = await store.latest("legacy-source");
      assert.equal(loaded?.body, "caf�");
      assert.equal(loaded?.bytes, undefined);
      assert.equal(snapshotHashBasis(loaded!), "decoded-utf8");

      const resolved = await resolveSnapshotSourceRef(store, LEGACY_REF);
      assert.equal(resolved.ok, true);
      assert.equal(buildSnapshotSourceRef(loaded!), LEGACY_REF, "an earlier-format record keeps its reference");

      // A new byte-hashed capture of the same bytes lands beside it.
      const fresh = await fetchSource(
        { id: "legacy-source", url: "https://example.test/legacy", respectRobots: false, egress: { guarded: false } },
        {
          fetch: serve(CAFE_E9, "text/html; charset=windows-1252"),
          clock: () => "2026-09-02T00:00:00.000Z",
          sleep: async () => {},
          politenessState: new Map(),
          robotsCache: new Map(),
        },
      );
      await store.put(fresh.snapshot!);
      const history = await store.list("legacy-source");
      assert.deepEqual(history.map(snapshotHashBasis), ["bytes", "decoded-utf8"]);
      assert.notEqual(history[0].bodyHash, history[1].bodyHash, "the one expected change across the upgrade");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
