import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createFilesystemSnapshotStore,
  type Snapshot,
  type SourceHeadWitness,
} from "../src/index.js";
import { testOnlyHeadWitnessIo } from "../src/snapshot-store.js";

function snapshot(minute = 0, body = "head body"): Snapshot {
  return {
    sourceId: "head-witness-source",
    url: "https://example.test/head",
    status: 200,
    fetchedAt: `2026-08-26T12:${String(minute).padStart(2, "0")}:00.000Z`,
    body,
    bodyHash: createHash("sha256").update(body).digest("hex"),
  };
}

async function sourceDirectory(root: string): Promise<string> {
  const entries = await readdir(root);
  assert.equal(entries.length, 1);
  return path.join(root, entries[0]);
}

async function captured(root: string): Promise<{
  store: ReturnType<typeof createFilesystemSnapshotStore>;
  witness: SourceHeadWitness;
}> {
  const store = createFilesystemSnapshotStore({ root });
  await store.put(snapshot());
  const result = await store.readVerifiedHead(snapshot().sourceId);
  assert.equal(result.kind, "found");
  if (result.kind !== "found") throw new Error("expected a witness");
  return { store, witness: result.witness };
}

test("filesystem store captures an authenticated exact head and compares only metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "forage-head-witness-"));
  try {
    const { store, witness } = await captured(root);
    assert.equal(witness.format, "forage.source-head-witness/v1");
    assert.equal(witness.headSnapshotRef.sourceId, snapshot().sourceId);
    assert.match(witness.headSnapshotRef.snapshotDigest, /^[a-f0-9]{64}$/);
    assert.match(witness.token, /^[a-f0-9]{64}$/);
    assert.deepEqual(await store.compareHeadWitness(witness), { kind: "matches" });

    // A fresh store object uses the same unchanged physical namespace.
    assert.deepEqual(
      await createFilesystemSnapshotStore({ root }).compareHeadWitness(witness),
      { kind: "matches" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an independent filesystem writer changes an older witness without a writer upgrade", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "forage-head-second-writer-"));
  try {
    const { store, witness } = await captured(root);
    const independentWriter = createFilesystemSnapshotStore({ root });
    await independentWriter.put(snapshot(1, "written by an independent 0.6.1-compatible writer"));
    assert.deepEqual(await store.compareHeadWitness(witness), { kind: "changed" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("comparison performs zero snapshot-body reads while capture authenticates bodies", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "forage-head-metadata-only-"));
  try {
    const { store, witness } = await captured(root);
    let verifiedRecordReads = 0;
    testOnlyHeadWitnessIo.onVerifiedRecordRead = () => { verifiedRecordReads += 1; };
    assert.deepEqual(await store.compareHeadWitness(witness), { kind: "matches" });
    assert.equal(verifiedRecordReads, 0);
    assert.equal((await store.readVerifiedHead(snapshot().sourceId)).kind, "found");
    assert.equal(verifiedRecordReads, 1);
  } finally {
    testOnlyHeadWitnessIo.onVerifiedRecordRead = undefined;
    await rm(root, { recursive: true, force: true });
  }
});

test("same-size rewrites and restore ABA invalidate the physical witness", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "forage-head-aba-"));
  try {
    const { store, witness } = await captured(root);
    const directory = await sourceDirectory(root);
    const [record] = (await readdir(directory)).filter((entry) => entry.endsWith(".json"));
    const recordPath = path.join(directory, record);
    const original = await readFile(recordPath, "utf8");
    const replacement = `${original.slice(0, -1)}${original.endsWith("\n") ? " " : "\n"}`;
    assert.equal(Buffer.byteLength(replacement), Buffer.byteLength(original));
    await writeFile(recordPath, replacement, "utf8");
    assert.deepEqual(await store.compareHeadWitness(witness), { kind: "changed" });
    await writeFile(recordPath, original, "utf8");
    // Restoring exact content cannot resurrect an old token: ctime/mtime and
    // the final metadata fence retain the intervening physical mutation.
    assert.deepEqual(await store.compareHeadWitness(witness), { kind: "changed" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("metadata and authenticated-body races are fenced, including same-size rewrites", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "forage-head-race-"));
  try {
    const { store, witness } = await captured(root);
    const directory = await sourceDirectory(root);
    const [record] = (await readdir(directory)).filter((entry) => entry.endsWith(".json"));
    const recordPath = path.join(directory, record);
    const contents = await readFile(recordPath, "utf8");
    let ran = false;
    testOnlyHeadWitnessIo.beforeFinalMetadataFence = async () => {
      if (!ran) {
        ran = true;
        await writeFile(recordPath, contents, "utf8");
      }
    };
    assert.deepEqual(await store.compareHeadWitness(witness), { kind: "unavailable" });
    testOnlyHeadWitnessIo.beforeFinalMetadataFence = undefined;

    // Recreate a valid baseline, then change it after body authentication but
    // before the outer fence. The capture refuses rather than returning it.
    const renewed = await store.readVerifiedHead(snapshot().sourceId);
    assert.equal(renewed.kind, "found");
    let bodyRace = false;
    testOnlyHeadWitnessIo.afterVerifiedRecordRead = async () => {
      if (!bodyRace) {
        bodyRace = true;
        await writeFile(recordPath, contents, "utf8");
      }
    };
    assert.deepEqual(await store.readVerifiedHead(snapshot().sourceId), { kind: "unavailable" });
  } finally {
    testOnlyHeadWitnessIo.beforeFinalMetadataFence = undefined;
    testOnlyHeadWitnessIo.afterVerifiedRecordRead = undefined;
    await rm(root, { recursive: true, force: true });
  }
});

test("limits and unavailable physical namespaces refuse before record-body allocation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "forage-head-body-limit-"));
  try {
    const store = createFilesystemSnapshotStore({ root });
    await store.put(snapshot(0, "x".repeat(256 * 1024)));
    let verifiedRecordReads = 0;
    testOnlyHeadWitnessIo.onVerifiedRecordRead = () => { verifiedRecordReads += 1; };
    assert.deepEqual(
      await store.readVerifiedHead(snapshot().sourceId, { maxVerifiedBodyBytes: 32 }),
      { kind: "unavailable" },
    );
    assert.equal(verifiedRecordReads, 0);
    assert.deepEqual(
      await store.readVerifiedHead(snapshot().sourceId, { maxIndexBytes: 0 }),
      { kind: "unavailable" },
    );
    assert.equal(verifiedRecordReads, 0);

    const directory = await sourceDirectory(root);
    const identityDirectory = path.join(directory, "identity-index");
    await chmod(identityDirectory, 0o000);
    try {
      assert.deepEqual(await store.readVerifiedHead(snapshot().sourceId), { kind: "unavailable" });
    } finally {
      await chmod(identityDirectory, 0o700);
    }
  } finally {
    testOnlyHeadWitnessIo.onVerifiedRecordRead = undefined;
    await rm(root, { recursive: true, force: true });
  }
});

test("comparison copies mutable witness input before asynchronous filesystem work", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "forage-head-mutable-input-"));
  try {
    const { store, witness } = await captured(root);
    const mutable: SourceHeadWitness = {
      ...witness,
      headSnapshotRef: { ...witness.headSnapshotRef },
    };
    const comparison = store.compareHeadWitness(mutable);
    mutable.token = "0".repeat(64);
    mutable.headSnapshotRef.url = "https://example.test/mutated-after-call";
    assert.deepEqual(await comparison, { kind: "matches" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capture shares the index-byte ceiling across both fingerprints", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "forage-head-index-ledger-"));
  try {
    const store = createFilesystemSnapshotStore({ root });
    await store.put(snapshot());
    let indexBytesRead = 0;
    testOnlyHeadWitnessIo.onIndexRead = (bytes) => { indexBytesRead += bytes; };
    assert.deepEqual(
      await store.readVerifiedHead(snapshot().sourceId, { maxIndexBytes: 200 }),
      { kind: "unavailable" },
    );
    assert.ok(indexBytesRead <= 200, `read ${indexBytesRead} index bytes despite a 200-byte ceiling`);
  } finally {
    testOnlyHeadWitnessIo.onIndexRead = undefined;
    await rm(root, { recursive: true, force: true });
  }
});

test("witnesses with accessors or unknown fields are unsupported before filesystem metadata I/O", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "forage-head-closed-witness-"));
  try {
    const { store, witness } = await captured(root);
    let metadataStats = 0;
    testOnlyHeadWitnessIo.onMetadataLstat = () => { metadataStats += 1; };
    const accessorWitness = {
      ...witness,
      get sourceId() {
        return metadataStats < 2 ? witness.sourceId : "redirected-source";
      },
    } as SourceHeadWitness;
    assert.deepEqual(await store.compareHeadWitness(accessorWitness), { kind: "unsupported" });
    assert.equal(metadataStats, 0);

    const unknownFieldWitness = {
      ...witness,
      private_path: "/not-a-witness-field",
    } as unknown as SourceHeadWitness;
    assert.deepEqual(await store.compareHeadWitness(unknownFieldWitness), { kind: "unsupported" });
    assert.equal(metadataStats, 0);
  } finally {
    testOnlyHeadWitnessIo.onMetadataLstat = undefined;
    await rm(root, { recursive: true, force: true });
  }
});

