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
| gateway-client | Transport and gateway-to-core model adaptation | gateway-protocol, core public contracts |
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
