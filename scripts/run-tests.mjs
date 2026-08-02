#!/usr/bin/env node
// Runs the compiled Node test suite and refuses to report success on an empty
// or shrunken suite.
//
// Why this exists (kontourai/forage#49): `node --test dist/tests/*.test.js` is
// not a gate. npm runs scripts through `sh`, and POSIX `sh` passes an unmatched
// glob through literally, so `node --test` receives a path that does not exist,
// runs nothing, and exits 0 — a green required check that executed zero tests.
// Node's own glob form is no better: `node --test 'dist/tests/**/*.test.js'`
// also exits 0 when the pattern matches nothing (checked on Node 22 and 24).
// Discovery therefore happens here, in JS, where finding nothing is an error.

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = "dist/tests";

// A floor, not a target: the suite fails when fewer than this many compiled test
// files are found. Raise it as the suite grows. Never lower it to turn a red run
// green — a drop means test files stopped being built, or stopped existing.
const MIN_TEST_FILES = 7;

function discoverTestFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.js"))
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name))
    .sort();
}

const files = discoverTestFiles(TEST_DIR);

if (files.length < MIN_TEST_FILES) {
  console.error(
    `Test discovery failed: found ${files.length} test file(s) under ${TEST_DIR}/, expected at least ${MIN_TEST_FILES}.`,
  );
  console.error(
    "Either the build did not emit the tests (check tsconfig include/exclude/rootDir/outDir),",
  );
  console.error(
    "or test files were removed or renamed off the *.test.ts convention.",
  );
  for (const file of files) console.error(`  found: ${file}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
});

if (result.error) {
  console.error(`Failed to start the test runner: ${result.error.message}`);
  process.exit(1);
}
if (result.signal) {
  console.error(`Test runner terminated by signal ${result.signal}.`);
  process.exit(1);
}
process.exit(result.status ?? 1);