test("reservation, temporary, index, and limit states refuse rather than produce a partial witness", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "forage-head-refusal-"));
  try {
    const { store, witness } = await captured(root);
    const directory = await sourceDirectory(root);
    await writeFile(path.join(directory, "interrupted.tmp"), "partial", "utf8");
    assert.deepEqual(await store.compareHeadWitness(witness), { kind: "unavailable" });
    await unlink(path.join(directory, "interrupted.tmp"));

    const identityDirectory = path.join(directory, "identity-index");
    const [identity] = await readdir(identityDirectory);
    await unlink(path.join(identityDirectory, identity));
    assert.deepEqual(await store.readVerifiedHead(snapshot().sourceId), { kind: "unavailable" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const boundedRoot = await mkdtemp(path.join(tmpdir(), "forage-head-limit-"));
  try {
    const { store } = await captured(boundedRoot);
    assert.deepEqual(
      await store.readVerifiedHead(snapshot().sourceId, { maxEntries: 0 }),
      { kind: "unavailable" },
    );
    assert.deepEqual(
      await store.readVerifiedHead(snapshot().sourceId, { maxVerifiedBodyBytes: 0 }),
      { kind: "unavailable" },
    );
  } finally {
    await rm(boundedRoot, { recursive: true, force: true });
  }
});

test("malformed witness inputs perform no source inference, and missing stays distinct", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "forage-head-invalid-witness-"));
  try {
    const store = createFilesystemSnapshotStore({ root });
    assert.deepEqual(await store.readVerifiedHead(snapshot().sourceId), { kind: "missing" });
    assert.deepEqual(
      await store.compareHeadWitness({
        format: "forage.source-head-witness/v1",
        sourceId: snapshot().sourceId,
        headSnapshotRef: { sourceId: snapshot().sourceId, url: "bad", bodyHash: "no", fetchedAt: "bad", snapshotDigest: "bad" },
        token: "not-a-token",
      } as unknown as SourceHeadWitness),
      { kind: "unsupported" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy namespace and root replacement are not silently trusted", async () => {
  const legacyRoot = await mkdtemp(path.join(tmpdir(), "forage-head-legacy-"));
  try {
    const source = snapshot();
    const directory = path.join(legacyRoot, `${source.sourceId}-${createHash("sha256").update(source.sourceId).digest("hex").slice(0, 8)}`);
    // Make the known released record grammar without a metadata index.
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, `${source.fetchedAt.replace(/[^0-9A-Za-z._-]/g, "-")}-${source.bodyHash.slice(0, 12)}.json`),
      JSON.stringify(source),
    );
    assert.deepEqual(
      await createFilesystemSnapshotStore({ root: legacyRoot }).readVerifiedHead(source.sourceId),
      { kind: "unsupported" },
    );
  } finally {
    await rm(legacyRoot, { recursive: true, force: true });
  }

  const root = await mkdtemp(path.join(tmpdir(), "forage-head-root-replacement-"));
  const moved = `${root}-moved`;
  try {
    const { store, witness } = await captured(root);
    await rename(root, moved);
    await symlink(moved, root);
    assert.deepEqual(await store.compareHeadWitness(witness), { kind: "corrupt" });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(moved, { recursive: true, force: true });
  }
});
