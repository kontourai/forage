import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { publishImmutableFile } from "../src/snapshot-store.js";

test("immutable publication exposes no partial final before the atomic link", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "forage-immutable-pre-link-"));
  const final = path.join(root, "record.json");
  try {
    await assert.rejects(
      publishImmutableFile(final, "complete", {
        afterTempSync: () => { throw new Error("simulated process stop before link"); },
      }),
      /before link/,
    );
    await assert.rejects(readFile(final, "utf8"), { code: "ENOENT" });
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("immutable publication retry fsyncs and accepts a complete post-link final", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "forage-immutable-post-link-"));
  const final = path.join(root, "record.json");
  try {
    await assert.rejects(
      publishImmutableFile(final, "complete", {
        afterLink: () => { throw new Error("simulated process stop before directory fsync"); },
      }),
      /directory fsync/,
    );
    assert.equal(await readFile(final, "utf8"), "complete");

    let directorySyncs = 0;
    assert.equal(await publishImmutableFile(final, "complete", {
      beforeDirectorySync: () => { directorySyncs += 1; },
    }), false);
    assert.equal(directorySyncs, 1);
    assert.equal(await readFile(final, "utf8"), "complete");
    assert.deepEqual(await readdir(root), ["record.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
