// Structural invariants of one filesystem snapshot-store source, checked at
// quiescence (no put or prune running). Returns every violation found.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { VerifiedHeadSnapshotStore } from "../../src/index.js";

export async function storeViolations(
  root: string,
  sourceId: string,
  maxHistoryFiles: number,
  store: VerifiedHeadSnapshotStore,
): Promise<string[]> {
  const violations: string[] = [];
  const [sourceDirectory] = await readdir(root);
  if (sourceDirectory === undefined) return ["no source directory"];
  const directory = path.join(root, sourceDirectory);
  const names = await readdir(directory);
  const records = names.filter((name) => name.endsWith(".json"));
  const extra = names.filter((name) => !name.endsWith(".json") && name !== "capacity-index" && name !== "identity-index");
  if (extra.length > 0) violations.push(`leftovers in source directory: ${extra.join(", ")}`);
  if (records.length > maxHistoryFiles) violations.push(`${records.length} records exceed the cap of ${maxHistoryFiles}`);

  const capacityNames = await readdir(path.join(directory, "capacity-index"));
  const slots = capacityNames.filter((name) => /^\d+\.txt$/.test(name));
  const capacityExtra = capacityNames.filter((name) =>
    !/^\d+\.txt$/.test(name) && name !== "max-history-files.txt" && name !== "initialized.txt");
  if (capacityExtra.length > 0) violations.push(`leftovers in capacity-index: ${capacityExtra.join(", ")}`);
  const owners = await Promise.all(slots.map((slot) => readFile(path.join(directory, "capacity-index", slot), "utf8")));
  for (const record of records) {
    const count = owners.filter((owner) => owner === record).length;
    if (count !== 1) violations.push(`record holds ${count} slots`);
  }
  for (const owner of owners) if (!records.includes(owner)) violations.push("slot names no record");

  let identityNames: string[] = [];
  try {
    identityNames = await readdir(path.join(directory, "identity-index"));
  } catch {
    identityNames = [];
  }
  const identityExtra = identityNames.filter((name) => !/^[a-f0-9]{64}\.txt$/.test(name));
  if (identityExtra.length > 0) violations.push(`leftovers in identity-index: ${identityExtra.join(", ")}`);
  const identities = await Promise.all(identityNames
    .filter((name) => /^[a-f0-9]{64}\.txt$/.test(name))
    .map((name) => readFile(path.join(directory, "identity-index", name), "utf8")));
  for (const record of records) {
    const count = identities.filter((entry) => entry.trim() === record).length;
    if (count !== 1) violations.push(`record has ${count} identity entries`);
  }
  for (const entry of identities) if (!records.includes(entry.trim())) violations.push("identity entry names no record");

  const head = await store.readVerifiedHead(sourceId);
  if (head.kind !== "found") violations.push(`readVerifiedHead is ${head.kind}`);
  return violations;
}
