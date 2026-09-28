// A child process for the cross-process put/prune/latest stress test. Each
// round it performs three operations of its role and reports every failure.

import { createHash } from "node:crypto";
import { createFilesystemSnapshotStore, type Snapshot } from "../../src/index.js";

const [root, role, id, cap, sourceId] = process.argv.slice(2) as [string, string, string, string, string];
const store = createFilesystemSnapshotStore({ root, maxHistoryFiles: Number(cap) });

function capture(index: number): Snapshot {
  const body = `capture ${index}`;
  return {
    sourceId,
    url: "https://example.test/stress",
    status: 200,
    fetchedAt: new Date(Date.UTC(2026, 8, 1) + index * 60_000).toISOString(),
    body,
    bodyHash: createHash("sha256").update(body).digest("hex"),
  };
}

process.on("message", async (message: { round: number }) => {
  const errors: string[] = [];
  for (let step = 0; step < 3; step += 1) {
    try {
      if (role === "put") await store.put(capture(message.round * 100 + Number(id) * 10 + step));
      else if (role === "prune") await store.prune(sourceId, { keepLast: 1 + (Number(id) % 2) });
      else await store.latest(sourceId);
    } catch (error) {
      const failure = error as { name?: string; code?: string; reason?: string; message?: string };
      const where = (error as Error).stack?.split("\n").slice(1, 4).map((line) => line.trim()).join(" < ") ?? "";
      errors.push(`${role}:${failure.name}:${failure.reason ?? failure.code ?? failure.message} @ ${where}`);
    }
  }
  process.send!({ errors });
});
process.send!({ ready: true });
