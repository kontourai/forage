import type { Snapshot } from "./types.js";

/** Build a durable ref that can be resolved through SnapshotStore.get(). */
export function buildSnapshotSourceRef(snapshot: Snapshot): string {
  const params = new URLSearchParams({
    url: snapshot.url,
    sha256: snapshot.bodyHash,
    fetchedAt: snapshot.fetchedAt,
  });
  return `forage-snapshot:${encodeURIComponent(snapshot.sourceId)}?${params.toString()}`;
}
