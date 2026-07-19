/** Filesystem and in-memory stores lifted from traverse/fetch/snapshot-store.ts. */
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import type { FetchResult } from "./internal-types.js";
import { canonicalDurableSnapshot, snapshotEnvelopeDigest } from "./provenance.js";
import type {
  ExactSnapshotLookupResult,
  ExactSnapshotStore,
  Snapshot,
  SnapshotLookup,
  SnapshotStore,
} from "./types.js";

const MAX_SNAPSHOT_FILE_BYTES = 96 * 1024 * 1024;
const MAX_HISTORY_FILES = 10_000;
const MAX_LOOKUP_FIELD_LENGTH = 1024 * 1024;
const MAX_SOURCE_ID_LENGTH = 1024;
const MAX_URL_LENGTH = 8 * 1024;
const MAX_FETCHED_AT_LENGTH = 256;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function sourceDirName(sourceId: string): string {
  const safe =
    sourceId
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "source";
  const discriminator = createHash("sha256")
    .update(sourceId, "utf8")
    .digest("hex")
    .slice(0, 8);
  return `${safe}-${discriminator}`;
}

function snapshotFileName(snapshot: Snapshot): string {
  const timestamp = snapshot.fetchedAt
    .replace(/[^0-9A-Za-z._-]/g, "-")
    .slice(0, 80) || "snapshot";
  return `${timestamp}-${snapshotEnvelopeDigest(snapshot)}.json`;
}

function snapshotFileNameFromLookup(reference: SnapshotLookup): string | undefined {
  if (reference.snapshotDigest === undefined) return undefined;
  const timestamp = reference.fetchedAt
    .replace(/[^0-9A-Za-z._-]/g, "-")
    .slice(0, 80) || "snapshot";
  return `${timestamp}-${reference.snapshotDigest}.json`;
}

function releasedSnapshotFileName(reference: SnapshotLookup): string | undefined {
  const timestamp = reference.fetchedAt.replace(/[^0-9A-Za-z._-]/g, "-");
  const filename = `${timestamp}-${reference.bodyHash.slice(0, 12)}.json`;
  return Buffer.byteLength(filename, "utf8") <= 255 ? filename : undefined;
}

function assertExactLookup(reference: SnapshotLookup): void {
  const envelope = reference?.snapshotDigest !== undefined;
  const sourceIdLimit = envelope ? MAX_SOURCE_ID_LENGTH : MAX_LOOKUP_FIELD_LENGTH;
  const urlLimit = envelope ? MAX_URL_LENGTH : MAX_LOOKUP_FIELD_LENGTH;
  const fetchedAtLimit = envelope ? MAX_FETCHED_AT_LENGTH : MAX_LOOKUP_FIELD_LENGTH;
  if (
    typeof reference !== "object" ||
    reference === null ||
    typeof reference.sourceId !== "string" ||
    !reference.sourceId ||
    reference.sourceId.length > sourceIdLimit ||
    typeof reference.url !== "string" ||
    !reference.url ||
    reference.url.length > urlLimit ||
    typeof reference.fetchedAt !== "string" ||
    !reference.fetchedAt ||
    reference.fetchedAt.length > fetchedAtLimit ||
    typeof reference.bodyHash !== "string" ||
    !SHA256_PATTERN.test(reference.bodyHash) ||
    (reference.snapshotDigest !== undefined &&
      (typeof reference.snapshotDigest !== "string" ||
        !SHA256_PATTERN.test(reference.snapshotDigest)))
  ) {
    throw new TypeError("snapshot lookup has an invalid exact identity");
  }
}

function exactLookupMatches(snapshot: Snapshot, reference: SnapshotLookup): boolean {
  if (reference.snapshotDigest === undefined) {
    const body = typeof snapshot.body === "string"
      ? Buffer.from(snapshot.body, "utf8")
      : snapshot.body;
    if (!(body instanceof Uint8Array) ||
      createHash("sha256").update(body).digest("hex") !== snapshot.bodyHash) {
      throw new Error("snapshot store record body does not match its digest");
    }
  } else {
    canonicalDurableSnapshot(snapshot);
  }
  return snapshot.sourceId === reference.sourceId &&
    snapshot.url === reference.url &&
    snapshot.bodyHash === reference.bodyHash &&
    snapshot.fetchedAt === reference.fetchedAt &&
    (reference.snapshotDigest === undefined ||
      snapshotEnvelopeDigest(snapshot) === reference.snapshotDigest);
}

