/**
 * The per-source write lock of the filesystem snapshot store.
 *
 * Every put and every prune of one source holds this lock for its whole
 * critical section, across processes. Readers never take it. Every process
 * that writes to a store must use a forage version that takes this lock:
 * prune recovery deletes temporary files and slots that name no record, which
 * belong to an unlocked writer that is still running.
 *
 * The lock is a file created exclusively (`O_EXCL`) in the source directory.
 * It records its owner's machine identity, pid, process start time, and a
 * unique token. The owner refreshes the file's mtime every `heartbeatMs` while
 * it holds the lock.
 *
 * The machine identity is the hostname, plus on Linux the boot id and the
 * inode of the owner's pid namespace, so that containers sharing a hostname
 * are told apart. A lock is stale, and may be broken, when:
 *
 * - its file has not been refreshed for `staleMs` (the hard ceiling);
 * - its owner's machine identity equals ours and that pid is not running; or
 * - the machine identity equals ours and the pid is running but started at a
 *   different time, i.e. the owner died and its pid was reused.
 *
 * When either machine identity is missing or unreadable, or they differ, only
 * the age ceiling applies. A lock that is not a regular file of at most 4 KiB
 * (a symlink, an oversized file) is judged by age alone; a directory named like
 * the lock is never removed.
 *
 * Breakers take turns through an exclusive `source.lock.break` marker, which
 * obeys the same staleness rules. A file is only ever removed if it is still
 * the exact file that was judged stale: it is renamed aside (only one caller
 * can get it), compared by inode, size, mtime and contents, and linked back if
 * it differs.
 *
 * Accepted gaps:
 *
 * - A holder whose event loop is blocked for longer than `staleMs`, or that is
 *   stopped and later resumed, can lose its lock while still writing.
 * - Across machines, staleness is judged by age alone, and clock skew of more
 *   than `staleMs` between machines can make a live lock look stale.
 * - Readers take no lock, so a list, get, or full-scan latest running during a
 *   prune can fail transiently with `record-disappeared`.
 * - If two breakers disagree about one file, another process could create
 *   that file in the instant it is renamed aside; the break marker serializes
 *   breakers, so this needs a dead breaker's marker as well.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, lstat, open, readdir, readFile, readlink, rename, unlink, utimes } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { snapshotStoreFailure } from "./snapshot-store-errors.js";

export const SOURCE_LOCK = "source.lock";
const BREAK_MARKER = "source.lock.break";
const ASIDE = /^source\.lock(?:\.break)?\.[0-9a-f-]{36}\.aside$/;
const MAX_LOCK_BYTES = 4096;

/** @internal Lock timings. Tests shorten them; production code never changes them. */
export const sourceLockTiming = {
  /** Hard ceiling: a lock not refreshed for this long is stale whatever its owner. */
  staleMs: 60_000,
  /** How often a holder refreshes its lock. */
  heartbeatMs: 10_000,
  /** How long an acquirer waits before failing with `store-busy`; longer than `staleMs`. */
  waitMs: 90_000,
};

/** @internal Test-only seams; not re-exported by any package surface. */
export const testOnlySourceLockIo = {
  /** Replaces this process's machine identity. */
  machineIdentity: undefined as undefined | (() => Promise<string | undefined>),
  /** Runs after a breaker judged the lock stale and before it removes it. */
  afterStaleJudgement: undefined as undefined | (() => void | Promise<void>),
  /** Runs before the contents of a newly created lock or marker are written. */
  beforeExclusiveWrite: undefined as undefined | ((file: string) => void | Promise<void>),
  /** Counts process start-time lookups. */
  onStartLookup: undefined as undefined | ((pid: number) => void),
};

interface LockOwner {
  machine: string | null;
  pid: number;
  start: string | null;
  token: string;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The start time of the process running as `pid`, as the OS reports it, or
 * undefined when it cannot be read. Linux reads `/proc/<pid>/stat` field 22
 * (clock ticks since boot). Elsewhere `ps -o lstart=` is run with `TZ=UTC` and
 * `LC_ALL=C`, so every reader spells the same instant the same way whatever
 * its own time zone or locale.
 */
export async function processStartIdentity(pid: number): Promise<string | undefined> {
  testOnlySourceLockIo.onStartLookup?.(pid);
  if (process.platform === "linux") {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return fields[19] ? `linux-starttime:${fields[19]}` : undefined;
    } catch {
      return undefined;
    }
  }
  if (process.platform === "win32") return undefined;
  return new Promise((resolve) => {
    execFile("ps", ["-o", "lstart=", "-p", String(pid)], {
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      timeout: 2_000,
    }, (error, stdout) => {
      const started = error ? "" : stdout.trim().replace(/\s+/g, " ");
      resolve(started ? `ps-lstart:${started}` : undefined);
    });
  });
}

