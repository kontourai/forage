# Contributing

## Set up

forage uses pnpm, pinned by the `packageManager` field in `package.json`.
Scripts still run with `npm run`.

```bash
pnpm install
npm run verify
```

Dependency install scripts are blocked by default. Only the packages listed
under `allowBuilds` in `pnpm-workspace.yaml`, at those exact versions, may run
one. Third-party versions must be at least 24 hours old (`minimumReleaseAge`),
including frozen installs that check the lockfile against supply-chain policies.
Internal `@kontourai/*` releases are exempt so suite releases can be adopted
immediately. Urgent third-party security fixes require an explicit
`name@version` exception with a commit rationale.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run build` | Removes `dist/` and compiles `src/` and `tests/` with `tsc`. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm test` | Builds, then runs the compiled tests with `node --test` through `scripts/run-tests.mjs`. |
| `npm run test:release-tag-ancestry` | Self-test of `scripts/check-release-tag-ancestry.sh`. |
| `npm run verify` | `typecheck`, `test`, and `test:release-tag-ancestry`. CI runs this. |
| `npm run docs:check` | The docs gate: links, anchors, reachability, and topics in `corpus.json`. |
| `npm run docs:build` | Builds the docs site and `docs-bundle.json` into `dist-pages/`. |

`scripts/run-tests.mjs` discovers `dist/tests/**/*.test.js` itself and fails
when it finds fewer than its `MIN_TEST_FILES` floor, so a build that emits no
tests cannot pass. Raise the floor when you add test files; never lower it to
get a green run.

## Tests

Tests live in `tests/` as `*.test.ts` and use `node:test`. Network behaviour is
tested through injected seams rather than live sites: `fetchSource()` accepts
a `fetch`, clock, and sleep in `FetchSourceOptions`, and `createGuardedFetch()`
accepts a `resolver`.

Snapshot-lock ownership tests inject known, unchanged, and unreadable process
start identities through the internal test seam. This keeps PID-reuse admission
independent of OS subprocess scheduling; a separate test exercises the real
platform start-time reader. Unreadable identities retain fresh live locks and
cache that result for the acquisition. Production lock deadlines and stale-owner
rules remain unchanged.

## Documentation

Docs are published with Corpus. `corpus.json` lists the published
documents and the MCP topics agents retrieve. `npm run docs:check` is the
gate, and the Docs workflow runs it on every pull request. When you change a
source file that a document `covers` in `corpus.json`, update that document
in the same pull request. A new Markdown file under `docs/` must be added to
`documents` or `exclude`.

## Pull requests and CI

On every pull request, CI runs:

- **verify** on Node 22 and 24;
- **Publish path (dry run)**: `npm publish --dry-run` from a pnpm-installed
  tree, with no credentials;
- **Secret Scan**, **Veritas Advisory Governance**, and the
  **Docs** gate.

Commit messages follow Conventional Commits (`feat:`, `fix:`, `docs:`, and so
on). release-please reads them to open release pull requests and write
`CHANGELOG.md`. Pushing a `v*` tag runs the npm publish workflow.