function snapshotIdentityDigest(reference: SnapshotLookup): string {
  return createHash("sha256")
    .update(JSON.stringify([
      reference.sourceId,
      reference.url,
      reference.bodyHash,
      reference.fetchedAt,
    ]))
    .digest("hex");
}

async function readBoundedRegularFile(file: string, maxBytes: number): Promise<string | undefined> {
  let pathStat;
  try {
    pathStat = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.size > maxBytes) {
    throw new Error("snapshot store entry is not a bounded regular file");
  }
  let handle;
  try {
    handle = await open(file, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const handleStat = await handle.stat();
    if (
      !handleStat.isFile() ||
      handleStat.size > maxBytes ||
      handleStat.dev !== pathStat.dev ||
      handleStat.ino !== pathStat.ino
    ) {
      throw new Error("snapshot store entry changed during validation");
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes - total + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error("snapshot store entry grew beyond its limit");
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function ensureRealDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("snapshot store directory must be a real directory");
  }
}

async function createImmutableFile(file: string, contents: string): Promise<boolean> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (error) {
    try {
      await handle?.close();
    } catch {
      // Cleanup below remains best-effort; the original failure is authoritative.
    }
    try {
      await unlink(temporary);
    } catch {
      // An abandoned sibling temp is ignored by every store reader.
    }
    throw error;
  }

  let installed = false;
  try {
    await link(temporary, file);
    installed = true;
    const directory = await open(path.dirname(file), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    try {
      await unlink(temporary);
    } catch (error) {
      if (!installed && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // A committed final file remains authoritative; an orphan temp is harmless.
    }
  }
}

async function writeIdentityIndex(file: string, filename: string): Promise<void> {
  if (await createImmutableFile(file, filename)) return;
  const existing = await readBoundedRegularFile(file, 512);
  if (existing === undefined || !/^[0-9A-Za-z._-]+-[a-f0-9]{64}\.json$/.test(existing.trim())) {
    throw new Error("snapshot identity index is invalid");
  }
}

function capacitySlotStart(filename: string, maxHistoryFiles: number): number {
  const prefix = createHash("sha256").update(filename, "utf8").digest("hex").slice(0, 12);
  return Number.parseInt(prefix, 16) % maxHistoryFiles;
}

async function reserveCapacitySlot(
  indexDirectory: string,
  filename: string,
  maxHistoryFiles: number,
): Promise<void> {
  const start = capacitySlotStart(filename, maxHistoryFiles);
  for (let offset = 0; offset < maxHistoryFiles; offset += 1) {
    const slot = (start + offset) % maxHistoryFiles;
    const file = path.join(indexDirectory, `${slot}.txt`);
    if (await createImmutableFile(file, filename)) return;
    const existing = await readBoundedRegularFile(file, 512);
    if (existing === filename) return;
  }
  throw new Error(`snapshot history exceeds ${maxHistoryFiles} records`);
}

async function ensureCapacityIndex(
  directory: string,
  maxHistoryFiles: number,
): Promise<string> {
  const indexDirectory = path.join(directory, "capacity-index");
  await ensureRealDirectory(indexDirectory);
  const configuredMax = String(maxHistoryFiles);
  const maxFile = path.join(indexDirectory, "max-history-files.txt");
  if (!await createImmutableFile(maxFile, configuredMax)) {
    const existing = await readBoundedRegularFile(maxFile, 32);
    if (existing !== configuredMax) {
      throw new Error("maxHistoryFiles cannot change after filesystem store initialization");
    }
  }

  const initialized = path.join(indexDirectory, "initialized.txt");
  if (await readBoundedRegularFile(initialized, 16) !== "1") {
    const records = (await readdir(directory))
      .filter((name) => name.endsWith(".json"))
      .sort();
    if (records.length > maxHistoryFiles) {
      throw new Error(`snapshot history exceeds ${maxHistoryFiles} records`);
    }
    for (const filename of records) {
      await reserveCapacitySlot(indexDirectory, filename, maxHistoryFiles);
    }
    await createImmutableFile(initialized, "1");
  }
  return indexDirectory;
}

async function readSnapshotFile(file: string): Promise<Snapshot | undefined> {
  const text = await readBoundedRegularFile(file, MAX_SNAPSHOT_FILE_BYTES);
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = fromDiskShape(JSON.parse(text));
  } catch (error) {
    throw new Error("snapshot store record is malformed", { cause: error });
  }
  if (!isSnapshot(parsed)) throw new Error("snapshot store record has an invalid shape");
  return parsed;
}

function toDiskShape(snapshot: Snapshot): Record<string, unknown> {
  const durable = canonicalDurableSnapshot(snapshot);
  if (!(durable.body instanceof Uint8Array)) {
    return durable as unknown as Record<string, unknown>;
  }
  const { body, ...rest } = durable;
  return { ...rest, bodyBase64: Buffer.from(body).toString("base64") };
}

function fromDiskShape(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  if (typeof record.bodyBase64 !== "string") return value;
  const { bodyBase64, ...rest } = record;
  return {
    ...rest,
    body: new Uint8Array(Buffer.from(bodyBase64, "base64")),
  };
}

function isSnapshot(value: unknown): value is Snapshot {
  if (typeof value !== "object" || value === null) return false;
  const snapshot = value as Record<string, unknown>;
  return (
    typeof snapshot.sourceId === "string" &&
    typeof snapshot.url === "string" &&
    typeof snapshot.status === "number" &&
    typeof snapshot.fetchedAt === "string" &&
    (typeof snapshot.body === "string" ||
      snapshot.body instanceof Uint8Array) &&
    typeof snapshot.bodyHash === "string"
  );
}

function sortSnapshots(snapshots: Snapshot[]): Snapshot[] {
  return snapshots.sort((left, right) =>
    left.fetchedAt === right.fetchedAt
      ? left.bodyHash === right.bodyHash
        ? compareDescending(snapshotEnvelopeDigest(left), snapshotEnvelopeDigest(right))
        : compareDescending(left.bodyHash, right.bodyHash)
      : compareDescending(left.fetchedAt, right.fetchedAt),
  );
}

function compareDescending(left: string, right: string): number {
  return left < right ? 1 : left > right ? -1 : 0;
}

export interface FilesystemSnapshotStoreOptions {
  root: string;
  /** Maximum JSON record files retained per source directory. Defaults to 10,000. */
  maxHistoryFiles?: number;
}

function resolveMaxHistoryFiles(value: number | undefined): number {
  if (value === undefined) return MAX_HISTORY_FILES;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_HISTORY_FILES) {
    throw new TypeError(`maxHistoryFiles must be an integer from 1 to ${MAX_HISTORY_FILES}`);
  }
  return value;
}

async function readAllSnapshots(
  root: string,
  sourceId: string,
  maxHistoryFiles: number,
): Promise<Snapshot[]> {
  const directory = path.join(root, sourceDirName(sourceId));
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records = names.filter((name) => name.endsWith(".json"));
  if (records.length > maxHistoryFiles) {
    throw new Error(`snapshot history exceeds ${maxHistoryFiles} records`);
  }
  const snapshots = new Map<string, Snapshot>();
  for (const name of records) {
    try {
      const parsed = await readSnapshotFile(path.join(directory, name));
      if (parsed === undefined) continue;
      const durable = canonicalDurableSnapshot(parsed);
      if (durable.sourceId !== sourceId) continue;
      snapshots.set(snapshotEnvelopeDigest(durable), durable);
    } catch {
      // Malformed or foreign content does not poison the store.
    }
  }
  return sortSnapshots([...snapshots.values()]);
}

async function persistFilesystemSnapshot(
  root: string,
  snapshot: Snapshot,
  maxHistoryFiles: number,
): Promise<void> {
  const directory = path.join(root, sourceDirName(snapshot.sourceId));
  await ensureRealDirectory(directory);
  const filename = snapshotFileName(snapshot);
  const record = path.join(directory, filename);
  const serialized = JSON.stringify(toDiskShape(snapshot), null, 2);
  if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_FILE_BYTES) {
    throw new TypeError("serialized snapshot exceeds the filesystem store limit");
  }
  const capacityIndex = await ensureCapacityIndex(directory, maxHistoryFiles);
  await reserveCapacitySlot(capacityIndex, filename, maxHistoryFiles);
  if (!await createImmutableFile(record, serialized)) {
    const existing = await readSnapshotFile(record);
    if (existing === undefined || snapshotEnvelopeDigest(existing) !== snapshotEnvelopeDigest(snapshot)) {
      throw new Error("immutable snapshot record conflicts with the supplied capture");
    }
  }
  const identityIndex = path.join(directory, "identity-index");
  await ensureRealDirectory(identityIndex);
  await writeIdentityIndex(
    path.join(identityIndex, `${snapshotIdentityDigest(snapshot)}.txt`),
    filename,
  );
}