/**
 * Which pid space this process's pids belong to: the hostname, and on Linux
 * the boot id and the pid-namespace inode. Undefined when a part cannot be
 * read, which leaves only the age ceiling to judge locks.
 */
async function readMachineIdentity(): Promise<string | undefined> {
  if (process.platform !== "linux") return `host:${hostname()}`;
  try {
    const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    const pidNamespace = await readlink("/proc/self/ns/pid");
    return bootId && pidNamespace ? `host:${hostname()}|boot:${bootId}|${pidNamespace}` : undefined;
  } catch {
    return undefined;
  }
}

let ownMachine: Promise<string | undefined> | undefined;
let ownStart: Promise<string | undefined> | undefined;

function machineIdentity(): Promise<string | undefined> {
  if (testOnlySourceLockIo.machineIdentity !== undefined) return testOnlySourceLockIo.machineIdentity();
  ownMachine ??= readMachineIdentity();
  return ownMachine;
}

async function newOwner(): Promise<string> {
  ownStart ??= processStartIdentity(process.pid);
  const owner: LockOwner = {
    machine: (await machineIdentity()) ?? null,
    pid: process.pid,
    start: (await ownStart) ?? null,
    token: randomUUID(),
  };
  return JSON.stringify(owner);
}

function parseOwner(text: string): LockOwner | undefined {
  try {
    const value = JSON.parse(text) as Partial<LockOwner>;
    return (value.machine === null || typeof value.machine === "string") && Number.isSafeInteger(value.pid) &&
      (value.start === null || typeof value.start === "string") && typeof value.token === "string"
      ? value as LockOwner
      : undefined;
  } catch {
    return undefined;
  }
}

