// Bounded snapshot history: latest() reads only the head's record, prune()
// applies an explicit retention rule, and a full store says so with a typed
// error that prune() can clear.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fork, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, lutimes, mkdir, mkdtemp, readdir, readFile, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
import {
  processStartIdentity,
  readLockFileState,
  removeIfUnchanged,
  sourceLockTiming,
  testOnlySourceLockIo,
} from "../src/source-lock.js";
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

async function withLockTiming<T>(timing: Partial<typeof sourceLockTiming>, run: () => Promise<T>): Promise<T> {
  const saved = { ...sourceLockTiming };
  Object.assign(sourceLockTiming, timing);
  try {
    return await run();
  } finally {
    Object.assign(sourceLockTiming, saved);
  }
}

async function writeLock(directory: string, owner: object | string, ageMs = 0): Promise<string> {
  const file = path.join(directory, "source.lock");
  await writeFile(file, typeof owner === "string" ? owner : JSON.stringify(owner));
  if (ageMs > 0) {
    const then = new Date(Date.now() - ageMs);
    await utimes(file, then, then);
  }
  return file;
}

/** Whether `pending` settles within `ms`. */
async function settlesWithin(pending: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([pending.then(() => true, () => true), sleep(ms).then(() => false)]);
}

describe("source lock: puts and prunes", () => {
  it("a re-put and a prune of the same record cannot interleave", async () => {
    // The re-put finds its record present and so reserves no slot. Were a
    // prune to remove the record and its slot before the re-put republished
    // it, the record would be left without a slot: at the cap, a store that
    // fails every later read and write.
    const cap = 2;
    await withRoot(async (root) => {
      const store = createFilesystemSnapshotStore({ root, maxHistoryFiles: cap });
      await store.put(capture(0));
      await store.put(capture(1));
      const inPut = gate();
      const resumePut = gate();
      let pruneRanDuringPut = false;
      let putPaused = false;
      let resumeOpened = false;
      testOnlySnapshotStoreIo.insideSourceLock = async (operation) => {
        if (operation === "put" && !putPaused) {
          putPaused = true;
          inPut.open();
          await resumePut.wait;
        } else if (operation === "prune" && putPaused && !resumeOpened) {
          pruneRanDuringPut = true;
        }
      };
      try {
        const reput = store.put(capture(0));
        await inPut.wait;
        const prune = store.prune(SOURCE, { keepLast: 1 });
        assert.equal(await settlesWithin(prune, 200), false, "the prune waits for the put");
        resumeOpened = true;
        resumePut.open();
        await reput;
        assert.deepEqual(await prune, { removed: 1, retained: 1 });
      } finally {
        testOnlySnapshotStoreIo.insideSourceLock = undefined;
      }
      assert.equal(pruneRanDuringPut, false);
      assert.deepEqual(await storeViolations(root, SOURCE, cap, store), []);
      await store.put(capture(2));
      assert.deepEqual(await storeViolations(root, SOURCE, cap, store), []);
    });
  });

  it("serializes prunes, so a full store cannot be wedged by a prune scanning stale slots", async () => {
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
        const putWhileAHolds = store.put(capture(2));
        assert.equal(await settlesWithin(pruneB, 200), false);
        assert.equal(await settlesWithin(putWhileAHolds, 0), false);
        assert.equal(scans, 1);
        resumeA.open();
        assert.deepEqual(await pruneA, { removed: 1, retained: 1 });
        await Promise.all([pruneB, putWhileAHolds.catch((error: unknown) => {
          if (!isSnapshotHistoryFullError(error)) throw error;
        })]);
      } finally {
        testOnlySnapshotStoreIo.afterPruneScan = undefined;
      }
      assert.deepEqual(await storeViolations(root, SOURCE, cap, store), []);
    });
  });

  it("a holder's heartbeat keeps a long critical section from being broken by age", async () => {
    await withLockTiming({ staleMs: 300, heartbeatMs: 50, waitMs: 5_000 }, async () => {
      await withRoot(async (root) => {
        const store = createFilesystemSnapshotStore({ root, maxHistoryFiles: 8 });
        await store.put(capture(0));
        const inPut = gate();
        const resumePut = gate();
        let holding = false;
        let overlapped = false;
        testOnlySnapshotStoreIo.insideSourceLock = async (operation) => {
          if (operation === "prune" && holding) overlapped = true;
          if (operation === "put") {
            holding = true;
            inPut.open();
            await resumePut.wait;
            holding = false;
          }
        };
        try {
          const put = store.put(capture(1));
          await inPut.wait;
          const prune = store.prune(SOURCE, { keepLast: 1 });
          // Three times the stale ceiling: only the heartbeat keeps the lock fresh.
          assert.equal(await settlesWithin(prune, 900), false);
          resumePut.open();
          await put;
          await prune;
        } finally {
          testOnlySnapshotStoreIo.insideSourceLock = undefined;
        }
        assert.equal(overlapped, false);
        assert.deepEqual(await storeViolations(root, SOURCE, 8, store), []);
      });
    });
  });
});

