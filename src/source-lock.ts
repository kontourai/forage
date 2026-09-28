/**
 * The per-source write lock of the filesystem snapshot store.
 *
 * Every put and every prune of one source holds this lock for its whole
 * critical section, across processes. Readers never take it.
 *
 * The lock is a file created exclusively (`O_EXCL`) in the source directory.
 * It records its owner's host, pid, process start time, and a unique token.
 * The owner refreshes the file's mtime every `heartbeatMs` while it holds the
 * lock. A lock is stale, and may be broken, when:
 *
 * - its file has not been refreshed for `staleMs` (the hard ceiling; the only
 *   rule for an owner on another host, and for an empty lock whose owner died
 *   between creating and writing it);
 * - its owner is on this host and that pid is not running; or
 * - that pid is running but started at a different time, i.e. the owner died
 *   and its pid was reused by an unrelated process.
 *
 * Breakers take turns through an exclusive `source.lock.break` marker, which
 * obeys the same staleness rules. A file is only ever removed if it still holds
 * the exact contents that were judged stale: it is renamed aside (only one
 * caller can get it) and linked back if it turns out to be different.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, lstat, open, readdir, readFile, rename, unlink, utimes } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { snapshotStoreFailure } from "./snapshot-store-errors.js";

export const SOURCE_LOCK = "source.lock";
const BREAK_MARKER = "source.lock.break";
const ASIDE = /^source\.lock(?:\.break)?\.[0-9a-f-]{36}\.aside$/;

/** @internal Lock timings. Tests shorten them; production code never changes them. */
export const sourceLockTiming = {
  /** Hard ceiling: a lock not refreshed for this long is stale whatever its owner. */
  staleMs: 60_000,
  /** How often a holder refreshes its lock. */
  heartbeatMs: 10_000,
  /** How long an acquirer waits before failing with `store-busy`; longer than `staleMs`. */
  waitMs: 90_000,
};

interface LockOwner {
  host: string;
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

let ownStart: Promise<string | undefined> | undefined;

async function newOwner(): Promise<string> {
  ownStart ??= processStartIdentity(process.pid);
  const owner: LockOwner = { host: hostname(), pid: process.pid, start: (await ownStart) ?? null, token: randomUUID() };
  return JSON.stringify(owner);
}

function parseOwner(text: string): LockOwner | undefined {
  try {
    const value = JSON.parse(text) as Partial<LockOwner>;
    return typeof value.host === "string" && Number.isSafeInteger(value.pid) &&
      (value.start === null || typeof value.start === "string")
      ? value as LockOwner
      : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a lock or break marker with these contents and age may be removed. */
export async function isStale(text: string, ageMs: number): Promise<boolean> {
  if (ageMs > sourceLockTiming.staleMs) return true;
  const owner = parseOwner(text);
  // Empty or half-written: its writer is mid-write, or died there; only age can tell.
  if (owner === undefined || owner.host !== hostname()) return false;
  if (!processIsAlive(owner.pid)) return true;
  if (owner.start === null) return false;
  const current = await processStartIdentity(owner.pid);
  return current !== undefined && current !== owner.start;
}

async function readState(file: string): Promise<{ text: string; ageMs: number } | undefined> {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > 4096) return { text: "", ageMs: Date.now() - stat.mtimeMs };
    return { text: await readFile(file, "utf8"), ageMs: Date.now() - stat.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function unlinkIfPresent(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function createExclusive(file: string, contents: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(file, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    await handle.writeFile(contents, "utf8");
  } finally {
    await handle.close();
  }
  return true;
}

/**
 * Remove `file` only if it still holds `expected`. The rename is atomic, so
 * exactly one caller gets the file; one that turns out to be different is
 * linked back.
 */
export async function removeIfUnchanged(file: string, expected: string): Promise<void> {
  const aside = `${file}.${randomUUID()}.aside`;
  try {
    await rename(file, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    if (await readFile(aside, "utf8") === expected) return;
    try {
      await link(aside, file);
    } catch (error) {
      // Residual: another process created the file in the instant it was
      // aside. Only reachable when two breakers disagree about one file.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    await unlinkIfPresent(aside);
  }
}

/** Remove the break marker if it is stale. */
async function clearStaleMarker(directory: string): Promise<void> {
  const marker = path.join(directory, BREAK_MARKER);
  const state = await readState(marker);
  if (state !== undefined && await isStale(state.text, state.ageMs)) await removeIfUnchanged(marker, state.text);
}

/** Break the lock if it is (still) stale, one breaker at a time. */
async function breakIfStale(directory: string): Promise<void> {
  const lock = path.join(directory, SOURCE_LOCK);
  const marker = path.join(directory, BREAK_MARKER);
  const mine = await newOwner();
  if (!await createExclusive(marker, mine)) {
    await clearStaleMarker(directory);
    return;
  }
  try {
    const state = await readState(lock);
    if (state !== undefined && await isStale(state.text, state.ageMs)) await removeIfUnchanged(lock, state.text);
  } finally {
    await removeIfUnchanged(marker, mine);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Hold the source lock. Resolves with its release function. */
export async function acquireSourceLock(directory: string): Promise<() => Promise<void>> {
  const lock = path.join(directory, SOURCE_LOCK);
  const deadline = Date.now() + sourceLockTiming.waitMs;
  for (let delay = 1; ; delay = Math.min(delay * 2, 50)) {
    const owner = await newOwner();
    if (await createExclusive(lock, owner)) {
      const heartbeat = setInterval(() => {
        void readState(lock).then(async (state) => {
          if (state?.text === owner) {
            const now = new Date();
            await utimes(lock, now, now);
          }
        }).catch(() => undefined);
      }, sourceLockTiming.heartbeatMs);
      heartbeat.unref();
      return async () => {
        clearInterval(heartbeat);
        await removeIfUnchanged(lock, owner);
      };
    }
    const state = await readState(lock);
    if (state === undefined) continue;
    if (await isStale(state.text, state.ageMs)) {
      await breakIfStale(directory);
      continue;
    }
    if (Date.now() > deadline) throw snapshotStoreFailure("store-busy");
    await sleep(delay);
  }
}

/**
 * While holding the lock: remove break markers and aside files left by
 * breakers that died. A live breaker's aside file exists for an instant, so
 * only aside files older than the stale ceiling are removed.
 */
export async function removeLockLeftovers(directory: string): Promise<void> {
  await clearStaleMarker(directory);
  for (const name of await readdir(directory)) {
    if (!ASIDE.test(name)) continue;
    const state = await readState(path.join(directory, name));
    if (state !== undefined && state.ageMs > sourceLockTiming.staleMs) await unlinkIfPresent(path.join(directory, name));
  }
}
