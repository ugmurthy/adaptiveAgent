# Changelog

All notable changes to this project will be documented in this file.

This project follows semantic versioning for release notes.

## [0.1.47] - 2026-09-11

### Added

- Added managed image and audio attachments to desktop bridge protocol `1.17`.
- Added permanent deletion of terminal root-run trees for SQLite and Postgres
  runtimes through the desktop bridge.

### Changed

- Extended desktop runs to honor configured task preparation and added
  human-readable titles and kebab-case names to preparation results.
- Scoped desktop bridge `context` commands to the initialized workspace when
  no explicit working directory is provided.

### Fixed

- Made `edit_file` conflicts recoverable with structured guidance for missing,
  ambiguous, line-ending-mismatched, nonexistent, and binary-file edits while
  preserving atomic multi-edit behavior.
- Fixed home-relative tool paths so they expand before workspace-boundary
  validation.
- Fixed SQLite trace-session usage reports to expose tool accounting and made
  newest-first session pagination safe for merged groups and tied timestamps.

## [0.1.46] - 2026-09-01

### Added

- Added a trace-session compile script for producing the standalone sidecar
  executable.

### Changed

- Updated desktop bridge documentation for JSON-RPC protocol `1.16` and the
  capabilities introduced in protocols `1.13` through `1.16`.

### Fixed

- Fixed `read_file` recovery for directory paths by directing agents to
  `list_directory` with structured corrective metadata.
- Fixed SQLite usage reports attributing delegate runs to unknown models by
  persisting delegate model identity and recovering it from runtime events.

## [0.1.45] - 2026-08-27

### Added

- Added optional output-token and stream-inactivity limits across core model
  requests and supported model adapters.
- Added SHA-256 digests to `write_file` results and structured stale-file
  recovery metadata to `edit_file` for safe incremental editing.
- Added a bundled News Bulletin Agent using source-grounded research and the
  incremental artifact workflow.
- Added `--from-preparation` so a successful task-preparation run can be reused,
  with multi-run clarification provenance preserved in execution metadata.

### Changed

- Improved task-preparation dry runs so preparation results are shown without
  consuming an execution run.
- Simplified the bundled coding agents and removed obsolete bundled code
  generation skills.
- Expanded CLI documentation for cron schedules and inbox-triggered agents.

### Fixed

- Treated length-truncated model responses as incomplete and prevented retries
  after streamed progress to avoid duplicate long-form generation.

## [0.1.44] - 2026-08-24

### Added

- Added configurable CLI task preparation that can validate, clarify, or
  enhance objectives before execution.

### Changed

- Updated the release workflow to build gateway workspace dependencies before
  release-critical tests and to run those tests with Bun in an isolated home.

### Fixed

- Fixed the desktop application hanging after an agent profile is saved.
- Fixed the release gate failing to resolve unbuilt gateway packages and
  loading `bun:sqlite` through Node-hosted Vitest.

## [0.1.43] - 2026-08-21

### Added

- Added Desktop Agent Studio with a durable agent catalog, agent-scoped runtime
  generations, native agent windows, profile creation and editing, and profile
  lifecycle controls.
- Added secure generic file attachments and native settings path pickers to the
  desktop application.
- Added filtered artifact views, export workflows, and in-app artifact
  previews to the desktop workbench.

### Changed

- Redesigned the desktop workbench and expanded recovery, retry, resume,
  export, artifact, and settings workflows around durable workbench state.

### Fixed

- Hardened desktop startup, shutdown, refresh, renderer teardown, sidecar
  response routing, runtime locking, and persisted projection handling to
  prevent hangs, deadlocks, stale loading states, and catalog recovery races.
- Fixed macOS file-picker hangs, run-result jitter, screen flashing, invalid
  attachment diagnostics, artifact access, and run deletion behavior.
- Fixed Markdown and Mermaid rendering, including preservation of generated
  Mermaid styles in desktop previews.
- Fixed imported-module resolution for skill handlers, including portable
  persistent code-executor and E2B handling.

