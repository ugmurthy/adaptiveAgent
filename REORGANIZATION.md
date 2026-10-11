# Monorepo responsibility reorganization

## Delivery rules

- Use a dedicated Git worktree and short-lived phase branches with reviewable PRs.
- Do not merge or push changes to `origin/main` until the reorganization succeeds.
- Preserve database schemas, migrations, persisted plans, and run identity.
- Separate mechanical relocation from behavior changes in commits.
- Remove the fullscreen TUI; preserve plain CLI behavior, including legacy
  `tui.messages` styling used by the CLI.
- Keep historical design documents unchanged; this document records the current
  migration direction.

## Ownership and allowed dependencies

| Package | Owns | Allowed workspace dependencies |
| --- | --- | --- |
| core | Execution validation, runs, delegation, events, snapshots, persistence, generic durable scheduling and recovery | No SDK, CLI, desktop, or gateway host dependency |
| agent-sdk | Profile/settings loading, discovery, agent assembly, tool registration, task preparation, selection, routing and decomposition policy | core, gateway-client |
| cli | Arguments, terminal interactions/rendering, command dispatch, evaluation commands, installation/update and executable packaging | agent-sdk, core |
| desktop-bridge | Desktop RPC adaptation, runtime lifecycle, event delivery, explicit CLI child integration | agent-sdk, core, gateway-client, cli for CLI integration only |
| desktop-app | Native process/window lifecycle, attachment ownership, workbench records, submission tracking, product presentation | Versioned agent and trace sidecar protocols |
| gateway-protocol | Transport-neutral wire contracts and input validation | None |
| gateway-client | Transport and gateway-to-core model adaptation | gateway-protocol, core/types public contracts |
| capability-gateway | Authentication, authorization, permits, quotas, billing, provider routing and server profile distribution | gateway-protocol, core integrations |
| trace-session | Runtime-schema readers, trace projections, reports and trace sidecar | Narrow SDK runtime-settings resolution; runtime schema contracts |
| trace-workbench | Trace HTTP adaptation and web presentation | trace-session public reporting API |

Core owns durable agent execution, not every durable product record. Desktop
workbench records and gateway billing/authorization remain host-owned. Trace
records are read projections, not execution authority. Test-only gateway-host
dependencies in SDK/bridge are not production dependency edges.

Provider adapters and built-in tools may remain in core during this migration.
Extracting them is a separate, optional minimal-engine decision.

## Compatibility contracts

- Preserve CLI command names, argument semantics, output formats, exit codes,
  executable names and release asset layouts, except the explicitly removed TUI.
- Move the SDK `/cli` entrypoint to the CLI package. Do not introduce an SDK-to-CLI
  re-export, which would reverse the dependency direction.
- Preserve SDK profile/config APIs, settings precedence, exact profile identity,
  runtime selection, gateway authorization and per-run file access.
- Preserve desktop and trace RPC methods, negotiated versions, payloads and
  notification ordering. Rust/TypeScript representations need contract checks,
  not a dependency on an executable implementation.
- Preserve core SQLite/Postgres schema compatibility and optional gateway trace
  tables. No production schema changes belong in these phases.
- Keep source/build entrypoints explicit. Do not add cross-package `src` imports.

## Phases

| Phase | Scope | Completion gate |
| --- | --- | --- |
| 1 | Extract CLI, installer and evaluation entrypoints; remove fullscreen TUI; update desktop and distribution inputs | SDK/CLI/bridge/trace tests, builds, CLI and compiled sidecar smoke checks; no new typecheck diagnostics |
| 2 | Make SDK host-neutral: explicit interaction callbacks/pending results; separate profile editing from terminal presentation | Headless and interactive behavior checks through public APIs |
| 3 | Keep catalog/routing policy in SDK; extract prepared-plan scheduling, state transitions and recovery into core | Existing scheduling/recovery tests and durable reopen/concurrency checks with unchanged schemas |
| 4 | Headless trace entrypoint; move workbench SQL/session projection into trace-session | Existing report fixtures, schema compatibility and UI consumer checks |
| 5 | Enforce public entrypoints/dependency rules; finish documentation and full integration verification | Whole-repo build/test matrix and local release smoke tests |

Open one PR per working phase. Later phases can target the preceding phase branch
while `origin/main` stays unchanged. Do not merge PRs, publish packages, or trigger
deployments during the reorganization. Baseline failures must remain visible.

