# Changelog

All notable changes to this project will be documented in this file.

This project follows semantic versioning for release notes.

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