async function findExactFilesystemSnapshot(
  root: string,
  reference: SnapshotLookup,
): Promise<ExactSnapshotLookupResult> {
  assertExactLookup(reference);
  const directory = path.join(root, sourceDirName(reference.sourceId));
  let directoryStat;
  try {
    directoryStat = await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw error;
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("snapshot source directory is invalid");
  }
  let filename = snapshotFileNameFromLookup(reference);
  if (filename === undefined) {
    const index = path.join(directory, "identity-index", `${snapshotIdentityDigest(reference)}.txt`);
    const indexText = await readBoundedRegularFile(index, 512);
    if (indexText === undefined) {
      filename = releasedSnapshotFileName(reference);
      if (filename === undefined) return { kind: "missing" };
    } else {
      filename = indexText.trim();
      if (!/^[0-9A-Za-z._-]+-[a-f0-9]{64}\.json$/.test(filename)) {
        throw new Error("snapshot identity index is invalid");
      }
    }
  }
  const snapshot = await readSnapshotFile(path.join(directory, filename));
  if (snapshot === undefined) return { kind: "missing" };
  return exactLookupMatches(snapshot, reference)
    ? { kind: "found", snapshot }
    : { kind: "mismatch" };
}

export function createFilesystemSnapshotStore(
  options: FilesystemSnapshotStoreOptions,
): ExactSnapshotStore {
  const root = path.resolve(options.root);
  const maxHistoryFiles = resolveMaxHistoryFiles(options.maxHistoryFiles);

  return {
    put: (snapshot) => persistFilesystemSnapshot(root, snapshot, maxHistoryFiles),
    async latest(sourceId) {
      return (await readAllSnapshots(root, sourceId, maxHistoryFiles))[0];
    },
    async get(sourceId, bodyHash) {
      return (await readAllSnapshots(root, sourceId, maxHistoryFiles)).find(
        (snapshot) =>
          snapshot.bodyHash === bodyHash ||
          snapshot.bodyHash.startsWith(bodyHash),
      );
    },
    list: (sourceId) => readAllSnapshots(root, sourceId, maxHistoryFiles),
    findExact: (reference) => findExactFilesystemSnapshot(root, reference),
  };
}

