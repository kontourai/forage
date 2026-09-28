/** Filesystem and in-memory stores lifted from traverse/fetch/snapshot-store.ts. */
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, opendir, readdir, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { types as utilTypes } from "node:util";
import type { FetchResult } from "./internal-types.js";
import { canonicalDurableSnapshot, snapshotEnvelopeDigest, snapshotHashInput } from "./provenance.js";
import { decodeTextBody } from "./text-body.js";
import {
  snapshotCorrupt,
  SnapshotHistoryFullError,
  snapshotStoreFailure,
  SnapshotStoreReadError,
} from "./snapshot-store-errors.js";
import type {
  ExactSnapshotLookupResult,
  ExactSnapshotStore,
  HeadWitnessComparisonResult,
  PrunableSnapshotStore,
  ReadVerifiedHeadResult,
  Snapshot,
  SnapshotLookup,
  SnapshotPruneOptions,
  SnapshotPruneResult,
  SnapshotStore,
  SourceHeadWitness,
  VerifiedHeadLimits,
  VerifiedHeadSnapshotStore,
} from "./types.js";

const MAX_SNAPSHOT_FILE_BYTES = 96 * 1024 * 1024;
const MAX_HISTORY_FILES = 10_000;
const MAX_LOOKUP_FIELD_LENGTH = 1024 * 1024;
const MAX_SOURCE_ID_LENGTH = 1024;
const MAX_URL_LENGTH = 8 * 1024;
const MAX_FETCHED_AT_LENGTH = 256;
// Head witnesses use finite owner budgets.  A caller can reduce, but never
// enlarge, these bounds.  The entry ceiling deliberately matches history.
const MAX_HEAD_INDEX_BYTES = 8 * 1024 * 1024;
const MAX_HEAD_VERIFIED_BODY_BYTES = MAX_SNAPSHOT_FILE_BYTES;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ENVELOPE_RECORD_FILE = /^[0-9A-Za-z._-]+-[a-f0-9]{64}\.json$/;
const RELEASED_RECORD_FILE = /^[0-9A-Za-z._-]+-[a-f0-9]{12}\.json$/;

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

// An envelope record whose filename timestamp is an ISO-8601 UTC instant with
// its ':' separators replaced by '-'. For such names, filename order equals
// `fetchedAt` string order, which is what lets `latest()` pick the head from
// directory names alone.
const ISO_RECORD_FILE = /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2}(?:\.\d{1,9})?Z)-[a-f0-9]{64}\.json$/;

/** The `fetchedAt` an ISO-shaped record name encodes, or undefined for any other name. */
function isoFetchedAtFromFileName(filename: string): string | undefined {
  const match = ISO_RECORD_FILE.exec(filename);
  return match === null ? undefined : `${match[1]}:${match[2]}:${match[3]}`;
}

/**
 * Keep ISO-shaped filenames unambiguous: a `fetchedAt` that sanitizes to an
 * ISO-shaped name must be exactly the instant that name encodes.
 */
function assertUnambiguousFetchedAt(snapshot: Snapshot): void {
  const encoded = isoFetchedAtFromFileName(snapshotFileName(snapshot));
  if (encoded !== undefined && encoded !== snapshot.fetchedAt) {
    throw new TypeError("snapshot fetchedAt looks like ISO-8601 but does not use its separators");
  }
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

function isReleasedSnapshotFileName(filename: string): boolean {
  return RELEASED_RECORD_FILE.test(filename);
}

function assertSnapshotFileIdentity(filename: string, snapshot: Snapshot): void {
  if (ENVELOPE_RECORD_FILE.test(filename) && filename !== snapshotFileName(snapshot)) {
    throw snapshotCorrupt("record-identity-mismatch");
  }
}

function snapshotDigestForStore(snapshot: Snapshot): string {
  return snapshotEnvelopeDigest(snapshot, snapshot.sourceId.length > MAX_SOURCE_ID_LENGTH);
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
    const input = snapshotHashInput(snapshot);
    const body = typeof input === "string" ? Buffer.from(input, "utf8") : input;
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

async function readBoundedRegularFile(
  file: string,
  maxBytes: number,
  required = false,
): Promise<string | undefined> {
  let pathStat;
  try {
    pathStat = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (!required) return undefined;
      throw snapshotStoreFailure("record-disappeared");
    }
    throw snapshotStoreFailure("read-failed");
  }
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw snapshotCorrupt("non-regular-entry");
  }
  if (pathStat.size > maxBytes) {
    throw snapshotStoreFailure("read-limit");
  }
  await testOnlySnapshotStoreIo.afterEntryStat?.(file);
  let handle;
  try {
    handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw snapshotStoreFailure("record-disappeared");
    }
    throw snapshotStoreFailure("read-failed");
  }
  try {
    let handleStat;
    try {
      handleStat = await handle.stat();
    } catch {
      throw snapshotStoreFailure("read-failed");
    }
    if (
      !handleStat.isFile() ||
      handleStat.size > maxBytes ||
      handleStat.dev !== pathStat.dev ||
      handleStat.ino !== pathStat.ino
    ) {
      throw snapshotStoreFailure("read-raced");
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes - total + 1));
      let bytesRead: number;
      try {
        ({ bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null));
      } catch {
        throw snapshotStoreFailure("read-failed");
      }
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw snapshotStoreFailure("read-limit");
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

export interface ImmutableFilePublicationFaults {
  afterTempSync?: (file: string) => void;
  afterLink?: (file: string) => void;
  beforeDirectorySync?: (file: string) => void;
}

async function syncParentDirectory(file: string, faults?: ImmutableFilePublicationFaults): Promise<void> {
  faults?.beforeDirectorySync?.(file);
  const directory = await open(path.dirname(file), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/** Internal crash-boundary primitive; not exported from the package root. */
export async function publishImmutableFile(
  file: string,
  contents: string,
  faults?: ImmutableFilePublicationFaults,
): Promise<boolean> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    faults?.afterTempSync?.(file);
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

  try {
    await link(temporary, file);
    faults?.afterLink?.(file);
    await syncParentDirectory(file, faults);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      await syncParentDirectory(file, faults);
      return false;
    }
    throw error;
  } finally {
    try {
      await unlink(temporary);
    } catch {
      // A committed final file remains authoritative; an orphan temp is harmless.
    }
  }
}