## Baseline (before phase 1)

Gateway protocol/client/host builds are prerequisites for SDK/bridge tests.
The initial test attempt lacked gateway build outputs; building those outputs
resolved package-entry failures without source changes.

- `bun run core:test`: 461 Vitest tests and 23 Bun tests passed.
- `bun run agent:test`: 284 Vitest tests passed, 1 skipped; 3 Bun tests passed.
- Desktop bridge `bun run test`: 80 Vitest tests and 6 Bun tests passed.
- `bun run trace-session:test`: 116 Vitest tests and 8 Bun tests passed.
- SDK `bun run typecheck`: fails on existing SDK test typings and core adapter,
  tool, logging and swarm typings. Compare diagnostic sets after relocation;
  do not hide failures or bundle unrelated fixes into this migration.

Tests use isolated homes, mocks/local gateway servers and disposable SQLite
files. No existing runtime database or migration needs to change.

## Phase 1 result

Branch: `reorg/phase-1-cli`, in a separate worktree. Core source, migrations,
desktop native/frontend source, runtime schemas, and RPC versions are unchanged.

- CLI entrypoints, terminal rendering, installer/update code, evaluation, and
  bundled install assets now live in `packages/cli`.
- SDK no longer exports `/cli` or owns executable bins. Consumers must import
  `@adaptive-agent/cli` or its lightweight `/commands` metadata entrypoint.
  This is a source import migration, not a CLI command or RPC protocol change.
- Desktop bridge and release builds use the new CLI entrypoints.
- Fullscreen TUI code and `pi-tui` are removed. Plain CLI message styles and
  legacy settings remain compatible. Five fullscreen TUI tests were removed;
  existing CLI tests were relocated and the combined SDK/CLI gateway case split.
- SDK terminal interaction defaults, profile-editing presentation, and durable
  orchestration remain for phases 2 and 3. Phase 1 is not the full separation.

### Verification

| Command (package-local unless shown) | Result |
| --- | --- |
| Root `bun run core:test` | 461 Vitest + 23 Bun passed |
| Root `bun run agent:test` | 173 Vitest passed, 1 skipped; 3 Bun passed |
| Root `bun run cli:test` | 106 passed, 1 Bun-only gateway case skipped under Node |
| CLI `bunx --bun vitest run src/command-integration.test.ts` | Both integration cases passed, including gateway model/tool/model execution |
| SDK `bunx --bun vitest run src/index.test.ts` | All 23 passed, including the retained SDK gateway case |
| Desktop bridge `bun run test` | 80 Vitest + 6 Bun passed |
| Root `bun run trace-session:test` | 116 Vitest + 8 Bun passed |
| Desktop app `bun run test` / `bun run typecheck` / `bun run web:build` | 7 Vitest + 37 Bun passed; typecheck and build passed |
| Root `bun run jev-routing-study:test` | 9 passed |
| SDK / CLI / bridge / trace builds | Passed |
| Trace workbench build | Passed |
| Local `build-release-assets.sh` | All five platform archives built with CLI, trace, and agent-runtime binaries |
| Local `smoke-release-assets.sh` | Linux x64 passed, including compiled runtime-only CLI child execution and isolated init |
| Local `build-npm-packages.sh` / `smoke-npm-packages.sh` | Packaging passed; Linux x64 wrapper execution passed; nothing published |
| Shell syntax / `git diff --check` | Passed |

SDK typecheck still reports the same 36 baseline diagnostics, after normalizing
source locations. CLI typecheck reports 32 inherited core diagnostics, with no
CLI-local errors. Trace workbench typecheck still reports 33 errors; its full
diagnostic output matches the original checkout after normalizing worktree paths.
These pre-existing failures were not suppressed or fixed as part of relocation.

The orb initially lacked `zip`, blocking Windows archive packaging after a
successful compile. Installing it resolved the packaging failure; setup now
declares that prerequisite. Setup itself was syntax-checked, not rerun, to avoid
restarting or migrating the existing database. Release scripts restore generated
source metadata after building. Non-Linux binaries were built but not executed;
the packaged Tauri GUI was not manually exercised.

## Phase 2 result

