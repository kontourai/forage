/** Filesystem and in-memory stores lifted from traverse/fetch/snapshot-store.ts. */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FetchResult } from "./internal-types.js";
import type { Snapshot, SnapshotStore } from "./types.js";

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
  const timestamp = snapshot.fetchedAt.replace(/[^0-9A-Za-z._-]/g, "-");
  const hash = snapshot.bodyHash.replace(/[^0-9a-f]/gi, "").slice(0, 12);
  return `${timestamp}-${hash || "snapshot"}.json`;
}

function toDiskShape(snapshot: Snapshot): Record<string, unknown> {
  if (!(snapshot.body instanceof Uint8Array)) {
    return snapshot as unknown as Record<string, unknown>;
  }
  const { body, ...rest } = snapshot;
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
      ? right.bodyHash.localeCompare(left.bodyHash)
      : right.fetchedAt.localeCompare(left.fetchedAt),
  );
}

export interface FilesystemSnapshotStoreOptions {
  root: string;
}

export function createFilesystemSnapshotStore(
  options: FilesystemSnapshotStoreOptions,
): SnapshotStore {
  const root = path.resolve(options.root);

  async function readAll(sourceId: string): Promise<Snapshot[]> {
    const directory = path.join(root, sourceDirName(sourceId));
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      return [];
    }
    const snapshots: Snapshot[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const parsed = fromDiskShape(
          JSON.parse(await readFile(path.join(directory, name), "utf8")),
        );
        if (isSnapshot(parsed)) snapshots.push(parsed);
      } catch {
        // A partial or foreign file does not poison the store.
      }
    }
    return sortSnapshots(snapshots);
  }

  return {
    async put(snapshot) {
      const directory = path.join(root, sourceDirName(snapshot.sourceId));
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, snapshotFileName(snapshot)),
        JSON.stringify(toDiskShape(snapshot), null, 2),
        "utf8",
      );
    },
    async latest(sourceId) {
      return (await readAll(sourceId))[0];
    },
    async get(sourceId, bodyHash) {
      return (await readAll(sourceId)).find(
        (snapshot) =>
          snapshot.bodyHash === bodyHash ||
          snapshot.bodyHash.startsWith(bodyHash),
      );
    },
    async list(sourceId) {
      return readAll(sourceId);
    },
  };
}

function cloneSnapshot(snapshot: Snapshot): Snapshot {
  return {
    ...snapshot,
    body:
      snapshot.body instanceof Uint8Array
        ? new Uint8Array(snapshot.body)
        : snapshot.body,
    headers: snapshot.headers ? { ...snapshot.headers } : undefined,
  };
}

export function createInMemorySnapshotStore(): SnapshotStore {
  const bySource = new Map<string, Snapshot[]>();
  const sorted = (sourceId: string) =>
    sortSnapshots([...(bySource.get(sourceId) ?? [])]);
  return {
    async put(snapshot) {
      const snapshots = bySource.get(snapshot.sourceId) ?? [];
      snapshots.push(cloneSnapshot(snapshot));
      bySource.set(snapshot.sourceId, snapshots);
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