const MACHINE = "test-machine|boot:0000|pid:[4026531836]";

/** Run with this process's machine identity replaced (undefined: unreadable). */
async function withMachine<T>(machine: string | undefined, run: () => Promise<T>): Promise<T> {
  testOnlySourceLockIo.machineIdentity = async () => machine;
  try {
    return await run();
  } finally {
    testOnlySourceLockIo.machineIdentity = undefined;
  }
}

async function liveOwner(machine = MACHINE): Promise<object> {
  return { machine, pid: process.pid, start: await processStartIdentity(process.pid) ?? null, token: randomUUID() };
}

function deadOwner(machine: string | null = MACHINE): object {
  return { machine, pid: exitedPid(), start: null, token: randomUUID() };
}

async function storeWithRecords(root: string) {
  const store = createFilesystemSnapshotStore({ root, maxHistoryFiles: 4 });
  for (let index = 0; index < 3; index += 1) await store.put(capture(index));
  return { store, directory: await sourceDirectory(root) };
}

async function assertBusyWithinWait(operation: Promise<unknown>): Promise<void> {
  const started = Date.now();
  await assert.rejects(operation, { reason: "store-busy" });
  assert.ok(Date.now() - started < sourceLockTiming.waitMs + 3_000, "gave up near its deadline");
}