function cloneSnapshot(snapshot: Snapshot): Snapshot {
  return canonicalDurableSnapshot(snapshot);
}

export function createInMemorySnapshotStore(): ExactSnapshotStore {
  const bySource = new Map<string, Snapshot[]>();
  const byIdentity = new Map<string, Snapshot>();
  const byEnvelope = new Map<string, Snapshot>();
  const sorted = (sourceId: string) =>
    sortSnapshots([...(bySource.get(sourceId) ?? [])]);
  return {
    async put(snapshot) {
      const snapshots = bySource.get(snapshot.sourceId) ?? [];
      const stored = cloneSnapshot(snapshot);
      snapshots.push(stored);
      bySource.set(snapshot.sourceId, snapshots);
      byIdentity.set(snapshotIdentityDigest(stored), stored);
      byEnvelope.set(snapshotEnvelopeDigest(stored), stored);
    },
    async latest(sourceId) {
      const snapshot = sorted(sourceId)[0];
      return snapshot ? cloneSnapshot(snapshot) : undefined;
    },
    async get(sourceId, bodyHash) {
      const snapshot = sorted(sourceId).find(
        (candidate) =>
          candidate.bodyHash === bodyHash ||
          candidate.bodyHash.startsWith(bodyHash),
      );
      return snapshot ? cloneSnapshot(snapshot) : undefined;
    },
    async list(sourceId) {
      return sorted(sourceId).map(cloneSnapshot);
    },
    async findExact(reference) {
      assertExactLookup(reference);
      const snapshot = reference.snapshotDigest === undefined
        ? byIdentity.get(snapshotIdentityDigest(reference))
        : byEnvelope.get(reference.snapshotDigest);
      if (snapshot === undefined) return { kind: "missing" };
      return exactLookupMatches(snapshot, reference)
        ? { kind: "found", snapshot: cloneSnapshot(snapshot) }
        : { kind: "mismatch" };
    },
  };
}

export async function replaySource(
  store: SnapshotStore,
  sourceId: string,
): Promise<FetchResult> {
  try {
    const snapshot = await store.latest(sourceId);
    if (!snapshot) {
      return {
        error: {
          kind: "no-snapshot",
          message: `no snapshot stored for sourceId "${sourceId}"`,
        },
      };
    }
    return { snapshot };
  } catch (error) {
    return {
      error: {
        kind: "no-snapshot",
        message: `snapshot replay failed for sourceId "${sourceId}" (${error instanceof Error ? error.message : String(error)})`,
      },
    };
  }
}
