// Bounded snapshot history: latest() reads only the head's record, prune()
// applies an explicit retention rule, and a full store says so with a typed
// error that prune() can clear.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  createFilesystemSnapshotStore,
  createInMemorySnapshotStore,
  isSnapshotHistoryFullError,
  type Snapshot,
  type SnapshotLookup,
} from "../src/index.js";
import { canonicalDurableSnapshot, snapshotEnvelopeDigest } from "../src/provenance.js";
import { testOnlySnapshotStoreIo } from "../src/snapshot-store.js";
import { storeViolations } from "./support/store-invariants.js";

const SOURCE = "retention-source";

function capture(index: number, body = `capture ${index}`): Snapshot {
  const at = new Date(Date.UTC(2026, 8, 1) + index * 60_000).toISOString();
  return {
    sourceId: SOURCE,
    url: "https://example.test/retained",
    status: 200,
    fetchedAt: at,
    body,
    bodyHash: createHash("sha256").update(body).digest("hex"),
  };
}

function ref(snapshot: Snapshot): SnapshotLookup {
  return {
    sourceId: snapshot.sourceId,
    url: snapshot.url,
    bodyHash: snapshot.bodyHash,
    fetchedAt: snapshot.fetchedAt,
    snapshotDigest: snapshotEnvelopeDigest(snapshot),
  };
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "forage-retention-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function countRecordReads<T>(operation: () => Promise<T>): Promise<{ value: T; reads: number }> {
  let reads = 0;
  testOnlySnapshotStoreIo.onRecordRead = () => { reads += 1; };
  try {
    return { value: await operation(), reads };
  } finally {
    testOnlySnapshotStoreIo.onRecordRead = undefined;
  }
}

function recordFileName(snapshot: Snapshot): string {
  return `${snapshot.fetchedAt.replace(/[^0-9A-Za-z._-]/g, "-")}-${snapshotEnvelopeDigest(snapshot)}.json`;
}

/** The first capacity slot a put probes for this snapshot. */
function startSlot(snapshot: Snapshot, maxHistoryFiles: number): number {
  return Number.parseInt(createHash("sha256").update(recordFileName(snapshot), "utf8").digest("hex").slice(0, 12), 16) %
    maxHistoryFiles;
}