Branch: `reorg/phase-2-host-neutral-sdk`, stacked on `reorg/phase-1-cli`.
Core source, migrations, existing databases, desktop native/frontend source,
runtime schemas, and RPC versions are unchanged.

- SDK ordinary run/chat and run-level control methods no longer open terminal
  prompts. Optional typed `onApproval` and `onClarification` callbacks receive
  the complete pending request and support synchronous or asynchronous answers.
  Without a callback, manual/interactive requests return pending. Existing
  auto/reject approval and fail clarification policies remain unchanged.
- Raw calls remain host-managed; session recovery, catalog orchestration,
  swarms, desktop, and ambient processing retain their pending/blocked contracts.
- CLI supplies the original prompts explicitly, including selected-profile,
  resume, recovery, and continuation SDK construction paths.
- SDK profile generation, validation, and persistence remain in SDK. Preview
  rendering, report formatting, and terminal confirmation move to the public
  `@adaptive-agent/cli/agent-create` entrypoint. SDK `runAgentCreate` requires
  explicit `confirm` or ordinary `yes: true`, never implicit stdin consent.
- SDK ambient processing is silent unless a host injects `AmbientLogger`.
  `AmbientStartOptions.output` is removed; CLI supplies its existing pretty
  logger. Explicit core logging configuration remains available.

This is a source API migration for embedded SDK users, not a CLI command or RPC
change. Existing profile-create `dryRun` behavior is deliberately preserved:
it always confirms, and accepting writes even with `--dry-run --yes`. Use
`prepareAgentCreate` for a strictly non-writing preview. Host-neutral means no
implicit terminal interaction/presentation, not browser portability.

### Verification

| Command (package-local unless shown) | Result |
| --- | --- |
| Root `bun run agent:test` | 184 Vitest passed, 1 skipped; 3 Bun passed |
| Root `bun run cli:test` | 107 passed, 1 Bun-only gateway case skipped under Node |
| CLI `bunx --bun vitest run src/command-integration.test.ts` | All 3 passed, including gateway execution and profile presentation |
| SDK `bunx --bun vitest run src/index.test.ts` | All 33 passed, including callback/pending contracts and gateway execution |
| Root `bun run core:test` | 461 Vitest + 23 Bun passed |
| Desktop bridge `bun run test` | 80 Vitest + 6 Bun passed, including manual approval with SQLite |
| Root `bun run trace-session:test` | 116 Vitest + 8 Bun passed |
| SDK / CLI / trace builds; compiled desktop bridge | Passed |
| Compiled Linux CLI with local model stub and real pseudo-terminal | Approval/rejection, resumed clarification, profile create/cancel, dry-run confirmation, and non-TTY refusal passed |
| Compiled Linux desktop bridge | v1.20 initialize + CLI child `--version`; JSON-RPC-only stdout and clean stderr |
| Source ownership inspection / `git diff --check` | Passed |

SDK and CLI typechecks still fail with exactly the same normalized Phase 1
diagnostic sets: 36 SDK errors and 32 inherited core errors for CLI. No new
diagnostics are suppressed. Interactive checks use isolated homes/workspaces,
a local OpenAI-compatible stub, and one disposable SQLite database for resumed
clarification. No existing database is migrated or written. The initial stub
incorrectly assumed profile generation used provider `response_format`; matching
the actual generation prompt corrected the fixture without production changes.
Temporary smoke scripts and the standalone CLI binary are removed afterward.

The packaged Tauri GUI and non-Linux terminal behavior were not manually tested
in this phase. Durable scheduling/recovery relocation remains Phase 3; Phase 2
does not claim the full monorepo reorganization is finished.

## Phase 3 result

Branch: `reorg/phase-3-core-orchestration`, stacked on
`reorg/phase-2-host-neutral-sdk`. Store implementations, schemas, migrations,
existing databases, CLI commands, desktop native/frontend source, and RPC
versions are unchanged.

- Core's new public `PreparedOrchestrationExecutor` owns prepared-plan scheduling,
  stage claims, pause/resume, cancellation, recovery assessment and claims,
  continuation identity updates, downstream recomputation, lifecycle events,
  session/link projections, and result reconstruction.
- SDK retains catalog loading/fingerprinting, profile availability, routing and
  plan construction, attachment filtering, stage prompts/options, runner
  creation/cache/cleanup, and lazy runtime-store adoption. Core receives narrow
  host hooks and does not load profiles or import SDK.