describe("source lock: stale owners", () => {
  it("breaks a lock whose owner process has exited", async () => {
    // A wait shorter than the stale ceiling: only the owner's exit can free the lock.
    await withLockTiming({ waitMs: 2_000 }, () => withMachine(MACHINE, () => withRoot(async (root) => {
      const { store, directory } = await storeWithRecords(root);
      await writeLock(directory, deadOwner());
      assert.deepEqual(await store.prune(SOURCE, { keepLast: 1 }), { removed: 2, retained: 1 });
      assert.deepEqual(await storeViolations(root, SOURCE, 4, store), []);
    })));
  });

  it("breaks a lock whose pid now belongs to a different process", async () => {
    // The pid is alive (it is this test's own), but it started at another time.
    await withLockTiming({ waitMs: 2_000 }, () => withMachine(MACHINE, () => withRoot(async (root) => {
      const { store, directory } = await storeWithRecords(root);
      assert.ok(await processStartIdentity(process.pid), "precondition: this platform reports process start times");
      await writeLock(directory, { machine: MACHINE, pid: process.pid, start: "ps-lstart:Thu Jan 1 00:00:00 1970", token: randomUUID() });
      assert.deepEqual(await store.prune(SOURCE, { keepLast: 1 }), { removed: 2, retained: 1 });
      assert.deepEqual(await storeViolations(root, SOURCE, 4, store), []);
    })));
  });

  it("judges a lock from another pid namespace, or an unknown machine, by age alone", async () => {
    // Same hostname, different pid namespace: the recorded pid is alive here
    // but names a different process, which must not make a live lock stale.
    await withLockTiming({ waitMs: 300 }, () => withRoot(async (root) => {
      const { store, directory } = await withMachine(MACHINE, () => storeWithRecords(root));
      const otherNamespace = { machine: MACHINE.replace("4026531836", "4026532999"), pid: process.pid, start: "ps-lstart:Thu Jan 1 00:00:00 1970", token: randomUUID() };
      await writeLock(directory, otherNamespace);
      await withMachine(MACHINE, () => assertBusyWithinWait(store.prune(SOURCE, { keepLast: 1 })));
      await writeLock(directory, deadOwner(null));
      await withMachine(MACHINE, () => assertBusyWithinWait(store.prune(SOURCE, { keepLast: 1 })));
      await writeLock(directory, deadOwner());
      await withMachine(undefined, () => assertBusyWithinWait(store.prune(SOURCE, { keepLast: 1 })));
      await writeLock(directory, otherNamespace, sourceLockTiming.staleMs + 1_000);
      assert.deepEqual(await withMachine(MACHINE, () => store.prune(SOURCE, { keepLast: 1 })), { removed: 2, retained: 1 });
    }));
  });

  it("waits for a live owner, and for another machine's owner until the lock ages past the ceiling", async () => {
    await withLockTiming({ waitMs: 300 }, () => withMachine(MACHINE, () => withRoot(async (root) => {
      const { store, directory } = await storeWithRecords(root);
      const live = await writeLock(directory, await liveOwner());
      await assertBusyWithinWait(store.prune(SOURCE, { keepLast: 1 }));
      await unlink(live);

      const foreign = deadOwner("host:another-machine");
      await writeLock(directory, foreign);
      await assertBusyWithinWait(store.prune(SOURCE, { keepLast: 1 }));
      await writeLock(directory, foreign, sourceLockTiming.staleMs + 1_000);
      assert.deepEqual(await store.prune(SOURCE, { keepLast: 1 }), { removed: 2, retained: 1 });
      assert.deepEqual(await storeViolations(root, SOURCE, 4, store), []);
    })));
  });

  it("looks up a live owner's start time once per lock while waiting", async () => {
    await withLockTiming({ waitMs: 500 }, () => withMachine(MACHINE, () => withRoot(async (root) => {
      const { store, directory } = await storeWithRecords(root);
      await writeLock(directory, await liveOwner());
      let lookups = 0;
      testOnlySourceLockIo.onStartLookup = () => { lookups += 1; };
      try {
        await assertBusyWithinWait(store.prune(SOURCE, { keepLast: 1 }));
      } finally {
        testOnlySourceLockIo.onStartLookup = undefined;
      }
      assert.ok(lookups <= 1, `${lookups} start-time lookups`);
    })));
  });

  it("an empty lock or break marker left by a writer that died is removed once past the ceiling", async () => {
    await withLockTiming({ waitMs: 300 }, () => withMachine(MACHINE, () => withRoot(async (root) => {
      const { store, directory } = await storeWithRecords(root);
      await writeLock(directory, "");
      await assertBusyWithinWait(store.prune(SOURCE, { keepLast: 1 }));
      await writeLock(directory, "", sourceLockTiming.staleMs + 1_000);
      const marker = path.join(directory, "source.lock.break");
      await writeFile(marker, "");
      const then = new Date(Date.now() - sourceLockTiming.staleMs - 1_000);
      await utimes(marker, then, then);
      assert.deepEqual(await store.prune(SOURCE, { keepLast: 1 }), { removed: 2, retained: 1 });
      assert.deepEqual(await storeViolations(root, SOURCE, 4, store), []);
    })));
  });

  it("gives up within the wait when a live breaker holds the marker of a stale lock", async () => {
    await withLockTiming({ waitMs: 300 }, () => withMachine(MACHINE, () => withRoot(async (root) => {
      const { store, directory } = await storeWithRecords(root);
      await writeLock(directory, deadOwner());
      await writeFile(path.join(directory, "source.lock.break"), JSON.stringify(await liveOwner()));
      await assertBusyWithinWait(store.prune(SOURCE, { keepLast: 1 }));
    })));
  });

  it("an oversized lock is judged by age, and a fresh one never makes a writer overrun its wait", async () => {
    await withLockTiming({ waitMs: 300 }, () => withMachine(MACHINE, () => withRoot(async (root) => {
      const { store, directory } = await storeWithRecords(root);
      await writeLock(directory, "x".repeat(5_000));
      await assertBusyWithinWait(store.put(capture(3)));
      await writeLock(directory, "x".repeat(5_000), sourceLockTiming.staleMs + 1_000);
      const started = Date.now();
      await store.put(capture(3));
      assert.ok(Date.now() - started < sourceLockTiming.waitMs + 3_000);
      assert.deepEqual(await storeViolations(root, SOURCE, 4, store), []);
    })));
  });

  it("a symlink at the lock path is judged by age and removed without following it", async () => {
    await withLockTiming({ waitMs: 300 }, () => withMachine(MACHINE, () => withRoot(async (root) => {
      const { store, directory } = await storeWithRecords(root);
      const target = path.join(root, "symlink-target");
      await writeFile(target, "must survive");
      const lock = path.join(directory, "source.lock");
      await symlink(target, lock);
      await assertBusyWithinWait(store.put(capture(3)));
      const then = new Date(Date.now() - sourceLockTiming.staleMs - 1_000);
      await lutimes(lock, then, then);
      await store.put(capture(3));
      assert.equal(await readFile(target, "utf8"), "must survive");
      await unlink(target);
      assert.deepEqual(await storeViolations(root, SOURCE, 4, store), []);
    })));
  });

  it("a directory at the lock path is never removed, and writers give up at their deadline", async () => {
    await withLockTiming({ waitMs: 300 }, () => withMachine(MACHINE, () => withRoot(async (root) => {
      const { store, directory } = await storeWithRecords(root);
      const lock = path.join(directory, "source.lock");
      await mkdir(lock);
      const then = new Date(Date.now() - sourceLockTiming.staleMs - 1_000);
      await utimes(lock, then, then);
      await assertBusyWithinWait(store.put(capture(3)));
      assert.ok((await lstat(lock)).isDirectory());
    })));
  });

  it("removes a stale file only if it is still the file judged stale", async () => {
    await withRoot(async (root) => {
      const file = path.join(root, "source.lock.break");
      await writeFile(file, "the stale marker");
      const judged = (await readLockFileState(file))!;
      await unlink(file);
      await writeFile(file, "a fresh marker written after the stale one was judged");
      assert.equal(await removeIfUnchanged(file, judged), false);
      assert.equal(await readFile(file, "utf8"), "a fresh marker written after the stale one was judged");
      assert.equal(await removeIfUnchanged(file, (await readLockFileState(file))!), true);
      assert.deepEqual(await readdir(root), []);
    });
  });
});

