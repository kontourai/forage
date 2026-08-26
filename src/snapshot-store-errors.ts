/** Safe, typed failures for reads of filesystem-backed snapshot stores. */

export type SnapshotStoreReadErrorCode =
  | "snapshot-corrupt"
  | "snapshot-store-error";

export type SnapshotStoreReadErrorReason =
  | "malformed-record"
  | "invalid-record"
  | "foreign-source-record"
  | "record-identity-mismatch"
  | "non-regular-entry"
  | "invalid-identity-index"
  | "record-disappeared"
  | "read-raced"
  | "read-failed"
  | "read-limit";

/**
 * A filesystem snapshot read could not produce a trustworthy result.
 *
 * `code` is intentionally safe to surface to an operator. The underlying
 * filesystem error, path, and record contents are not included in this error.
 */
export class SnapshotStoreReadError extends Error {
  readonly name = "SnapshotStoreReadError";

  constructor(
    readonly code: SnapshotStoreReadErrorCode,
    readonly reason: SnapshotStoreReadErrorReason,
  ) {
    super(
      code === "snapshot-corrupt"
        ? "snapshot store contains an invalid or corrupt record"
        : "snapshot store could not complete a reliable read",
    );
  }
}

export function isSnapshotStoreReadError(value: unknown): value is SnapshotStoreReadError {
  return value instanceof SnapshotStoreReadError;
}

export function snapshotCorrupt(reason: SnapshotStoreReadErrorReason): SnapshotStoreReadError {
  return new SnapshotStoreReadError("snapshot-corrupt", reason);
}

export function snapshotStoreFailure(reason: SnapshotStoreReadErrorReason): SnapshotStoreReadError {
  return new SnapshotStoreReadError("snapshot-store-error", reason);
}