- Core's `recoverPreparedSession` owns logical session target selection,
  continuation ambiguity, live run leases, dry-run classification, and recovery
  outcome dispatch. SDK assembles historical profiles/swarm roles and checks
  their identity, fingerprints, and model compatibility through handlers.
- Shared persisted plan/result/event/session/link/routing-decision contracts now
  live in core; SDK re-exports its existing names. Routing algorithms and profile
  capability validation remain SDK-owned. Public SDK APIs and persisted JSON
  layouts, including legacy saved-plan upgrades, are preserved.
- Mechanical extraction is committed separately from core boundary validation.
  Core rejects invalid fresh plans/requests before persistence and rejects saved
  stage/plan mismatches before resume or recovery mutates the execution.

### Verification

| Command (package-local unless shown) | Result |
| --- | --- |
| Existing SDK orchestration/session recovery tests | 45 passed unchanged |
| Root `bun run core:test` | 474 Vitest + 24 Bun passed |
| Root `bun run agent:test` | 184 Vitest passed, 1 skipped; 3 Bun passed |
| Root `bun run cli:test` | 107 passed, 1 Bun-only gateway case skipped under Node |
| CLI `bunx --bun vitest run src/command-integration.test.ts` | All 3 passed, including gateway model/tool/model execution |
| SDK `bunx --bun vitest run src/index.test.ts` | All 33 passed, including gateway integration |
| Desktop bridge `bun run test` | 80 Vitest + 6 Bun passed |
| Root `bun run trace-session:test` | 116 Vitest + 8 Bun passed |
| Root `bun run jev-routing-study:test` | 9 passed |
| Core / SDK / CLI / bridge / trace builds; trace workbench build | Passed |
| Compiled Linux desktop bridge | Protocol 1.20 initialize + embedded CLI `--version` passed; JSON-RPC-only stdout, empty stderr |
| Built CLI | `--help` and `--version` passed |
| Source ownership inspection / `git diff --check` | Passed |

The new real-core SQLite reopen case preserves a successful independent stage,
recovers one failed stage into exactly one continuation, updates downstream run
identities, and completes with the independently expected sum 48. Same-executor
and separate-connection competing recoveries report `busy`; completed recovery
does not repeat tool, sibling, or synthesis work. Dry-run leaves saved stages
unchanged. The initial fixture used a retryable provider failure; replacing it
with the existing non-retryable invalid-output case exercises continuation
without changing production failure classification. Thirteen public boundary
cases reject invalid prepared or persisted data without durable mutations.

Typechecks still fail on inherited diagnostics: core has 76, SDK has 36, and
CLI/bridge have 32 each. Core matches the original checkout after normalizing
worktree paths and source locations; SDK/CLI match Phase 2 exactly after location
normalization, and bridge matches the inherited CLI set. No failures are hidden.

Tests use memory, local gateway stubs, isolated homes, and disposable SQLite
files. No existing Postgres/SQLite database is migrated or written. The packaged
Tauri GUI, Postgres restart/concurrency integration, and non-Linux executables
were not manually exercised in this phase. Trace/workbench projection relocation
remains Phase 4, and whole-repo dependency enforcement remains Phase 5.

## Phase 4 result

Branch: `reorg/phase-4-trace-boundary`, stacked on
`reorg/phase-3-core-orchestration`. Core/SDK runtime source, schema/migration
files, existing databases, desktop native source, and RPC versions are unchanged.

- Trace-session's public root now exposes a headless API. CLI argument parsing,
  rendering, and explicit startup live at `/cli`; the existing sidecar API is
  exposed at `/sidecar`. CLI helpers/renderers formerly imported from the root
  must migrate to `/cli`. Executable names, source/build CLI paths, and command
  behavior are preserved.
- Workbench runtime SQL and session navigation projection move into
  trace-session's `listRecentSessions`. Workbench retains HTTP/static adaptation,
  display models, and Markdown formatting, with no runtime queries of its own.
- Recent navigation deliberately remains distinct from canonical `listSessions`:
  updated-root ordering and root-limit-before-grouping are preserved, including
  independent sessionless roots and the existing status precedence. HTTP payloads
  do not acquire canonical labels or cursors. `RecentSessionListItem` accurately
  types the existing payload instead of incorrectly promising `title`/`name`.