describe("source lock: compare before remove, at each call site", () => {
  it("a breaker does not remove a lock replaced after it was judged stale", async () => {
    await withLockTiming({ waitMs: 300 }, () => withMachine(MACHINE, () => withRoot(async (root) => {
      const { store, directory } = await storeWithRecords(root);
      const lock = await writeLock(directory, deadOwner());
      const replacement = JSON.stringify(await liveOwner());
      let replaced = false;
      testOnlySourceLockIo.afterStaleJudgement = async () => {
        if (replaced) return;
        replaced = true;
        await unlink(lock);
        await writeFile(lock, replacement);
      };
      try {
        await assertBusyWithinWait(store.prune(SOURCE, { keepLast: 1 }));
      } finally {
        testOnlySourceLockIo.afterStaleJudgement = undefined;
      }
      assert.ok(replaced, "precondition: the lock was replaced between judgement and removal");
      assert.equal(await readFile(lock, "utf8"), replacement);
    })));
  });

  it("release leaves alone a lock that another owner took after this one was broken", async () => {
    await withMachine(MACHINE, () => withRoot(async (root) => {
      const { store, directory } = await storeWithRecords(root);
      const lock = path.join(directory, "source.lock");
      const other = JSON.stringify(await liveOwner());
      testOnlySnapshotStoreIo.insideSourceLock = async (operation) => {
        if (operation !== "put") return;
        await unlink(lock);
        await writeFile(lock, other);
      };
      try {
        await store.put(capture(3));
      } finally {
        testOnlySnapshotStoreIo.insideSourceLock = undefined;
      }
      assert.equal(await readFile(lock, "utf8"), other);
    }));
  });

  it("the heartbeat refreshes only its own lock", async () => {
    await withLockTiming({ heartbeatMs: 20 }, () => withMachine(MACHINE, () => withRoot(async (root) => {
      const { store, directory } = await storeWithRecords(root);
      const lock = path.join(directory, "source.lock");
      const other = JSON.stringify(await liveOwner());
      const tenSecondsAgo = new Date(Date.now() - 10_000);
      testOnlySnapshotStoreIo.insideSourceLock = async (operation) => {
        if (operation !== "put") return;
        await unlink(lock);
        await writeFile(lock, other);
        await utimes(lock, tenSecondsAgo, tenSecondsAgo);
        await sleep(200);
      };
      try {
        await store.put(capture(3));
      } finally {
        testOnlySnapshotStoreIo.insideSourceLock = undefined;
      }
      assert.ok(Date.now() - (await lstat(lock)).mtimeMs > 9_000, "another owner's lock was refreshed");
    })));
  });

  it("a lock or marker whose write fails is removed, not left behind", async () => {
    await withLockTiming({ waitMs: 300 }, () => withMachine(MACHINE, () => withRoot(async (root) => {
      const { store, directory } = await storeWithRecords(root);
      const failOnce = (name: string) => {
        let failed = false;
        testOnlySourceLockIo.beforeExclusiveWrite = (file) => {
          if (!failed && path.basename(file) === name) {
            failed = true;
            throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
          }
        };
      };
      try {
        failOnce("source.lock");
        await assert.rejects(store.put(capture(3)), { code: "ENOSPC" });
        assert.equal((await readdir(directory)).includes("source.lock"), false);
        await store.put(capture(3));

        await writeLock(directory, deadOwner());
        failOnce("source.lock.break");
        await assert.rejects(store.prune(SOURCE, { keepLast: 1 }), { code: "ENOSPC" });
        assert.equal((await readdir(directory)).includes("source.lock.break"), false);
      } finally {
        testOnlySourceLockIo.beforeExclusiveWrite = undefined;
      }
      assert.deepEqual(await store.prune(SOURCE, { keepLast: 1 }), { removed: 3, retained: 1 });
      assert.deepEqual(await storeViolations(root, SOURCE, 4, store), []);
    })));
  });
});