async function writeIdentityIndex(file: string, filename: string): Promise<void> {
  if (await publishImmutableFile(file, filename)) return;
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
    // A concurrent prune can free an occupied slot between the failed claim
    // and the read; claim it again rather than failing the put.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (await publishImmutableFile(file, filename)) return;
      await testOnlySnapshotStoreIo.afterSlotClaimConflict?.();
      let existing: string | undefined;
      try {
        existing = await readBoundedRegularFile(file, 512);
      } catch (error) {
        if (error instanceof SnapshotStoreReadError && error.reason === "record-disappeared") continue;
        throw error;
      }
      if (existing === undefined) continue;
      if (existing === filename) return;
      break;
    }
  }
  throw new SnapshotHistoryFullError(maxHistoryFiles);
}

async function ensureCapacityIndex(
  directory: string,
  maxHistoryFiles: number,
): Promise<string> {
  const indexDirectory = path.join(directory, "capacity-index");
  await ensureRealDirectory(indexDirectory);
  const configuredMax = String(maxHistoryFiles);
  const maxFile = path.join(indexDirectory, "max-history-files.txt");
  if (!await publishImmutableFile(maxFile, configuredMax)) {
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
      throw new SnapshotHistoryFullError(maxHistoryFiles);
    }
    for (const filename of records) {
      await reserveCapacitySlot(indexDirectory, filename, maxHistoryFiles);
    }
    await publishImmutableFile(initialized, "1");
  }
  return indexDirectory;
}

async function readSnapshotFile(
  file: string,
  required = false,
  releasedIdentity = false,
  maximumBytes = MAX_SNAPSHOT_FILE_BYTES,
): Promise<Snapshot | undefined> {
  const text = await readBoundedRegularFile(file, maximumBytes, required);
  if (text === undefined) return undefined;
  testOnlySnapshotStoreIo.onRecordRead?.();
  let parsed: unknown;
  try {
    parsed = fromDiskShape(JSON.parse(text));
  } catch {
    throw snapshotCorrupt("malformed-record");
  }
  if (!isSnapshot(parsed)) throw snapshotCorrupt("invalid-record");
  try {
    return canonicalDurableSnapshot(parsed, releasedIdentity);
  } catch {
    throw snapshotCorrupt("invalid-record");
  }
}

// Record formats on disk:
// - text, earlier format: `body` holds the decoded text; `bodyHash` is over its UTF-8.
// - binary: `bodyBase64` holds the bytes.
// - text, byte-hashed: `bodyBase64` holds the raw bytes and `declaredCharset`
//   (string or null) is present. The text is never stored; it is re-derived
//   from the bytes on every read, so a record cannot hold text and bytes that
//   disagree.
function toDiskShape(snapshot: Snapshot): Record<string, unknown> {
  const durable = canonicalDurableSnapshot(snapshot);
  if (durable.bytes !== undefined) {
    const { body: _text, bytes, ...rest } = durable;
    return { ...rest, bodyBase64: Buffer.from(bytes).toString("base64") };
  }
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
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(record.bodyBase64) ||
    Buffer.from(record.bodyBase64, "base64").toString("base64") !== record.bodyBase64
  ) throw new TypeError("snapshot binary body is not canonical base64");
  const { bodyBase64, ...rest } = record;
  const bytes = new Uint8Array(Buffer.from(bodyBase64, "base64"));
  if (!("declaredCharset" in record)) return { ...rest, body: bytes };
  if (record.declaredCharset !== null && typeof record.declaredCharset !== "string") {
    throw new TypeError("snapshot declaredCharset is invalid");
  }
  return {
    ...rest,
    body: decodeTextBody(bytes, record.declaredCharset).text,
    bytes,
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
        ? compareDescending(snapshotDigestForStore(left), snapshotDigestForStore(right))
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

type HeadOutcome = Exclude<ReadVerifiedHeadResult["kind"], "found">;

class HeadWitnessFailure extends Error {
  constructor(readonly kind: HeadOutcome) {
    super("source head cannot be verified");
  }
}

interface ResolvedHeadLimits {
  maxEntries: number;
  maxIndexBytes: number;
  maxVerifiedBodyBytes: number;
}

interface HeadOperationLedger {
  remainingIndexBytes: number;
}

interface EntryMetadata {
  dev: string;
  ino: string;
  size: string;
  ctimeNs: string;
  mtimeNs: string;
}

interface HeadFingerprint {
  root: EntryMetadata;
  source: EntryMetadata;
  records: readonly [string, EntryMetadata][];
  capacity: readonly [string, EntryMetadata, string][];
  identity: readonly [string, EntryMetadata, string][];
  capacityDirectory: EntryMetadata;
  identityDirectory: EntryMetadata;
  digest: string;
}

/** @internal Test-only record-read spy; deliberately not re-exported by any package surface. */
export const testOnlySnapshotStoreIo = {
  onRecordRead: undefined as undefined | (() => void),
  /** Runs after a put fails to claim a slot and before it reads the slot's owner. */
  afterSlotClaimConflict: undefined as undefined | (() => void | Promise<void>),
  /** Runs between a bounded read's lstat and its open. */
  afterEntryStat: undefined as undefined | ((file: string) => void | Promise<void>),
  /** Runs after prune has read the capacity index and before it removes anything. */
  afterPruneScan: undefined as undefined | (() => void | Promise<void>),
  /** Runs after a put has published its record and before it writes the identity entry. */
  beforePutIdentity: undefined as undefined | (() => void | Promise<void>),
};

/** @internal Test-only read spy; deliberately not re-exported by any package surface. */
export const testOnlyHeadWitnessIo = {
  onVerifiedRecordRead: undefined as undefined | (() => void),
  afterVerifiedRecordRead: undefined as undefined | (() => void | Promise<void>),
  beforeFinalMetadataFence: undefined as undefined | (() => void | Promise<void>),
  onMetadataLstat: undefined as undefined | (() => void),
  onIndexRead: undefined as undefined | ((bytes: number) => void),
};

function headFailureFrom(error: unknown): HeadOutcome {
  if (error instanceof HeadWitnessFailure) return error.kind;
  if (error instanceof SnapshotStoreReadError) {
    return error.code === "snapshot-corrupt" ? "corrupt" : "unavailable";
  }
  return "unavailable";
}

function resolveHeadLimits(input: VerifiedHeadLimits | undefined, maxHistoryFiles: number): ResolvedHeadLimits {
  // Copy scalar values synchronously so a caller cannot alter an in-flight
  // verification by mutating its options object.
  const supplied = input === undefined ? {} : input;
  if (typeof supplied !== "object" || supplied === null || Array.isArray(supplied)) {
    throw new HeadWitnessFailure("unsupported");
  }
  const value = (key: keyof ResolvedHeadLimits, ownerMaximum: number): number => {
    const candidate = supplied[key];
    if (candidate === undefined) return ownerMaximum;
    if (!Number.isSafeInteger(candidate) || candidate < 0 || candidate > ownerMaximum) {
      throw new HeadWitnessFailure("unsupported");
    }
    return candidate;
  };
  return {
    maxEntries: value("maxEntries", maxHistoryFiles),
    maxIndexBytes: value("maxIndexBytes", MAX_HEAD_INDEX_BYTES),
    maxVerifiedBodyBytes: value("maxVerifiedBodyBytes", MAX_HEAD_VERIFIED_BODY_BYTES),
  };
}

function reserveIndexBytes(ledger: HeadOperationLedger, bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > ledger.remainingIndexBytes) {
    throw new HeadWitnessFailure("unavailable");
  }
  ledger.remainingIndexBytes -= bytes;
}