- Existing SQLite tests now exercise the public headless entrypoint. One public
  projection contract case covers asymmetric statuses/timestamp ties, multiple
  sessionless roots, and persisted goal conversion.

### Verification

| Command/check | Result |
| --- | --- |
| Root `bun run trace-session:test` | 117 Vitest + 8 Bun passed |
| Root `bun run core:test` | 474 Vitest + 24 Bun passed |
| Root `bun run agent:test` | 184 Vitest passed, 1 skipped; 3 Bun passed |
| Root `bun run cli:test` | 107 passed, 1 Bun-only gateway case skipped under Node |
| CLI `bunx --bun vitest run src/command-integration.test.ts` | All 3 passed, including gateway integration |
| Desktop bridge `bun run test` | 80 Vitest + 6 Bun passed |
| Trace build / compiled Linux trace sidecar / workbench build | Passed |
| Disposable Postgres, read-only connections | Exact Phase 3 projection parity at limits 0, 1, 2, 3, 5, 100; child exclusion, updated-root ordering, limit-before-grouping, status aggregation, and separate sessionless roots passed |
| HTTP consumer | Health, session list/performance, session/run detail, and Markdown export passed against core-only fixture tables |
| Compiled trace sidecar | Protocol 1.1 initialize/list/get/shutdown, canonical labels, redaction, and sensitive-data denial passed; JSON-RPC-only stdout and empty stderr |
| Built trace CLI / sidecar | Both `--help` paths passed |
| Headless bundle inspection | No CLI exports, argument parsing, terminal rendering, `readline`, `marked-terminal`, or `cli-table3` |
| Browser consumer | Blocked default, multi-root session, successful run drill-down, empty search, and back-to-session navigation checked; 137 session tokens / 117 run tokens and persisted output rendered; no renderer errors |
| Source ownership / `git diff --check` | Passed |

The workbench server build falls from 406 modules / 2.93 MB in Phase 3 to
124 modules / 0.61 MB without its terminal reporting dependency tree. Frontend
JS/CSS filenames and sizes are unchanged (`index-CbTU1iwG.js`,
`index-CEuFj1dE.css`); Svelte edits are type-only. Inspected 2x screenshots of
default, multi-root session, and run views are retained as review artifacts.

Typechecks remain failing on inherited errors. Trace-session retains the same
33 normalized diagnostics. Workbench decreases from 33 to 32: its incorrect
`SessionListItem` payload annotation is replaced with the accurate recent-list
contract; all other normalized TypeScript diagnostics are unchanged. No errors
are suppressed and no unrelated typing cleanup is included.

Postgres verification used a separate disposable cluster on port 5544 with the
existing core migrations and six synthetic runs, never the existing runtime
database. Consumer connections enforced `default_transaction_read_only=on`.
The test server/browser were stopped and the disposable cluster was removed.

An existing desktop integration gap remains: native code requests trace protocol
1.0, while the sidecar accepts 1.1. Both values are unchanged by Phase 4. The
compiled sidecar was tested through its supported protocol, not the packaged
Tauri GUI; fixing that pre-existing mismatch is outside this relocation. Other
non-Linux/native workflows were not manually exercised. Phase 5 still owns
whole-repo dependency enforcement and final integration/release smoke checks.

## Phase 5 result

Branch: `reorg/phase-5-boundary-enforcement`, stacked on
`reorg/phase-4-trace-boundary`. Runtime algorithms, schemas/migrations, existing
databases, desktop native/frontend source, and RPC versions are unchanged.

- Core now declares its root and narrow `/types` exports. Gateway-client moves
  from private `core/src/types.js` to `/types`, preserving its contract-only
  dependency without pulling runtime implementation into declaration builds.
  Other private core subpaths are no longer supported public imports.
- Active examples and developer scripts use public workspace imports. SDK
  exposes the existing metadata-only `discoverCatalogDelegates` operation at
  its root for the manual delegate runner; no discovery algorithm changes.
- Root tooling declares SDK/core workspace devDependencies and TypeScript.
  Lockfile changes only add those root declarations; package versions do not
  change. Executable compilation inputs remain explicit source paths.