describe("prune() recovery", () => {
  it("removes a slot left by a put killed before it published its record", async () => {
    // At cap 2 the orphan slot would otherwise keep the store full for good.
    const cap = 2;
    await withRoot(async (root) => {
      const store = createFilesystemSnapshotStore({ root, maxHistoryFiles: cap });
      await store.put(capture(0));
      const capacityIndex = path.join(await sourceDirectory(root), "capacity-index");
      const used = new Set(await readdir(capacityIndex));
      const free = ["0.txt", "1.txt"].find((slot) => !used.has(slot))!;
      await writeFile(path.join(capacityIndex, free), recordFileName(capture(1)));
      await assert.rejects(store.put(capture(2)), (error: unknown) => isSnapshotHistoryFullError(error));
      await store.prune(SOURCE, { keepLast: 1 });
      await store.put(capture(2));
      assert.deepEqual(await storeViolations(root, SOURCE, cap, store), []);
    });
  });

  it("removes temporary files that interrupted writes left behind", async () => {
    await withRoot(async (root) => {
      const store = createFilesystemSnapshotStore({ root, maxHistoryFiles: 4 });
      for (let index = 0; index < 3; index += 1) await store.put(capture(index));
      const directory = await sourceDirectory(root);
      for (const file of [
        path.join(directory, `x.json.${process.pid}.${randomUUID()}.tmp`),
        path.join(directory, "capacity-index", `1.txt.${exitedPid()}.${randomUUID()}.tmp`),
        path.join(directory, "identity-index", `${"a".repeat(64)}.txt.${process.pid}.${randomUUID()}.tmp`),
      ]) await writeFile(file, "partial");
      await store.prune(SOURCE, { keepLast: 1 });
      assert.deepEqual(await storeViolations(root, SOURCE, 4, store), []);
    });
  });

  it("removes identity entries that name no record, and restores missing entries and slots", async () => {
    await withRoot(async (root) => {
      const store = createFilesystemSnapshotStore({ root, maxHistoryFiles: 8 });
      for (let index = 0; index < 3; index += 1) await store.put(capture(index));
      const directory = await sourceDirectory(root);
      await writeFile(path.join(directory, "identity-index", `${"b".repeat(64)}.txt`), recordFileName(capture(99)));
      const identityNames = await readdir(path.join(directory, "identity-index"));
      const targets = await Promise.all(identityNames.map((name) => readFile(path.join(directory, "identity-index", name), "utf8")));
      const realEntry = identityNames[targets.findIndex((target) => target.trim() === recordFileName(capture(1)))];
      assert.ok(realEntry, "precondition: capture 1 has an identity entry");
      await unlink(path.join(directory, "identity-index", realEntry));
      const capacityIndex = path.join(directory, "capacity-index");
      const slotNames = (await readdir(capacityIndex)).filter((name) => /^\d+\.txt$/.test(name));
      const owners = await Promise.all(slotNames.map((name) => readFile(path.join(capacityIndex, name), "utf8")));
      await unlink(path.join(capacityIndex, slotNames[owners.indexOf(recordFileName(capture(2)))]!));
      assert.notDeepEqual(await storeViolations(root, SOURCE, 8, store), []);

      assert.deepEqual(await store.prune(SOURCE, { keepLast: 10 }), { removed: 0, retained: 3 });
      assert.deepEqual(await storeViolations(root, SOURCE, 8, store), []);
    });
  });
});