/** One observation of a lock or marker file. `text` is absent when it is not a small regular file. */
export interface LockFileState {
  text: string | undefined;
  directory: boolean;
  ageMs: number;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

export async function readLockFileState(file: string): Promise<LockFileState | undefined> {
  return readState(file);
}

async function readState(file: string): Promise<LockFileState | undefined> {
  let stat;
  try {
    stat = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let text: string | undefined;
  if (stat.isFile() && stat.size <= MAX_LOCK_BYTES) {
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  return {
    text,
    directory: stat.isDirectory(),
    ageMs: Date.now() - stat.mtimeMs,
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

/** Start times looked up during one acquire, keyed by pid and lock contents. */
type StartCache = Map<string, Promise<string | undefined>>;

/** Whether a lock or break marker in this state may be removed. */
async function isStale(state: LockFileState, starts: StartCache): Promise<boolean> {
  if (state.directory) return false;
  if (state.ageMs > sourceLockTiming.staleMs) return true;
  if (state.text === undefined) return false;
  const owner = parseOwner(state.text);
  // Empty or half-written: its writer is mid-write, or died there; only age can tell.
  if (owner === undefined || owner.machine === null) return false;
  const machine = await machineIdentity();
  if (machine === undefined || owner.machine !== machine) return false;
  if (!processIsAlive(owner.pid)) return true;
  if (owner.start === null) return false;
  const key = `${owner.pid}\n${state.text}`;
  let lookup = starts.get(key);
  if (lookup === undefined) {
    lookup = processStartIdentity(owner.pid);
    starts.set(key, lookup);
  }
  const current = await lookup;
  return current !== undefined && current !== owner.start;
}

async function unlinkIfPresent(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Create `file` exclusively with `contents`. A file whose write failed is removed, not left empty. */
async function createExclusive(file: string, contents: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(file, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    await testOnlySourceLockIo.beforeExclusiveWrite?.(file);
    await handle.writeFile(contents, "utf8");
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlinkIfPresent(file);
    throw error;
  }
  return true;
}

/**
 * The same file, unchanged. Readable locks and markers carry a unique token,
 * so inode and contents identify them (a holder's heartbeat moves the mtime);
 * a file too large to read, or a symlink, is compared by size and mtime too.
 */
function sameFile(left: LockFileState, right: LockFileState): boolean {
  if (left.directory || right.directory || left.dev !== right.dev || left.ino !== right.ino) return false;
  if (left.text !== undefined || right.text !== undefined) return left.text === right.text;
  return left.size === right.size && left.mtimeMs === right.mtimeMs;
}

/**
 * Remove `file` only if it is still the file observed as `judged`. The rename
 * is atomic, so exactly one caller gets the file; one that turns out to be
 * different is linked back. Returns true only when this call removed it.
 */
export async function removeIfUnchanged(file: string, judged: LockFileState): Promise<boolean> {
  if (judged.directory) return false;
  const aside = `${file}.${randomUUID()}.aside`;
  try {
    await rename(file, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  try {
    const held = await readState(aside);
    if (held !== undefined && sameFile(held, judged)) return true;
    try {
      await link(aside, file);
    } catch (error) {
      // Residual: another process created the file in the instant it was
      // aside. Only reachable when two breakers disagree about one file.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return false;
  } finally {
    await unlinkIfPresent(aside);
  }
}

/** Remove the break marker if it is stale. */
async function clearStaleMarker(directory: string, starts: StartCache): Promise<void> {
  const marker = path.join(directory, BREAK_MARKER);
  const state = await readState(marker);
  if (state !== undefined && await isStale(state, starts)) await removeIfUnchanged(marker, state);
}

/**
 * Break the lock if it is (still) stale, one breaker at a time. Returns true
 * only when this call removed the lock.
 */
async function breakIfStale(directory: string, starts: StartCache): Promise<boolean> {
  const lock = path.join(directory, SOURCE_LOCK);
  const marker = path.join(directory, BREAK_MARKER);
  const mine = await newOwner();
  if (!await createExclusive(marker, mine)) {
    // Another breaker is at work, or died here; a dead one's marker is cleared.
    await clearStaleMarker(directory, starts);
    return false;
  }
  const markerState = await readState(marker);
  try {
    const state = await readState(lock);
    if (state === undefined || !await isStale(state, starts)) return false;
    await testOnlySourceLockIo.afterStaleJudgement?.();
    return await removeIfUnchanged(lock, state);
  } finally {
    if (markerState !== undefined) await removeIfUnchanged(marker, markerState);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Hold the source lock. Resolves with its release function. */
export async function acquireSourceLock(directory: string): Promise<() => Promise<void>> {
  const lock = path.join(directory, SOURCE_LOCK);
  const deadline = Date.now() + sourceLockTiming.waitMs;
  const starts: StartCache = new Map();
  for (let delay = 1; ; delay = Math.min(delay * 2, 50)) {
    const owner = await newOwner();
    if (await createExclusive(lock, owner)) return holdLock(lock, owner);
    if (Date.now() > deadline) throw snapshotStoreFailure("store-busy");
    const state = await readState(lock);
    // Retry at once only when the lock went away, never on a lock that stayed.
    if (state === undefined) continue;
    if (await isStale(state, starts) && await breakIfStale(directory, starts)) continue;
    await sleep(delay);
  }
}

async function holdLock(lock: string, owner: string): Promise<() => Promise<void>> {
  const held = await readState(lock);
  const heartbeat = setInterval(() => {
    void readState(lock).then(async (state) => {
      if (state !== undefined && state.text === owner) {
        const now = new Date();
        await utimes(lock, now, now);
      }
    }).catch(() => undefined);
  }, sourceLockTiming.heartbeatMs);
  heartbeat.unref();
  return async () => {
    clearInterval(heartbeat);
    // The heartbeat changes the mtime, so compare the current file's contents.
    const current = await readState(lock);
    if (held !== undefined && current !== undefined && current.text === owner && current.ino === held.ino) {
      await removeIfUnchanged(lock, current);
    }
  };
}

/**
 * While holding the lock: remove break markers and aside files left by
 * breakers that died. A live breaker's aside file exists for an instant, so
 * only aside files older than the stale ceiling are removed.
 */
export async function removeLockLeftovers(directory: string): Promise<void> {
  await clearStaleMarker(directory, new Map());
  for (const name of await readdir(directory)) {
    if (!ASIDE.test(name)) continue;
    const state = await readState(path.join(directory, name));
    if (state !== undefined && !state.directory && state.ageMs > sourceLockTiming.staleMs) {
      await unlinkIfPresent(path.join(directory, name));
    }
  }
}