- `bun run boundaries:check` checks all ten workspace manifests and literal
  TS/JS imports/re-exports, import types, dynamic imports, `require`, and Svelte
  script blocks in `packages`, `scripts`, and `examples`. It rejects forbidden
  production/test edges, undeclared dependencies, private package subpaths,
  cross-boundary relative paths, production imports of test modules, and broad
  imports across the gateway/trace headless boundaries. New workspaces require
  an explicit policy. Four fixture cases exercise allowed and rejected edges.
- `workspace-boundaries` runs the checker and its tests on PRs and reorg branch
  pushes with read-only repository permissions. It does not publish or deploy.
  Existing release workflow and release triggers are unchanged.
- `AGENTS.md` now records ownership and dependency directions for all ten
  workspaces, public entrypoints, headless host rules, test-only exceptions and
  verification commands. README points current consumers to these boundaries
  rather than treating older design proposals as current package layouts.

The checker is an architectural guard, not a security sandbox or protocol
compatibility test. Computed plugin imports, native RPC representations,
executable build-input paths, root scratch scripts and historical documents
still require appropriate review. Build/native outputs are excluded.

### Verification

| Command/check | Result |
| --- | --- |
| `bun run boundaries:test` / `bun run boundaries:check` | 4 passed; all active workspace boundaries passed |
| Checker/test focused TypeScript check | Passed using core's installed Bun types |
| Core tests | 474 Vitest + 24 Bun passed |
| SDK tests | 184 Vitest passed, 1 skipped; 3 Bun passed on rerun; initial order-sensitive failure recorded below |
| CLI tests / Bun integration tests | 107 passed, 1 Node-skipped case; all 3 Bun integration cases passed |
| Desktop bridge tests | 80 Vitest + 6 Bun passed |
| Trace-session tests | 117 Vitest + 8 Bun passed |
| Gateway protocol/client/host tests | 47 / 25 / 32 passed |
| Desktop frontend tests / typecheck / web build | 7 Vitest + 37 Bun passed; zero typecheck errors/warnings; build passed |
| Developer script tests | 15 passed across delegate runner, routing study and bridge script |
| All nine packages with `build` scripts | Passed, including gateway declaration builds and workbench web/server build |
| Seven runnable example bundle entrypoints | Passed without executing paid models/tools |
| Public root import / private core path probe | Public APIs resolve; private core `src` import rejected |
| Local release build / Linux x64 smoke | All five platform archives built; Linux CLI, trace and runtime-only embedded CLI execution passed |
| Local npm package build / Linux x64 smoke | Passed; nothing published |
| Schema/native/frontend diff / `git diff --check` | No changes / passed |

Typecheck diagnostics match the prior phase exactly after normalizing source
locations: core 76, SDK 36, CLI/bridge 32 each, trace 33. Workbench's full
typecheck output remains identical at 32 errors. Gateway protocol/client/host
typechecks pass. Existing failures are not suppressed.

The first SDK suite run failed its unchanged concurrent gateway assertion:
two successful runs executed local tools in `[high, low]` order while the test
expected `[low, high]`. The focused case and complete SDK rerun passed unchanged.
The original main case passed five focused runs; the baseline failure was not
reproduced there. This is a recorded order-sensitive test failure, not a claim
that all verification attempts were green or a bundled unrelated fix.

Release smoke used synthetic version `v0.0.0-reorg.phase5`, without creating a
Git tag, triggering a release, or publishing anything. Generated build metadata
was restored. Tests used isolated fixtures and disposable SQLite databases;
the existing Postgres cluster and migrations were not touched. No packaged
Tauri GUI or non-Linux binaries were executed. Desktop trace negotiation still
has the previously recorded 1.0/1.1 mismatch, unchanged in this phase.

### Acceptance and delivery

All five planned separation phases are implemented on stacked review branches.
They are not merged or deployed, and `origin/main` remains unchanged. Phase 5
provides enforceable imports and documentation, not a claim of a completely
green native/full-repo acceptance gate. Before accepting the whole stack:

- Review the five phase PRs in order and evaluate their source API migrations.
- Resolve or explicitly accept inherited typecheck failures and the recorded
  concurrent test ordering issue in separately scoped work.
- Resolve the desktop trace protocol mismatch in separately authorized work,
  then exercise the packaged desktop workflow and required target platforms.
- Decide on integration/merge only after those acceptance choices. No schema
  migration is required by this reorganization.