function metadataFromStat(stat: {
  dev: bigint;
  ino: bigint;
  size: bigint;
  ctimeNs: bigint;
  mtimeNs: bigint;
}): EntryMetadata {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
    ctimeNs: String(stat.ctimeNs),
    mtimeNs: String(stat.mtimeNs),
  };
}

async function headDirectoryMetadata(directory: string, missing: "missing" | "unavailable" = "unavailable"):
  Promise<EntryMetadata | undefined> {
  let stat;
  try {
    stat = await lstat(directory, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && missing === "missing") return undefined;
    throw new HeadWitnessFailure("unavailable");
  }
  testOnlyHeadWitnessIo.onMetadataLstat?.();
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new HeadWitnessFailure("corrupt");
  return metadataFromStat(stat);
}

async function headFileMetadata(file: string): Promise<EntryMetadata> {
  let stat;
  try {
    stat = await lstat(file, { bigint: true });
  } catch {
    throw new HeadWitnessFailure("unavailable");
  }
  testOnlyHeadWitnessIo.onMetadataLstat?.();
  if (!stat.isFile() || stat.isSymbolicLink()) throw new HeadWitnessFailure("corrupt");
  return metadataFromStat(stat);
}

async function boundedDirectoryNames(directory: string, limit: number): Promise<string[]> {
  let handle;
  try {
    handle = await opendir(directory);
  } catch {
    throw new HeadWitnessFailure("unavailable");
  }
  const names: string[] = [];
  try {
    for await (const entry of handle) {
      names.push(entry.name);
      if (names.length > limit) throw new HeadWitnessFailure("unavailable");
    }
  } catch (error) {
    if (error instanceof HeadWitnessFailure) throw error;
    throw new HeadWitnessFailure("unavailable");
  }
  return names.sort();
}

async function readHeadIndexFile(file: string, metadata: EntryMetadata): Promise<string> {
  const maximum = Number(metadata.size);
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new HeadWitnessFailure("unavailable");
  try {
    const text = await readBoundedRegularFile(file, maximum, true);
    if (text === undefined) throw new HeadWitnessFailure("unavailable");
    testOnlyHeadWitnessIo.onIndexRead?.(Buffer.byteLength(text, "utf8"));
    return text;
  } catch (error) {
    if (error instanceof SnapshotStoreReadError) throw new HeadWitnessFailure(
      error.code === "snapshot-corrupt" ? "corrupt" : "unavailable",
    );
    if (error instanceof HeadWitnessFailure) throw error;
    throw new HeadWitnessFailure("unavailable");
  }
}

function sameMetadata(left: EntryMetadata, right: EntryMetadata): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.ctimeNs === right.ctimeNs && left.mtimeNs === right.mtimeNs;
}

async function assertFingerprintStillPresent(
  root: string,
  sourceDirectory: string,
  rootMetadata: EntryMetadata,
  sourceMetadata: EntryMetadata,
  capacityDirectory: EntryMetadata,
  identityDirectory: EntryMetadata,
  records: readonly [string, EntryMetadata][],
  capacity: readonly [string, EntryMetadata, string][],
  identity: readonly [string, EntryMetadata, string][],
): Promise<void> {
  const sameDirectory = async (file: string, expected: EntryMetadata) => {
    const current = await headDirectoryMetadata(file);
    if (current === undefined || !sameMetadata(current, expected)) throw new HeadWitnessFailure("unavailable");
  };
  const sameFile = async (file: string, expected: EntryMetadata) => {
    if (!sameMetadata(await headFileMetadata(file), expected)) throw new HeadWitnessFailure("unavailable");
  };
  // This closes the metadata-only comparison fence as well: directory entries,
  // index contents, and same-size rewrites cannot be mixed into one token.
  await sameDirectory(root, rootMetadata);
  await sameDirectory(sourceDirectory, sourceMetadata);
  await sameDirectory(path.join(sourceDirectory, "capacity-index"), capacityDirectory);
  await sameDirectory(path.join(sourceDirectory, "identity-index"), identityDirectory);
  for (const [name, metadata] of records) await sameFile(path.join(sourceDirectory, name), metadata);
  for (const [name, metadata] of capacity) {
    await sameFile(path.join(sourceDirectory, "capacity-index", name), metadata);
  }
  for (const [name, metadata] of identity) {
    await sameFile(path.join(sourceDirectory, "identity-index", name), metadata);
  }
}

function fingerprintDigest(value: Omit<HeadFingerprint, "digest">): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