## [0.1.42] - 2026-08-04

### Added

- Added a durable desktop workbench with concurrent runs, persistent chat,
  manual approvals, activity narratives, trace inspection, history deletion,
  history search, and Markdown and Mermaid result rendering.

### Fixed

- Fixed desktop progress rendering and SQLite-backed runtime cost accounting.

## [0.1.41] - 2026-08-02

### Added

- Added a Tauri desktop MVP backed by the local desktop bridge, including
  runtime lifecycle controls, run and chat workflows, native release assets,
  and cross-platform application icons.
- Added SQLite-backed trace-session reporting and runtime setting discovery.

### Changed

- **Breaking:** removed the legacy hosted service API, Service SDK, and service
  console in favor of the capability gateway path. Historical service plans
  were moved under `archive/legacy-service`.

## [0.1.40] - 2026-07-31

### Added

- Added the capability gateway protocol, authenticated gateway service, and
  gateway client for protected model execution, usage accounting, request
  cancellation, public errors, streaming, and idempotent billing.
- Added gateway-backed remote tools and declarative server profile
  distribution.
- Added embedded SQLite runtime stores and migrations for local Agent SDK and
  desktop bridge execution.
- Added capability-gateway support to the Agent SDK and desktop bridge,
  including gateway, local-model, and direct BYOK inference modes.

### Changed

- Centralized CLI command metadata so the CLI and desktop bridge advertise one
  canonical command surface.

## [0.1.39] - 2026-07-25

### Fixed

- Updated `edit_file` to infer replace-all edits and handle UTF-8 code and text
  files correctly.
- Updated file-writing behavior to preserve UTF-8 text handling.

## [0.1.38] - 2026-07-23

### Added

- Added the first hosted service stack: Service SDK contracts and stores,
  authenticated HTTP APIs, workers, dispatch and reconciliation, event
  projection, S3/MinIO artifacts, durable input file references, and user and
  admin consoles.
- Added role-aware service controls, profile allowlisting, structured
  observability, and execution-safety checks.
- Added the desktop runtime bridge with a typed JSON-RPC 2.0 protocol, runtime
  lifecycle and run-control methods, event notifications, safe CLI execution,
  and release artifacts.
- Added Orb setup and resume scripts for Bun, Node, and a user-owned Postgres
  runtime.

### Changed

- `continue` now resumes from a safe step before the most recent failure.
- Added run-analysis details to the trace workbench and aligned its formatting
  with trace-session reports.

### Fixed

- Fixed hosted-service retry durability and artifact storage behavior.

## [0.1.37] - 2026-07-16

### Added

- Expanded trace-session with decision-oriented summaries, reliability
  classification, causal investigation, data-confidence reporting, aggregate
  trends, model comparisons, usage reports, HTML/JSON output, and a persistent
  run/session cache.
- Added dedicated trace-session package documentation and updated related CLI
  documentation.

### Changed

- **Breaking (beta):** replaced the `trace-session` mode switches with the
  positional `view`, `compare`, `list`, `aggregate`, `usage`, and `maintenance`
  command grammar. Report selection now uses `--report` instead of `--view`.
- Made the decision-oriented trace summary the default report and improved
  trace discovery with copy-friendly IDs and explicit filter semantics.

### Fixed

- Hardened trace reliability assessment and reporting.
- Fixed a delegation execution edge case discovered during reliability
  assessment.

## [0.1.36] - 2026-07-12

### Added

- Added project-scoped named context bundles with `context create`, `list`,
  `show`, and `delete` commands plus `--context-bundle` expansion for direct
  run and chat requests.

### Changed

- Session context refs now default to the latest matching runs instead of the
  earliest matching runs, with explicit `latest` and `earliest` selection.
- Context-ref resolution now pages sessions deterministically, records source
  run provenance, and authorizes each candidate session run.
- Run context-ref IDs are validated as UUIDs before bundle persistence or
  runtime-store access, replacing database syntax errors with actionable CLI
  validation errors.