interface StressWorker {
  child: ChildProcess;
  role: string;
  id: number;
}

/**
 * Cross-process stress: puts (new and re-puts of earlier captures), prunes,
 * and readers in separate processes, with some workers killed with SIGKILL
 * mid-round. After each round a recovery prune runs and every invariant must
 * hold. Readers may see a record vanish under a concurrent prune.
 */
async function stress(cap: number, rounds: number, killEvery: number): Promise<void> {
  await withRoot(async (root) => {
    const store = createFilesystemSnapshotStore({ root, maxHistoryFiles: cap });
    await store.put(capture(0));
    const script = new URL("./support/prune-stress-worker.js", import.meta.url).pathname;
    const spawn = async (role: string, id: number): Promise<StressWorker> => {
      const child = fork(script, [root, role, String(id), String(cap), SOURCE], { stdio: "ignore" });
      await new Promise((resolve) => child.once("message", resolve));
      return { child, role, id };
    };
    const roles: [string, number][] = [["put", 1], ["put", 2], ["reput", 1], ["prune", 1], ["prune", 2], ["latest", 1], ["list", 1]];
    const workers = await Promise.all(roles.map(([role, id]) => spawn(role, id)));
    const unexpected: string[] = [];
    try {
      for (let round = 1; round <= rounds; round += 1) {
        const victim = round % killEvery === 0 ? workers[round % workers.length]! : undefined;
        const results = workers.map((worker) => new Promise<string[]>((resolve) => {
          const onMessage = (message: unknown) => { worker.child.off("exit", onExit); resolve((message as { errors: string[] }).errors); };
          const onExit = () => { worker.child.off("message", onMessage); resolve([]); };
          worker.child.once("message", onMessage);
          worker.child.once("exit", onExit);
          worker.child.send({ round });
        }));
        if (victim !== undefined) {
          await sleep(round % 7);
          victim.child.kill("SIGKILL");
        }
        for (const errors of await Promise.all(results)) {
          unexpected.push(...errors.filter((error) =>
            !error.startsWith("put:SnapshotHistoryFullError:") &&
            !error.startsWith("reput:SnapshotHistoryFullError:") &&
            !/^(?:latest|list):SnapshotStoreReadError:record-disappeared/.test(error)));
        }
        if (victim !== undefined) {
          if (victim.child.exitCode === null && victim.child.signalCode === null) {
            await new Promise((resolve) => victim.child.once("exit", resolve));
          }
          workers[workers.indexOf(victim)] = await spawn(victim.role, victim.id);
        }
        await store.prune(SOURCE, { keepLast: cap });
        assert.deepEqual(await storeViolations(root, SOURCE, cap, store), [], `cap ${cap}, round ${round}`);
      }
      assert.deepEqual(unexpected, []);
    } finally {
      for (const worker of workers) worker.child.kill("SIGKILL");
    }
  });
}

describe("cross-process stress with re-puts and SIGKILL", () => {
  const rounds = Number(process.env.FORAGE_PRUNE_STRESS_ROUNDS ?? 10);
  it("keeps every invariant at cap 2", async () => {
    await stress(2, rounds, 3);
  });
  it("keeps every invariant at cap 8", async () => {
    await stress(8, rounds, 3);
  });
});