async function fingerprintFilesystemHead(
  root: string,
  sourceId: string,
  maxHistoryFiles: number,
  limits: ResolvedHeadLimits,
  ledger: HeadOperationLedger,
): Promise<{ kind: "missing" } | { kind: "present"; fingerprint: HeadFingerprint }> {
  const rootMetadata = await headDirectoryMetadata(root, "missing");
  if (rootMetadata === undefined) return { kind: "missing" };
  const directory = path.join(root, sourceDirName(sourceId));
  const sourceMetadata = await headDirectoryMetadata(directory, "missing");
  if (sourceMetadata === undefined) return { kind: "missing" };

  const names = await boundedDirectoryNames(directory, limits.maxEntries + 3);
  const records = names.filter((name) => name.endsWith(".json"));
  if (records.length > limits.maxEntries) throw new HeadWitnessFailure("unavailable");
  if (records.length === 0) throw new HeadWitnessFailure("unavailable");
  for (const name of records) {
    // Released filename grammar is a known legacy format: it has no complete
    // currentness metadata, so do not mistake it for a transient failure.
    if (isReleasedSnapshotFileName(name)) throw new HeadWitnessFailure("unsupported");
    if (!ENVELOPE_RECORD_FILE.test(name)) throw new HeadWitnessFailure("corrupt");
  }
  if (names.length !== records.length + 2 || !names.includes("capacity-index") || !names.includes("identity-index")) {
    // A temporary, lock, reservation, or unrecognised sidecar means the
    // namespace is not an immutable witnessable state.
    throw new HeadWitnessFailure("unavailable");
  }
  const recordMetadata: [string, EntryMetadata][] = [];
  let totalRecordBytes = 0;
  for (const name of records) {
    const metadata = await headFileMetadata(path.join(directory, name));
    const size = Number(metadata.size);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_SNAPSHOT_FILE_BYTES) {
      throw new HeadWitnessFailure("unavailable");
    }
    totalRecordBytes += size;
    if (!Number.isSafeInteger(totalRecordBytes) || totalRecordBytes > limits.maxVerifiedBodyBytes) {
      throw new HeadWitnessFailure("unavailable");
    }
    recordMetadata.push([name, metadata]);
  }

  const capacityDirectory = await headDirectoryMetadata(path.join(directory, "capacity-index"));
  const identityDirectory = await headDirectoryMetadata(path.join(directory, "identity-index"));
  if (capacityDirectory === undefined || identityDirectory === undefined) throw new HeadWitnessFailure("unavailable");

  const collectIndexMetadata = async (
    indexDirectory: string,
    kind: "capacity" | "identity",
    maximumEntries: number,
  ): Promise<[string, EntryMetadata, string][]> => {
    const indexNames = await boundedDirectoryNames(indexDirectory, maximumEntries);
    const collected: [string, EntryMetadata, string][] = [];
    for (const name of indexNames) {
      const valid = kind === "capacity"
        ? name === "max-history-files.txt" || name === "initialized.txt" || /^(?:0|[1-9][0-9]*)\.txt$/.test(name)
        : /^[a-f0-9]{64}\.txt$/.test(name);
      if (!valid) throw new HeadWitnessFailure("unavailable");
      const metadata = await headFileMetadata(path.join(indexDirectory, name));
      collected.push([name, metadata, ""]);
    }
    return collected;
  };

  const capacity = await collectIndexMetadata(path.join(directory, "capacity-index"), "capacity", limits.maxEntries + 2);
  const identity = await collectIndexMetadata(path.join(directory, "identity-index"), "identity", limits.maxEntries);
  const indexBytes = [...capacity, ...identity].reduce((total, [, metadata]) => total + Number(metadata.size), 0);
  // Preflight both namespaces before allocating either one. The same ledger is
  // shared by capture's before and after fingerprints, so a caller's ceiling
  // is an operation bound rather than a per-pass suggestion.
  reserveIndexBytes(ledger, indexBytes);
  for (const entry of capacity) {
    entry[2] = await readHeadIndexFile(path.join(directory, "capacity-index", entry[0]), entry[1]);
  }
  for (const entry of identity) {
    entry[2] = await readHeadIndexFile(path.join(directory, "identity-index", entry[0]), entry[1]);
  }
  const capacityMap = new Map(capacity.map(([name, , text]) => [name, text.trim()]));
  if (capacityMap.get("max-history-files.txt") !== String(maxHistoryFiles) || capacityMap.get("initialized.txt") !== "1") {
    throw new HeadWitnessFailure("unsupported");
  }
  const reservationNames = [...capacityMap.keys()].filter((name) => /\.txt$/.test(name) && name !== "max-history-files.txt" && name !== "initialized.txt");
  const recordSet = new Set(records);
  if (reservationNames.length !== records.length || new Set(reservationNames.map((name) => capacityMap.get(name))).size !== records.length) {
    throw new HeadWitnessFailure("unavailable");
  }
  for (const name of reservationNames) {
    const slot = Number(name.slice(0, -4));
    if (!Number.isSafeInteger(slot) || slot < 0 || slot >= maxHistoryFiles || !recordSet.has(capacityMap.get(name)!)) {
      throw new HeadWitnessFailure("unavailable");
    }
  }
  if (identity.length !== records.length || new Set(identity.map(([, , text]) => text.trim())).size !== records.length) {
    throw new HeadWitnessFailure("unavailable");
  }
  for (const [, , text] of identity) {
    if (!recordSet.has(text.trim())) throw new HeadWitnessFailure("unavailable");
  }
  await testOnlyHeadWitnessIo.beforeFinalMetadataFence?.();
  await assertFingerprintStillPresent(
    root,
    directory,
    rootMetadata,
    sourceMetadata,
    capacityDirectory,
    identityDirectory,
    recordMetadata,
    capacity,
    identity,
  );
  const base = {
    root: rootMetadata,
    source: sourceMetadata,
    records: recordMetadata,
    capacity,
    identity,
    capacityDirectory,
    identityDirectory,
  };
  return { kind: "present", fingerprint: { ...base, digest: fingerprintDigest(base) } };
}

async function readAuthenticatedHead(
  root: string,
  sourceId: string,
  fingerprint: HeadFingerprint,
): Promise<{ head: Snapshot; snapshots: Map<string, Snapshot> }> {
  const snapshots = new Map<string, Snapshot>();
  const snapshotsByFilename = new Map<string, Snapshot>();
  for (const [name, metadata] of fingerprint.records) {
    const size = Number(metadata.size);
    const snapshot = await readSnapshotFile(path.join(root, sourceDirName(sourceId), name), true, false, size);
    testOnlyHeadWitnessIo.onVerifiedRecordRead?.();
    await testOnlyHeadWitnessIo.afterVerifiedRecordRead?.();
    if (snapshot === undefined) throw new HeadWitnessFailure("unavailable");
    if (snapshot.sourceId !== sourceId) throw new HeadWitnessFailure("corrupt");
    assertSnapshotFileIdentity(name, snapshot);
    const digest = snapshotDigestForStore(snapshot);
    if (snapshots.has(digest)) throw new HeadWitnessFailure("corrupt");
    snapshots.set(digest, snapshot);
    snapshotsByFilename.set(name, snapshot);
  }
  const identityMap = new Map(fingerprint.identity.map(([name, , text]) => [name.slice(0, -4), text.trim()]));
  for (const [name] of fingerprint.records) {
    const snapshot = snapshotsByFilename.get(name);
    if (snapshot === undefined || identityMap.get(snapshotIdentityDigest(snapshot)) !== name) {
      throw new HeadWitnessFailure("unavailable");
    }
  }
  const sorted = sortSnapshots([...snapshots.values()]);
  if (sorted.length === 0) throw new HeadWitnessFailure("unavailable");
  return { head: sorted[0], snapshots };
}

