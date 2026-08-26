import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
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
