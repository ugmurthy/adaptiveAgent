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