function exactHeadReference(snapshot: Snapshot): SnapshotLookup & { snapshotDigest: string } {
  return {
    sourceId: snapshot.sourceId,
    url: snapshot.url,
    bodyHash: snapshot.bodyHash,
    fetchedAt: snapshot.fetchedAt,
    snapshotDigest: snapshotEnvelopeDigest(snapshot),
  };
}

function headToken(
  fingerprint: HeadFingerprint,
  reference: SnapshotLookup & { snapshotDigest: string },
): string {
  return createHash("sha256")
    .update(JSON.stringify([
      "forage.source-head-witness/v1",
      fingerprint.root,
      fingerprint.source,
      fingerprint.digest,
      reference.sourceId,
      reference.url,
      reference.bodyHash,
      reference.fetchedAt,
      reference.snapshotDigest,
    ]), "utf8")
    .digest("hex");
}

function closedOwnDataRecord(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value) || utilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== expectedKeys.length || keys.some((key) =>
      typeof key !== "string" || !expectedKeys.includes(key))) return undefined;
    const copied: Record<string, unknown> = {};
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) {
        return undefined;
      }
      copied[key] = descriptor.value;
    }
    return copied;
  } catch {
    return undefined;
  }
}

function copyValidWitness(value: unknown): SourceHeadWitness | undefined {
  const witness = closedOwnDataRecord(value, ["format", "sourceId", "headSnapshotRef", "token"]);
  if (witness === undefined || witness.format !== "forage.source-head-witness/v1" ||
    typeof witness.sourceId !== "string" || typeof witness.token !== "string" ||
    !/^[a-f0-9]{64}$/.test(witness.token)) return undefined;
  const supplied = closedOwnDataRecord(
    witness.headSnapshotRef,
    ["sourceId", "url", "bodyHash", "fetchedAt", "snapshotDigest"],
  );
  if (supplied === undefined) return undefined;
  try {
    const reference: SnapshotLookup = {
      sourceId: supplied.sourceId as string,
      url: supplied.url as string,
      bodyHash: supplied.bodyHash as string,
      fetchedAt: supplied.fetchedAt as string,
      snapshotDigest: supplied.snapshotDigest as string | undefined,
    };
    assertExactLookup(reference);
    if (reference.snapshotDigest === undefined || reference.sourceId !== witness.sourceId) return undefined;
    return {
      format: "forage.source-head-witness/v1",
      sourceId: witness.sourceId,
      headSnapshotRef: reference as SnapshotLookup & { snapshotDigest: string },
      token: witness.token,
    };
  } catch {
    return undefined;
  }
}

/** Record filenames of one source, or undefined when the source has no directory. */
async function listRecordNames(
  directory: string,
  maxHistoryFiles: number,
): Promise<string[] | undefined> {
  let directoryStat;
  try {
    directoryStat = await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw snapshotStoreFailure("read-failed");
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw snapshotCorrupt("non-regular-entry");
  }
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    throw snapshotStoreFailure("read-failed");
  }
  const records = names.filter((name) => name.endsWith(".json"));
  if (records.length > maxHistoryFiles) {
    throw snapshotStoreFailure("read-limit");
  }
  return records;
}

async function readVerifiedRecord(directory: string, name: string, sourceId: string): Promise<Snapshot> {
  const durable = await readSnapshotFile(
    path.join(directory, name),
    true,
    isReleasedSnapshotFileName(name),
  );
  if (durable === undefined) throw snapshotStoreFailure("record-disappeared");
  if (durable.sourceId !== sourceId) throw snapshotCorrupt("foreign-source-record");
  assertSnapshotFileIdentity(name, durable);
  return durable;
}

/** Every record of a source, newest first, with the filenames that hold it. */
async function readAllSnapshotEntries(
  root: string,
  sourceId: string,
  maxHistoryFiles: number,
): Promise<{ snapshot: Snapshot; names: string[] }[]> {
  const directory = path.join(root, sourceDirName(sourceId));
  const records = await listRecordNames(directory, maxHistoryFiles);
  if (records === undefined) return [];
  const entries = new Map<string, { snapshot: Snapshot; names: string[] }>();
  for (const name of records) {
    const durable = await readVerifiedRecord(directory, name, sourceId);
    const digest = snapshotDigestForStore(durable);
    const existing = entries.get(digest);
    if (existing === undefined) entries.set(digest, { snapshot: durable, names: [name] });
    else existing.names.push(name);
  }
  const order = new Map(sortSnapshots([...entries.values()].map((entry) => entry.snapshot))
    .map((snapshot, index) => [snapshot, index]));
  return [...entries.values()].sort((left, right) => order.get(left.snapshot)! - order.get(right.snapshot)!);
}

async function readAllSnapshots(
  root: string,
  sourceId: string,
  maxHistoryFiles: number,
): Promise<Snapshot[]> {
  return (await readAllSnapshotEntries(root, sourceId, maxHistoryFiles)).map((entry) => entry.snapshot);
}

/**
 * The newest record, reading only the records whose filename carries the
 * newest timestamp. Falls back to reading every record when any filename is
 * not ISO-shaped (released-format names, non-ISO `fetchedAt` values), or when
 * a candidate's `fetchedAt` is not the instant its name encodes.
 */
async function readLatestSnapshot(
  root: string,
  sourceId: string,
  maxHistoryFiles: number,
): Promise<Snapshot | undefined> {
  const directory = path.join(root, sourceDirName(sourceId));
  const records = await listRecordNames(directory, maxHistoryFiles);
  if (records === undefined || records.length === 0) return undefined;
  let newest: string | undefined;
  let candidates: string[] = [];
  for (const name of records) {
    const fetchedAt = isoFetchedAtFromFileName(name);
    if (fetchedAt === undefined) return (await readAllSnapshots(root, sourceId, maxHistoryFiles))[0];
    if (newest === undefined || fetchedAt > newest) {
      newest = fetchedAt;
      candidates = [name];
    } else if (fetchedAt === newest) {
      candidates.push(name);
    }
  }
  const snapshots: Snapshot[] = [];
  for (const name of candidates) {
    const snapshot = await readVerifiedRecord(directory, name, sourceId);
    if (snapshot.fetchedAt !== newest) return (await readAllSnapshots(root, sourceId, maxHistoryFiles))[0];
    snapshots.push(snapshot);
  }
  return sortSnapshots(snapshots)[0];
}