## [0.1.35] - 2026-07-10

### Added

- Added basic `--context-ref` CLI support.

### Changed

- Hardened the next-step context-reference spec.

## [0.1.34] - 2026-07-09

### Added

- Added a new context-reference spec.
- Added context references so run outputs can be reused as evidence in later runs.

## [0.1.33] - 2026-07-07

### Added

- Added trace workbench CLI documentation.

## [0.1.32] - 2026-07-04

### Added

- Added Parallel as a search provider.
- Added ambient agent cron and file support.

## [0.1.31] - 2026-07-01

### Added

- Added recovery planner support.
- Added `search_files` and `edit_file` tools.
- Added ground-truth time context.

### Fixed

- Improved rendering progress and HTML output.
- Fixed usage rollups and provider/model summaries.
- Cleaned up trace-session output formatting.
- Captured failed `outputSchema` responses for debugging.
- Improved retry, interrupt, inspect, and replay behavior.

## [0.1.30] - 2026-06-25

### Fixed

- Hardened model output and tool input normalization, delegate-call handling, hidden-budget exhaustion, and oversized readable-page responses.
- Allowed `--image` inputs to use local file paths as well as URLs.
- Improved tool schema handling and command help readability.

## [0.1.29] - 2026-06-23

### Fixed

- Fixed chat interaction and dialog formatting issues.

## [0.1.28] - 2026-06-23

### Fixed

- Fixed Mesh cost reporting.
- Fixed agent resolution behavior in orchestrate mode.
- Included `@adaptive-agent/trace-session` in the release package set.

## [0.1.27] - 2026-06-21

### Fixed

- Removed unwanted packages from the release output.

## [0.1.26] - 2026-06-21

### Added

- Added streaming support for the Mesh adapter.
- Added streaming support for the OpenAI and OpenRouter adapters.
- Added streaming support for the Mistral adapter.

## [0.1.25] - 2026-06-19

### Fixed

- Restored the missing E2B dependency in the Agent SDK package.

## [0.1.24] - 2026-06-19

### Fixed

- Made `adaptive-agent init` succeed idempotently when rerun.

## [0.1.23] - 2026-06-19

### Added

- Added an uninstall command.

## [0.1.22] - 2026-06-18

### Changed

- Optimized core runtime behavior.
- Updated `init` to include bundled agents and skills.
- Added an Agent SDK architecture diagram.

## [0.1.21] - 2026-06-16

### Added

- Added `create-agent` and catalog commands.
- Added `doctor` checks for provider reachability and database connections.
- Added Serper as an additional web search provider.

### Fixed

- Fixed markdown rendering for catalog and output views by resolving a dependency version conflict.

## [0.1.2] - 2026-06-14

### Changed

- Updated installation instructions.

## [0.1.1] - 2026-06-14

### Fixed

- Fixed TUI behavior for the in-progress TUI surface, which was not part of the release package.

## [0.1.0] - 2026-06-12

### Added

- Initial `@adaptive-agent/core` package with runtime semantics for runs, sessions, child runs, retries, continuation, eventing, snapshots, tools, and durable execution state.
- Initial `@adaptive-agent/agent-sdk` package with the `adaptive-agent` CLI, configuration loading, built-in tool registration, install/update flows, TUI entrypoint, and GAIA evaluation entrypoint.
- Initial `@adaptive-agent/trace-session` package with a standalone Postgres trace reporter for core runtime runs and optional legacy gateway session tables.
- Bun + TypeScript monorepo workspace setup for the core runtime, Agent SDK, and trace-session packages.
- Versioned architecture and contract documentation, including the v1.5 agent spec and contracts plus the core/session/swarm responsibility boundary.
- Release asset build and smoke-test scripts for installer-oriented distribution.

### Fixed

- Fixed `outputSchema` handling.
- Retried once on timeout.
- Fixed search budget exhaustion handling.
- Fixed swarm-run progress messages, color multiplexing, and tool name resolution.
