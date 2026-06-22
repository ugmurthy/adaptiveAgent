# Repository Guidance

## Current repository status

- This repository is an active Bun + TypeScript monorepo with implementation packages and versioned architecture/spec docs.
- Primary packages currently include:
  - `@adaptive-agent/core` in `packages/core`
  - `@adaptive-agent/agent-sdk` in `packages/agent-sdk`
  - `@adaptive-agent/trace-session` in `packages/trace-session`
- Versioned specs and contract Markdown remain important architecture references. Preserve terminology and behavioral contracts when changing implementation code.
- Treat `agen-spec-v1.5.md` and `agen-contracts-v1.5.md` as the newest versioned spec/contract sources unless a task explicitly targets v1.4 or earlier.
- Treat `CORE-SESSION-SWARM-SPEC.md` as the reference for the core/session/swarm responsibility boundary between `@adaptive-agent/core` and `@adaptive-agent/agent-sdk`.

## Runtime and verification

- Use Bun-native commands by default. Do not introduce npm/yarn/Jest workflows unless a package already requires them.
- For package work, prefer the touched package's local scripts:
  - `bun run build`
  - `bun test`
  - `bunx vitest run`
  - `bunx vitest run <path>`
  - `bunx vitest run -t "<name>"`
  - `bun run typecheck` when the package defines it
- Root useful commands:
  - `rg --files -uu` to inspect files
  - `rg -n "pattern" *.md` to trace terminology and contracts
- Keep edits scoped. Do not rewrite historical docs unless the task is about migration, comparison, or historical context.

## Hard rules: core vs Agent SDK responsibility boundary

These rules protect the package boundary established by `CORE-SESSION-SWARM-SPEC.md`. They apply beyond swarm work: when adding new orchestration, CLI, or agent-profile features, choose the package based on responsibility, not convenience.

### `@adaptive-agent/core` owns runtime semantics

- Core owns durable execution semantics: runs, sessions, child runs, retries, continuation, persistence, eventing, snapshots, and runtime metadata.
- Core owns execution-time validation for data it is asked to run. It must not trust model output, CLI input, or SDK-prevalidated data.
- Core owns generic orchestration primitives that are independent of a specific CLI UX or agent-spec loading flow.
- Core may expose strict programmatic APIs for already-prepared execution requests.
- Core must remain usable without importing `@adaptive-agent/agent-sdk`.

### `@adaptive-agent/agent-sdk` owns agent-profile and CLI setup

- Agent SDK owns CLI-facing workflows and user-facing command behavior.
- Agent SDK owns loading, resolving, and validating existing agent JSON specs.
- Agent SDK owns coordinator/decomposer prompt construction, safe catalog summaries, default agent selection, and CLI-friendly error messages.
- Agent SDK owns translating CLI/user intent into strict core execution requests.
- Agent SDK may prevalidate inputs for usability, but core must still validate before execution.

### Do not blur this boundary

- Do not move CLI-specific parsing, command naming, or agent-spec discovery into core.
- Do not make core depend on Agent SDK package types, config paths, default agent specs, or CLI concepts.
- Do not duplicate agent definition fields such as model, instructions, delegates, or allowed tools into orchestration task objects when the existing agent spec is the source of truth.
- Do not make Agent SDK own durable runtime behavior that belongs in core.
- Do not bypass core validation just because Agent SDK already validated something.

## Existing architecture and terminology constraints

- Preserve the central design boundary: `Tool` is the only first-class executable primitive; plans are separate artifacts.
- Keep terminology precise and consistent:
  - `run`
  - `sessionId`
  - `coordinatorRunId`
  - `top-level objective`
  - `subObjective`
  - `worker run`
  - `quality run`
  - `synthesizer run`
  - `child run`
  - `plan`
  - `plan execution`
  - `delegate profile`
  - `replan.required`
- Do not casually reintroduce deferred concepts unless the task explicitly changes the spec:
  - skills runtime
  - DAG execution
  - parallel child runs
  - child messaging
  - chain-of-thought persistence
  - separate `swarmId`

## Code and docs style

- Keep Markdown edits ASCII-first unless existing files require otherwise.
- Use short sections, flat bullets, fenced `ts`/`sql` blocks, and backticks for identifiers and event names.
- In TypeScript examples, prefer explicit interfaces/types, Bun + TypeScript assumptions, named concepts, and avoid `any` unless the spec genuinely leaves a type open.
- In schema examples, preserve deterministic and resumability semantics:
  - event log plus snapshots
  - leases/heartbeats
  - optimistic versioning
  - explicit compatibility checks
- Call out breaking changes clearly when moving between versions, especially around public API, persistence, event types, or replay behavior.

## Package-specific notes

- In `packages/trace-session`, keep gateway tables optional. Trace reporting must work against core runtime Postgres tables even when `gateway_sessions` and `gateway_session_run_links` are absent.