async function persistFilesystemSnapshot(
  root: string,
  snapshot: Snapshot,
  maxHistoryFiles: number,
): Promise<void> {
  const directory = path.join(root, sourceDirName(snapshot.sourceId));
  await ensureRealDirectory(directory);
  const filename = snapshotFileName(snapshot);
  assertUnambiguousFetchedAt(snapshot);
  const record = path.join(directory, filename);
  const serialized = JSON.stringify(toDiskShape(snapshot), null, 2);
  if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_FILE_BYTES) {
    throw new TypeError("serialized snapshot exceeds the filesystem store limit");
  }
  const capacityIndex = await ensureCapacityIndex(directory, maxHistoryFiles);
  // A published record always holds a slot (put reserves before publishing;
  // prune removes the record before its slot). Skipping the probe for an
  // existing record matters once prune has freed slots: probing past a freed
  // slot would otherwise reserve a second slot for the same record.
  if (!await regularFileExists(record)) {
    await reserveCapacitySlot(capacityIndex, filename, maxHistoryFiles);
  }
  if (!await publishImmutableFile(record, serialized)) {
    const existing = await readSnapshotFile(record, true);
    if (existing === undefined) throw snapshotStoreFailure("record-disappeared");
    assertSnapshotFileIdentity(filename, existing);
    if (snapshotEnvelopeDigest(existing) !== snapshotEnvelopeDigest(snapshot)) {
      throw new Error("immutable snapshot record conflicts with the supplied capture");
    }
  }
  const identityIndex = path.join(directory, "identity-index");
  await ensureRealDirectory(identityIndex);
  const identityFile = path.join(identityIndex, `${snapshotIdentityDigest(snapshot)}.txt`);
  await testOnlySnapshotStoreIo.beforePutIdentity?.();
  await writeIdentityIndex(identityFile, filename);
  // A prune removes a record before its identity entry. If this record was
  // pruned after it was published, the entry just written names nothing.
  if (!await regularFileExists(record)) await unlinkIfPresent(identityFile);
}