/** A gate a test opens once the interleaving it needs has happened. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { wait, open };
}

describe("filesystem latest()", () => {
  it("reads one record file on a source with 1,000 records", async () => {
    await withRoot(async (root) => {
      const store = createFilesystemSnapshotStore({ root });
      // Three puts through the real writer (fsync-bound, so not 1,000 of them);
      // the serializer below must reproduce each of their files byte for byte.
      const record = (snapshot: Snapshot) => ({
        name: `${snapshot.fetchedAt.replace(/[^0-9A-Za-z._-]/g, "-")}-${snapshotEnvelopeDigest(snapshot)}.json`,
        contents: JSON.stringify(canonicalDurableSnapshot(snapshot), null, 2),
      });
      for (const index of [0, 500, 998]) await store.put(capture(index));
      const directory = path.join(root, (await readdir(root))[0]);
      for (const index of [0, 500, 998]) {
        const expected = record(capture(index));
        assert.equal(await readFile(path.join(directory, expected.name), "utf8"), expected.contents);
      }
      // The head is written first, so it is found by timestamp, not write order.
      for (let index = 999; index >= 0; index -= 1) {
        if (index === 0 || index === 500 || index === 998) continue;
        const next = record(capture(index));
        await writeFile(path.join(directory, next.name), next.contents);
      }
      assert.equal((await readdir(directory)).filter((name) => name.endsWith(".json")).length, 1000);

      const { value, reads } = await countRecordReads(() => store.latest(SOURCE));
      assert.equal(reads, 1);
      assert.equal(value?.fetchedAt, capture(999).fetchedAt);
      assert.equal(value?.body, "capture 999");
      assert.deepEqual(value, (await store.list(SOURCE))[0]);
    });
  });

  it("orders records that share a timestamp exactly as list() does", async () => {
    await withRoot(async (root) => {
      const store = createFilesystemSnapshotStore({ root });
      await store.put(capture(0));
      await store.put(capture(1, "tie a"));
      await store.put(capture(1, "tie b"));
      const { value, reads } = await countRecordReads(() => store.latest(SOURCE));
      assert.equal(reads, 2);
      assert.deepEqual(value, (await store.list(SOURCE))[0]);
    });
  });

  it("falls back to reading every record when a filename is not ISO-shaped", async () => {
    await withRoot(async (root) => {
      const store = createFilesystemSnapshotStore({ root });
      await store.put({ ...capture(0), fetchedAt: "day 2" });
      await store.put({ ...capture(1), fetchedAt: "day 10" });
      const { value, reads } = await countRecordReads(() => store.latest(SOURCE));
      assert.equal(reads, 2);
      assert.equal(value?.fetchedAt, "day 2", "string order, as before");
    });
  });

  it("refuses a fetchedAt that would make an ISO-shaped filename ambiguous", async () => {
    await withRoot(async (root) => {
      const store = createFilesystemSnapshotStore({ root });
      await assert.rejects(
        store.put({ ...capture(0), fetchedAt: "2026-09-01T00 00:00.000Z" }),
        /does not use its separators/,
      );
    });
  });
});

describe("prune()", () => {
  it("keeps the newest keepLast plus every cited snapshot, and leaves a store that verifies", async () => {
    await withRoot(async (root) => {
      const store = createFilesystemSnapshotStore({ root });
      const captures = Array.from({ length: 10 }, (_, index) => capture(index + 1));
      for (const snapshot of captures) await store.put(snapshot);

      const result = await store.prune(SOURCE, { keepLast: 3, keep: [ref(captures[1])] });
      assert.deepEqual(result, { removed: 6, retained: 4 });

      const remaining = await store.list(SOURCE);
      assert.deepEqual(remaining.map((snapshot) => snapshot.body), ["capture 10", "capture 9", "capture 8", "capture 2"]);
      assert.equal((await store.latest(SOURCE))?.body, "capture 10");
      assert.equal((await store.get(SOURCE, captures[1].bodyHash))?.body, "capture 2");
      assert.equal((await store.findExact(ref(captures[0]))).kind, "missing");
      const head = await store.readVerifiedHead(SOURCE);
      assert.equal(head.kind, "found");

      // The index files were removed with their records.
      const directory = path.join(root, (await readdir(root))[0]);
      assert.equal((await readdir(path.join(directory, "identity-index"))).length, 4);
      assert.equal((await readdir(path.join(directory, "capacity-index"))).filter((name) => /^\d+\.txt$/.test(name)).length, 4);
    });
  });

  it("never removes the head, even with keepLast 0", async () => {
    await withRoot(async (root) => {
      const store = createFilesystemSnapshotStore({ root });
      for (let index = 0; index < 4; index += 1) await store.put(capture(index));
      assert.deepEqual(await store.prune(SOURCE, { keepLast: 0 }), { removed: 3, retained: 1 });
      assert.deepEqual((await store.list(SOURCE)).map((snapshot) => snapshot.body), ["capture 3"]);
      assert.equal((await store.readVerifiedHead(SOURCE)).kind, "found");
    });

    const memory = createInMemorySnapshotStore();
    for (let index = 0; index < 4; index += 1) await memory.put(capture(index));
    assert.deepEqual(await memory.prune(SOURCE, { keepLast: 0 }), { removed: 3, retained: 1 });
    assert.equal((await memory.latest(SOURCE))?.body, "capture 3");
  });

  it("frees capacity: a full store reports history-full, and put succeeds after pruning", async () => {
    await withRoot(async (root) => {
      const store = createFilesystemSnapshotStore({ root, maxHistoryFiles: 5 });
      for (let index = 0; index < 5; index += 1) await store.put(capture(index));
      const full = await store.put(capture(5)).then(() => undefined, (error: unknown) => error);
      assert.ok(isSnapshotHistoryFullError(full), "expected a typed history-full error");
      assert.equal(full.code, "history-full");
      assert.equal(full.maxHistoryFiles, 5);

      await store.prune(SOURCE, { keepLast: 2 });
      await store.put(capture(5));
      assert.equal((await store.latest(SOURCE))?.body, "capture 5");
      assert.equal((await store.readVerifiedHead(SOURCE)).kind, "found");
    });
  });

  it("re-putting a kept record after prune does not take a second capacity slot", async () => {
    // With two slots, find an older/newer pair whose filenames hash to the same
    // start slot: the newer record then sits one probe past the older one's
    // slot. Pruning the older record frees the slot the newer one probed past.
    const filename = (snapshot: Snapshot) =>
      `${snapshot.fetchedAt.replace(/[^0-9A-Za-z._-]/g, "-")}-${snapshotEnvelopeDigest(snapshot)}.json`;
    const startSlot = (snapshot: Snapshot) =>
      Number.parseInt(createHash("sha256").update(filename(snapshot), "utf8").digest("hex").slice(0, 12), 16) % 2;
    const older = capture(0);
    let newer = capture(1);
    for (let index = 2; startSlot(newer) !== startSlot(older); index += 1) newer = capture(index);
    assert.equal(startSlot(newer), startSlot(older), "precondition: the pair collides");

    await withRoot(async (root) => {
      const store = createFilesystemSnapshotStore({ root, maxHistoryFiles: 2 });
      await store.put(older);
      await store.put(newer);
      await store.prune(SOURCE, { keepLast: 1 });
      await store.put(newer);
      assert.equal((await store.readVerifiedHead(SOURCE)).kind, "found");
      await store.put(capture(10_000));
      assert.equal((await store.readVerifiedHead(SOURCE)).kind, "found");
    });
  });

  it("a put reclaims a slot that a prune freed after the put's claim failed", async () => {
    // The victim occupies the new record's first probe slot. The put's claim
    // fails, the put stats the slot to read its owner, and a prune frees the
    // slot before the put opens it.
    const maxHistoryFiles = 4;
    const victim = capture(0);
    const head = capture(1);
    let incoming = capture(2);
    for (let index = 3; startSlot(incoming, maxHistoryFiles) !== startSlot(victim, maxHistoryFiles); index += 1) {
      incoming = capture(index);
    }
    assert.equal(startSlot(incoming, maxHistoryFiles), startSlot(victim, maxHistoryFiles), "precondition: the put probes the victim's slot first");
    const slotFile = `${path.sep}capacity-index${path.sep}${startSlot(victim, maxHistoryFiles)}.txt`;
    await withRoot(async (root) => {
      const store = createFilesystemSnapshotStore({ root, maxHistoryFiles });
      await store.put(victim);
      await store.put(head);
      let armed = false;
      let pruned = false;
      testOnlySnapshotStoreIo.afterSlotClaimConflict = () => { if (!pruned) armed = true; };
      testOnlySnapshotStoreIo.afterEntryStat = async (file) => {
        if (!armed || !file.endsWith(slotFile)) return;
        armed = false;
        assert.deepEqual(await store.prune(SOURCE, { keepLast: 1 }), { removed: 1, retained: 1 });
        pruned = true;
      };
      try {
        await store.put(incoming);
      } finally {
        testOnlySnapshotStoreIo.afterSlotClaimConflict = undefined;
        testOnlySnapshotStoreIo.afterEntryStat = undefined;
      }
      assert.ok(pruned, "precondition: the slot was freed between the put's stat and open");
      assert.deepEqual((await store.list(SOURCE)).map((snapshot) => snapshot.body), [incoming.body, "capture 1"]);
      assert.equal((await store.readVerifiedHead(SOURCE)).kind, "found");
    });
  });

  it("rejects a retention rule without an explicit keepLast", async () => {
    await withRoot(async (root) => {
      const store = createFilesystemSnapshotStore({ root });
      await store.put(capture(0));
      await assert.rejects(store.prune(SOURCE, {} as never), TypeError);
      await assert.rejects(store.prune(SOURCE, { keepLast: -1 }), TypeError);
    });
  });
});

/** The pid of a process that has already exited. */
function exitedPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(child.status, 0);
  return child.pid!;
}