async function regularFileExists(file: string): Promise<boolean> {
  try {
    return (await lstat(file)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
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

function assertPruneOptions(options: SnapshotPruneOptions): SnapshotLookup[] {
  if (
    typeof options !== "object" || options === null ||
    !Number.isSafeInteger(options.keepLast) || options.keepLast < 0 ||
    (options.keep !== undefined && !Array.isArray(options.keep))
  ) {
    throw new TypeError("prune requires a non-negative integer keepLast and an optional keep array");
  }
  const keep = (options.keep ?? []).map((reference) => ({ ...reference }));
  for (const reference of keep) assertExactLookup(reference);
  return keep;
}

function isKept(snapshot: Snapshot, keep: readonly SnapshotLookup[]): boolean {
  return keep.some((reference) =>
    snapshot.sourceId === reference.sourceId &&
    snapshot.url === reference.url &&
    snapshot.bodyHash === reference.bodyHash &&
    snapshot.fetchedAt === reference.fetchedAt &&
    (reference.snapshotDigest === undefined || snapshotDigestForStore(snapshot) === reference.snapshotDigest));
}

/** Split a newest-first history into what a retention rule keeps and removes. */
function selectPruneVictims<T>(
  newestFirst: readonly T[],
  snapshotOf: (entry: T) => Snapshot,
  keepLast: number,
  keep: readonly SnapshotLookup[],
): { retained: T[]; victims: T[] } {
  const retained: T[] = [];
  const victims: T[] = [];
  newestFirst.forEach((entry, index) => {
    // index 0 is the head, which is never removed.
    if (index === 0 || index < keepLast || isKept(snapshotOf(entry), keep)) retained.push(entry);
    else victims.push(entry);
  });
  return { retained, victims };
}

async function syncDirectoryIfPresent(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const PRUNE_LOCK = "prune.lock";
const PRUNE_LOCK_STEAL = "prune.lock.steal";
const PRUNE_LOCK_WAIT_MS = 30_000;
// A leftover temporary file is removed only when the process that wrote it is
// gone and it is older than this, so an in-flight write is never disturbed.
const LEFTOVER_MIN_AGE_MS = 60_000;
const TEMP_FILE = /\.([1-9][0-9]*)\.[0-9a-f-]{36}\.tmp$/;
const SLOT_FILE = /^(?:0|[1-9][0-9]*)\.txt$/;
const IDENTITY_FILE = /^[a-f0-9]{64}\.txt$/;

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function lockOwner(text: string | undefined): { host: string; pid: number } | undefined {
  try {
    const owner = JSON.parse(text ?? "") as { host?: unknown; pid?: unknown };
    return typeof owner.host === "string" && Number.isSafeInteger(owner.pid)
      ? { host: owner.host, pid: owner.pid as number }
      : undefined;
  } catch {
    return undefined;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Read a small lock file; one that disappears mid-read (its owner released it) reads as absent. */
async function readLockFile(file: string): Promise<string | undefined> {
  try {
    return await readBoundedRegularFile(file, 1024);
  } catch (error) {
    if (error instanceof SnapshotStoreReadError && error.reason === "record-disappeared") return undefined;
    throw error;
  }
}

/**
 * Remove a lock whose owner process on this host has exited. Only one process
 * may attempt this at a time (the steal marker is created exclusively), and the
 * lock is removed only if it still holds the dead owner's exact contents, which
 * include a unique token. Returns true when the caller should retry at once.
 */
async function breakStaleLock(directory: string): Promise<boolean> {
  const lock = path.join(directory, PRUNE_LOCK);
  const marker = path.join(directory, PRUNE_LOCK_STEAL);
  const stale = await readLockFile(lock);
  if (stale === undefined) return true;
  const owner = lockOwner(stale);
  if (owner === undefined || owner.host !== hostname() || processIsAlive(owner.pid)) return false;
  const claim = JSON.stringify({ host: hostname(), pid: process.pid });
  try {
    const handle = await open(marker, "wx", 0o600);
    try {
      await handle.writeFile(claim, "utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const other = lockOwner(await readLockFile(marker));
    if (other !== undefined && other.host === hostname() && !processIsAlive(other.pid)) {
      await unlinkIfPresent(marker);
      return true;
    }
    return false;
  }
  try {
    if (await readLockFile(lock) === stale) await unlinkIfPresent(lock);
  } finally {
    await unlinkIfPresent(marker);
  }
  return true;
}

/**
 * Serialize prunes of one source, across processes. Puts never take this lock:
 * only a prune frees slots, so with one prune at a time the slots a prune
 * scanned cannot be freed or reclaimed before it removes them.
 */
async function acquirePruneLock(directory: string): Promise<() => Promise<void>> {
  const lock = path.join(directory, PRUNE_LOCK);
  const contents = JSON.stringify({ host: hostname(), pid: process.pid, token: randomUUID() });
  const deadline = Date.now() + PRUNE_LOCK_WAIT_MS;
  for (let delay = 2; ; delay = Math.min(delay * 2, 50)) {
    // Published with its contents in one link, so the lock is never empty.
    if (await publishImmutableFile(lock, contents)) {
      return async () => {
        if (await readLockFile(lock) === contents) await unlinkIfPresent(lock);
      };
    }
    if (await breakStaleLock(directory)) continue;
    if (Date.now() > deadline) throw snapshotStoreFailure("store-busy");
    await sleep(delay);
  }
}

/** Remove temporary files whose writer has exited, in one store directory. */
async function removeDeadTemporaryFiles(directory: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    const match = TEMP_FILE.exec(name);
    if (match === null || processIsAlive(Number(match[1]))) continue;
    let stat;
    try {
      stat = await lstat(path.join(directory, name));
    } catch {
      continue;
    }
    if (stat.isFile() && Date.now() - stat.mtimeMs >= LEFTOVER_MIN_AGE_MS) {
      await unlinkIfPresent(path.join(directory, name));
    }
  }
}

/** Numeric slot files by the record they name. In-flight temporaries are not slots and are not counted. */
async function readCapacitySlots(capacityIndex: string, maxHistoryFiles: number): Promise<Map<string, string[]>> {
  let names: string[] = [];
  try {
    names = await readdir(capacityIndex);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const slots = names.filter((name) => SLOT_FILE.test(name));
  if (slots.length > maxHistoryFiles) throw snapshotStoreFailure("read-limit");
  const byRecord = new Map<string, string[]>();
  for (const slot of slots) {
    const recordName = await readBoundedRegularFile(path.join(capacityIndex, slot), 512);
    if (recordName === undefined) continue;
    byRecord.set(recordName, [...(byRecord.get(recordName) ?? []), slot]);
  }
  return byRecord;
}

/** Identity entries whose record no longer exists (a record is always published before its entry). */
async function removeOrphanIdentityEntries(directory: string, maxHistoryFiles: number): Promise<void> {
  const identityIndex = path.join(directory, "identity-index");
  let names: string[];
  try {
    names = (await readdir(identityIndex)).filter((name) => IDENTITY_FILE.test(name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (names.length > 2 * maxHistoryFiles) throw snapshotStoreFailure("read-limit");
  for (const name of names) {
    let recordName: string | undefined;
    try {
      recordName = (await readBoundedRegularFile(path.join(identityIndex, name), 512))?.trim();
    } catch (error) {
      // A put whose record was pruned removes its own entry; either way it is gone.
      if (error instanceof SnapshotStoreReadError && error.reason === "record-disappeared") continue;
      throw error;
    }
    if (recordName === undefined || !ENVELOPE_RECORD_FILE.test(recordName)) continue;
    if (!await regularFileExists(path.join(directory, recordName))) {
      await unlinkIfPresent(path.join(identityIndex, name));
    }
  }
}

/**
 * Remove records outside a retention rule, with their identity-index entry and
 * capacity slot, while holding the source's prune lock.
 *
 * Before scanning, it removes leftovers of interrupted operations: temporary
 * files of exited writers and identity entries that name no record. Per victim
 * the order is record, identity entry, slot, so an existing record always
 * holds a slot and a concurrent put can detect that its record was pruned.
 * After removal, a retained record that lacks its identity entry or slot (an
 * interrupted put, or a record re-put while it was being pruned) gets it back.
 */
async function pruneFilesystemSnapshots(
  root: string,
  sourceId: string,
  options: SnapshotPruneOptions,
  maxHistoryFiles: number,
): Promise<SnapshotPruneResult> {
  if (typeof sourceId !== "string" || !sourceId) throw new TypeError("prune requires a sourceId");
  const keep = assertPruneOptions(options);
  const directory = path.join(root, sourceDirName(sourceId));
  if (!await directoryExists(directory)) return { removed: 0, retained: 0 };
  const capacityIndex = path.join(directory, "capacity-index");
  const identityIndex = path.join(directory, "identity-index");
  const release = await acquirePruneLock(directory);
  try {
    for (const each of [directory, capacityIndex, identityIndex]) await removeDeadTemporaryFiles(each);
    await removeOrphanIdentityEntries(directory, maxHistoryFiles);

    const history = await readAllSnapshotEntries(root, sourceId, maxHistoryFiles);
    const { retained, victims } = selectPruneVictims(history, (entry) => entry.snapshot, options.keepLast, keep);
    const slotsByRecord = await readCapacitySlots(capacityIndex, maxHistoryFiles);
    await testOnlySnapshotStoreIo.afterPruneScan?.();

    for (const { snapshot, names } of victims) {
      for (const name of names) await unlinkIfPresent(path.join(directory, name));
      await unlinkIfPresent(path.join(identityIndex, `${snapshotIdentityDigest(snapshot)}.txt`));
      for (const name of names) {
        for (const slot of slotsByRecord.get(name) ?? []) await unlinkIfPresent(path.join(capacityIndex, slot));
      }
    }

    for (const { snapshot, names } of retained) {
      for (const name of names) {
        if (!ENVELOPE_RECORD_FILE.test(name)) continue;
        if (!slotsByRecord.has(name)) await reserveCapacitySlot(capacityIndex, name, maxHistoryFiles);
        const identityFile = path.join(identityIndex, `${snapshotIdentityDigest(snapshot)}.txt`);
        if (!await regularFileExists(identityFile)) {
          await ensureRealDirectory(identityIndex);
          await writeIdentityIndex(identityFile, name);
        }
      }
    }
    await syncDirectoryIfPresent(directory);
    await syncDirectoryIfPresent(identityIndex);
    await syncDirectoryIfPresent(capacityIndex);
    return { removed: victims.length, retained: retained.length };
  } finally {
    await release();
  }
}

async function directoryExists(directory: string): Promise<boolean> {
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw snapshotCorrupt("non-regular-entry");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
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
    throw snapshotStoreFailure("read-failed");
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw snapshotCorrupt("non-regular-entry");
  }
  let filename = snapshotFileNameFromLookup(reference);
  let indexedRecord = false;
  if (filename === undefined) {
    const index = path.join(directory, "identity-index", `${snapshotIdentityDigest(reference)}.txt`);
    const indexText = await readBoundedRegularFile(index, 512);
    if (indexText === undefined) {
      filename = releasedSnapshotFileName(reference);
      if (filename === undefined) return { kind: "missing" };
    } else {
      filename = indexText.trim();
      indexedRecord = true;
      if (!/^[0-9A-Za-z._-]+-[a-f0-9]{64}\.json$/.test(filename)) {
        throw snapshotCorrupt("invalid-identity-index");
      }
    }
  }
  const snapshot = await readSnapshotFile(
    path.join(directory, filename),
    indexedRecord,
    reference.snapshotDigest === undefined && isReleasedSnapshotFileName(filename),
  );
  if (snapshot === undefined) return { kind: "missing" };
  if (snapshot.sourceId !== reference.sourceId) throw snapshotCorrupt("foreign-source-record");
  assertSnapshotFileIdentity(filename, snapshot);
  return exactLookupMatches(snapshot, reference)
    ? { kind: "found", snapshot }
    : { kind: "mismatch" };
}

export function createFilesystemSnapshotStore(
  options: FilesystemSnapshotStoreOptions,
): VerifiedHeadSnapshotStore & PrunableSnapshotStore {
  const root = path.resolve(options.root);
  const maxHistoryFiles = resolveMaxHistoryFiles(options.maxHistoryFiles);

  const sourceSupported = (sourceId: unknown): sourceId is string =>
    typeof sourceId === "string" && sourceId.length > 0 && sourceId.length <= MAX_SOURCE_ID_LENGTH;

  const readVerifiedHead = async (
    sourceId: string,
    suppliedLimits?: VerifiedHeadLimits,
  ): Promise<ReadVerifiedHeadResult> => {
    if (!sourceSupported(sourceId)) return { kind: "unsupported" };
    try {
      const limits = resolveHeadLimits(suppliedLimits, maxHistoryFiles);
      const ledger: HeadOperationLedger = { remainingIndexBytes: limits.maxIndexBytes };
      const before = await fingerprintFilesystemHead(root, sourceId, maxHistoryFiles, limits, ledger);
      if (before.kind === "missing") return { kind: "missing" };
      const { head } = await readAuthenticatedHead(root, sourceId, before.fingerprint);
      const reference = exactHeadReference(head);
      try {
        assertExactLookup(reference);
      } catch {
        return { kind: "unsupported" };
      }
      const after = await fingerprintFilesystemHead(root, sourceId, maxHistoryFiles, limits, ledger);
      if (after.kind !== "present" || after.fingerprint.digest !== before.fingerprint.digest) {
        return { kind: "unavailable" };
      }
      const witness: SourceHeadWitness = {
        format: "forage.source-head-witness/v1",
        sourceId,
        headSnapshotRef: { ...reference },
        token: headToken(after.fingerprint, reference),
      };
      return { kind: "found", headSnapshotRef: { ...reference }, witness };
    } catch (error) {
      return { kind: headFailureFrom(error) };
    }
  };

  const compareHeadWitness = async (
    witness: SourceHeadWitness,
    suppliedLimits?: VerifiedHeadLimits,
  ): Promise<HeadWitnessComparisonResult> => {
    // Validate all untrusted witness fields before opening a store directory.
    const suppliedWitness = copyValidWitness(witness);
    if (suppliedWitness === undefined || !sourceSupported(suppliedWitness.sourceId)) return { kind: "unsupported" };
    try {
      const limits = resolveHeadLimits(suppliedLimits, maxHistoryFiles);
      const ledger: HeadOperationLedger = { remainingIndexBytes: limits.maxIndexBytes };
      const current = await fingerprintFilesystemHead(root, suppliedWitness.sourceId, maxHistoryFiles, limits, ledger);
      if (current.kind === "missing") return { kind: "missing" };
      return headToken(current.fingerprint, suppliedWitness.headSnapshotRef) === suppliedWitness.token
        ? { kind: "matches" }
        : { kind: "changed" };
    } catch (error) {
      return { kind: headFailureFrom(error) };
    }
  };

  return {
    put: (snapshot) => persistFilesystemSnapshot(root, snapshot, maxHistoryFiles),
    latest: (sourceId) => readLatestSnapshot(root, sourceId, maxHistoryFiles),
    async get(sourceId, bodyHash) {
      return (await readAllSnapshots(root, sourceId, maxHistoryFiles)).find(
        (snapshot) =>
          snapshot.bodyHash === bodyHash ||
          snapshot.bodyHash.startsWith(bodyHash),
      );
    },
    list: (sourceId) => readAllSnapshots(root, sourceId, maxHistoryFiles),
    findExact: (reference) => findExactFilesystemSnapshot(root, reference),
    prune: (sourceId, options) => pruneFilesystemSnapshots(root, sourceId, options, maxHistoryFiles),
    readVerifiedHead,
    compareHeadWitness,
  };
}

function cloneSnapshot(snapshot: Snapshot): Snapshot {
  return canonicalDurableSnapshot(snapshot);
}

export function createInMemorySnapshotStore(): ExactSnapshotStore & PrunableSnapshotStore {
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
    async prune(sourceId, options) {
      const keep = assertPruneOptions(options);
      const { retained, victims } = selectPruneVictims(sorted(sourceId), (snapshot) => snapshot, options.keepLast, keep);
      const removed = new Set(victims);
      const remaining = (bySource.get(sourceId) ?? []).filter((snapshot) => !removed.has(snapshot));
      bySource.set(sourceId, remaining);
      // A snapshot put twice has two entries; keep lookups for a surviving copy.
      for (const snapshot of victims) {
        const identity = snapshotIdentityDigest(snapshot);
        const envelope = snapshotEnvelopeDigest(snapshot);
        const survivor = remaining.find((candidate) => snapshotEnvelopeDigest(candidate) === envelope);
        if (survivor === undefined) {
          byIdentity.delete(identity);
          byEnvelope.delete(envelope);
        } else {
          byIdentity.set(identity, survivor);
          byEnvelope.set(envelope, survivor);
        }
      }
      return { removed: victims.length, retained: retained.length };
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
        kind: error instanceof SnapshotStoreReadError ? error.code : "snapshot-store-error",
        message: error instanceof SnapshotStoreReadError && error.code === "snapshot-corrupt"
          ? "snapshot replay cannot use a corrupt stored snapshot"
          : "snapshot replay could not read the supplied store",
      },
    };
  }
}