async function sourceDirectory(root: string): Promise<string> {
  return path.join(root, (await readdir(root))[0]!);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("prune() concurrency and recovery", () => {
  it("serializes prunes, so a full store cannot be wedged by a prune scanning stale slots", async () => {
    // At cap 2, prune A scans (victim: capture 0) and pauses. Unserialized,
    // prune B would remove the victim, a put would take its freed slot, and A
    // would then free that slot by its stale name: three records under cap 2
    // and a store that refuses every later put and prune.
    const cap = 2;
    await withRoot(async (root) => {
      const store = createFilesystemSnapshotStore({ root, maxHistoryFiles: cap });
      await store.put(capture(0));
      await store.put(capture(1));
      const resumeA = gate();
      const aScanned = gate();
      let scans = 0;
      testOnlySnapshotStoreIo.afterPruneScan = async () => {
        scans += 1;
        if (scans === 1) {
          aScanned.open();
          await resumeA.wait;
        }
      };
      try {
        const pruneA = store.prune(SOURCE, { keepLast: 1 });
        await aScanned.wait;
        const pruneB = store.prune(SOURCE, { keepLast: 1 });
        // B cannot finish, or even scan, while A holds the lock.
        const bFinishedWhileAHeldTheLock = await Promise.race([pruneB.then(() => true), sleep(200).then(() => false)]);
        assert.equal(bFinishedWhileAHeldTheLock, false);
        assert.equal(scans, 1);
        const putWhileFull = await store.put(capture(2)).then(() => "stored", (error: unknown) =>
          isSnapshotHistoryFullError(error) ? "history-full" : String(error));
        resumeA.open();
        assert.deepEqual(await pruneA, { removed: 1, retained: 1 });
        await pruneB;
        if (putWhileFull === "history-full") await store.put(capture(2));
      } finally {
        testOnlySnapshotStoreIo.afterPruneScan = undefined;
      }
      assert.deepEqual(await storeViolations(root, SOURCE, cap, store), []);
      await store.prune(SOURCE, { keepLast: 1 });
      await store.put(capture(3));
      assert.deepEqual(await storeViolations(root, SOURCE, cap, store), []);
    });
  });

  it("recovers from a prune that exited while holding the lock", async () => {
    await withRoot(async (root) => {
      const store = createFilesystemSnapshotStore({ root, maxHistoryFiles: 4 });
      for (let index = 0; index < 3; index += 1) await store.put(capture(index));
      const directory = await sourceDirectory(root);
      await writeFile(path.join(directory, "prune.lock"), JSON.stringify({ host: hostname(), pid: exitedPid(), token: randomUUID() }));
      assert.deepEqual(await store.prune(SOURCE, { keepLast: 1 }), { removed: 2, retained: 1 });
      assert.deepEqual(await storeViolations(root, SOURCE, 4, store), []);
    });
  });

  it("recovers when the process that was breaking a stale lock also exited", async () => {
    await withRoot(async (root) => {
      const store = createFilesystemSnapshotStore({ root, maxHistoryFiles: 4 });
      for (let index = 0; index < 3; index += 1) await store.put(capture(index));
      const directory = await sourceDirectory(root);
      await writeFile(path.join(directory, "prune.lock"), JSON.stringify({ host: hostname(), pid: exitedPid(), token: randomUUID() }));
      await writeFile(path.join(directory, "prune.lock.steal"), JSON.stringify({ host: hostname(), pid: exitedPid() }));
      assert.deepEqual(await store.prune(SOURCE, { keepLast: 1 }), { removed: 2, retained: 1 });
      assert.deepEqual(await storeViolations(root, SOURCE, 4, store), []);
    });
  });

  it("removes temporary files left by exited writers and keeps those of live writers", async () => {
    await withRoot(async (root) => {
      const store = createFilesystemSnapshotStore({ root, maxHistoryFiles: 4 });
      for (let index = 0; index < 3; index += 1) await store.put(capture(index));
      const directory = await sourceDirectory(root);
      const dead = exitedPid();
      const old = new Date(Date.now() - 5 * 60_000);
      const leftovers = [
        path.join(directory, `x.json.${dead}.${randomUUID()}.tmp`),
        path.join(directory, "capacity-index", `1.txt.${dead}.${randomUUID()}.tmp`),
        path.join(directory, "identity-index", `${"a".repeat(64)}.txt.${dead}.${randomUUID()}.tmp`),
      ];
      for (const file of leftovers) {
        await writeFile(file, "partial");
        await utimes(file, old, old);
      }
      const live = path.join(directory, "capacity-index", `2.txt.${process.pid}.${randomUUID()}.tmp`);
      await writeFile(live, "in flight");
      await utimes(live, old, old);

      await store.prune(SOURCE, { keepLast: 1 });
      const remaining = [
        ...await readdir(directory),
        ...await readdir(path.join(directory, "capacity-index")),
        ...await readdir(path.join(directory, "identity-index")),
      ].filter((name) => name.endsWith(".tmp"));
      assert.deepEqual(remaining, [path.basename(live)]);
      await unlink(live);
      assert.deepEqual(await storeViolations(root, SOURCE, 4, store), []);
    });
  });

  it("a put pruned between publishing its record and its identity entry leaves no orphan entry", async () => {
    await withRoot(async (root) => {
      const store = createFilesystemSnapshotStore({ root, maxHistoryFiles: 8 });
      await store.put(capture(10));
      let pruned = false;
      testOnlySnapshotStoreIo.beforePutIdentity = async () => {
        if (pruned) return;
        pruned = true;
        // The put's record (capture 1) is older than the head, so it is a victim.
        assert.deepEqual(await store.prune(SOURCE, { keepLast: 1 }), { removed: 1, retained: 1 });
      };
      try {
        await store.put(capture(1));
      } finally {
        testOnlySnapshotStoreIo.beforePutIdentity = undefined;
      }
      assert.ok(pruned, "precondition: the prune ran inside the put");
      assert.deepEqual(await storeViolations(root, SOURCE, 8, store), []);
    });
  });

  it("removes identity entries that name no record, and restores missing entries and slots", async () => {
    await withRoot(async (root) => {
      const store = createFilesystemSnapshotStore({ root, maxHistoryFiles: 8 });
      for (let index = 0; index < 3; index += 1) await store.put(capture(index));
      const directory = await sourceDirectory(root);
      await writeFile(path.join(directory, "identity-index", `${"b".repeat(64)}.txt`), recordFileName(capture(99)));
      // Remove the identity entry of a real record (capture 1).
      const identityNames = await readdir(path.join(directory, "identity-index"));
      const targets = await Promise.all(identityNames.map((name) => readFile(path.join(directory, "identity-index", name), "utf8")));
      const realEntry = identityNames[targets.findIndex((target) => target.trim() === recordFileName(capture(1)))];
      assert.ok(realEntry, "precondition: capture 1 has an identity entry");
      await unlink(path.join(directory, "identity-index", realEntry));
      const [someSlot] = (await readdir(path.join(directory, "capacity-index"))).filter((name) => /^\d+\.txt$/.test(name));
      await unlink(path.join(directory, "capacity-index", someSlot!));
      assert.notDeepEqual(await storeViolations(root, SOURCE, 8, store), []);

      assert.deepEqual(await store.prune(SOURCE, { keepLast: 10 }), { removed: 0, retained: 3 });
      assert.deepEqual(await storeViolations(root, SOURCE, 8, store), []);
    });
  });

  it("does not count in-flight temporary files toward the capacity-index read limit", async () => {
    await withRoot(async (root) => {
      const cap = 2;
      const store = createFilesystemSnapshotStore({ root, maxHistoryFiles: cap });
      await store.put(capture(0));
      await store.put(capture(1));
      const capacityIndex = path.join(await sourceDirectory(root), "capacity-index");
      const inFlight = [0, 1, 2].map((slot) => path.join(capacityIndex, `${slot}.txt.${process.pid}.${randomUUID()}.tmp`));
      for (const file of inFlight) await writeFile(file, "in flight");
      assert.deepEqual(await store.prune(SOURCE, { keepLast: 1 }), { removed: 1, retained: 1 });
      for (const file of inFlight) await unlink(file);
      assert.deepEqual(await storeViolations(root, SOURCE, cap, store), []);
    });
  });

  it("keeps every invariant under concurrent puts, prunes, and reads from separate processes", async () => {
    const rounds = Number(process.env.FORAGE_PRUNE_STRESS_ROUNDS ?? 25);
    const cap = 4;
    await withRoot(async (root) => {
      const store = createFilesystemSnapshotStore({ root, maxHistoryFiles: cap });
      await store.put(capture(0));
      const worker = new URL("./support/prune-stress-worker.js", import.meta.url).pathname;
      const roles: [string, number][] = [["put", 1], ["put", 2], ["put", 3], ["prune", 1], ["prune", 2], ["latest", 1]];
      const children = roles.map(([role, id]) => fork(worker, [root, role, String(id), String(cap), SOURCE], { stdio: "ignore" }));
      try {
        await Promise.all(children.map((child) => new Promise((resolve) => child.once("message", resolve))));
        const unexpected: string[] = [];
        for (let round = 1; round <= rounds; round += 1) {
          const results = await Promise.all(children.map((child) => new Promise<{ errors: string[] }>((resolve) => {
            child.once("message", (message) => resolve(message as { errors: string[] }));
            child.send({ round });
          })));
          // A put may find the store full; nothing else may fail.
          for (const { errors } of results) {
            unexpected.push(...errors.filter((error) => !error.startsWith("put:SnapshotHistoryFullError:")));
          }
          const violations = await storeViolations(root, SOURCE, cap, store);
          assert.deepEqual(violations, [], `round ${round}`);
        }
        assert.deepEqual(unexpected, []);
      } finally {
        for (const child of children) child.kill();
      }
    });
  });
});
