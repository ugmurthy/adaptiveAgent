# Repository Guidance

## Current repository status

- This repository is an active Bun + TypeScript monorepo with implementation packages and versioned architecture/spec docs.
- Primary packages currently include:
  - `@adaptive-agent/core` in `packages/core`
  - `@adaptive-agent/agent-sdk` in `packages/agent-sdk`
  - `@adaptive-agent/cli` in `packages/cli`
  - `@adaptive-agent/trace-session` in `packages/trace-session`
- Versioned specs and contract Markdown remain important architecture references. Preserve terminology and behavioral contracts when changing implementation code.
- Treat `agen-spec-v1.5.md` and `agen-contracts-v1.5.md` as the newest versioned spec/contract sources unless a task explicitly targets v1.4 or earlier.
- Treat `CORE-SESSION-SWARM-SPEC.md` as the reference for the core/session/swarm responsibility boundary between `@adaptive-agent/core` and `@adaptive-agent/agent-sdk`.
- Follow `REORGANIZATION.md` for the phased CLI/SDK/core separation; do not change database schemas during these phases.

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
- `PreparedOrchestrationExecutor` owns prepared-plan scheduling and recovery; `recoverPreparedSession` owns logical session recovery selection and dispatch. Hosts supply configured runners, not profile-loading policy.
- Core may expose strict programmatic APIs for already-prepared execution requests.
- Core must remain usable without importing `@adaptive-agent/agent-sdk`.

### `@adaptive-agent/agent-sdk` owns agent-profile setup and policy

- Agent SDK owns loading, resolving, and validating existing agent JSON specs.
- Agent SDK owns agent assembly, coordinator/decomposer prompt construction, safe catalog summaries, default agent selection, and routing policy.
- Agent SDK owns translating prepared user intent into strict core execution requests.
- For catalog orchestration, SDK owns plan preparation, stage prompts/input filtering, and runner creation/cleanup; it delegates durable execution to core. Historical profile/model compatibility checks also remain SDK-owned.
- Agent SDK may prevalidate inputs for usability, but core must still validate before execution.
- Agent SDK must not open terminal prompts or render terminal reports. Hosts supply interaction callbacks or handle pending results; profile writes require explicit consent. Ambient logging is host-injected.

### `@adaptive-agent/cli` owns terminal workflows and distribution

- CLI owns argument parsing, command dispatch, terminal rendering/interactions, evaluation commands, install/update flows, and executable packaging.
- CLI depends on SDK and core public APIs; SDK and core must not import CLI.
- Desktop bridge may use CLI for its explicit CLI child integration, not as its runtime authority.
- Do not restore the removed fullscreen TUI or its dependency.

### Whole-workspace ownership

| Workspace | Responsibility | Production workspace dependencies |
| --- | --- | --- |
| core | Durable execution, prepared orchestration, validation, runtime stores and recovery | None |
| agent-sdk | Profiles/settings, assembly, discovery, selection/routing policy and plan preparation | core, gateway-client |
| cli | Terminal workflows, evaluation, installation and executable distribution | agent-sdk, core |
| desktop-bridge | Versioned RPC host, runtime lifecycle/events and explicit CLI child integration | agent-sdk, core, gateway-client, cli |
| desktop-app | Native windows/processes, attachments, workbench records and product presentation | Agent and trace sidecar protocols, not TS runtime packages |
| gateway-protocol | Transport-neutral wire contracts and validation | None |
| gateway-client | Transport and gateway model adaptation | gateway-protocol, core/types |
| capability-gateway | Authentication/authorization, permits, quotas, billing, provider routing and profile distribution | gateway-protocol, core |
| trace-session | Read-only runtime readers/projections, reports and trace RPC host | agent-sdk/runtime-settings only |
| trace-workbench | Trace HTTP/static adaptation and web presentation | trace-session headless root only |

- Durable product records are not all core execution state: desktop workbench data and gateway billing remain host-owned.
- Keep native and TypeScript sidecar protocol versions/payloads compatible; the desktop renderer must not import runtime implementations.
- Provider adapters and built-in tools remain core-owned in this reorganization. Extracting them is a separate design decision.

### Enforced public imports

- Use package names and explicit `package.json` exports across workspaces, including in tests, scripts and examples. Do not reach into another package's `src`, `dist`, or internal files through relative paths or aliases.
- Core exports its runtime API at `@adaptive-agent/core` and its narrow contracts at `@adaptive-agent/core/types`. Gateway-client consumes only the latter.
- SDK has no `/cli` compatibility re-export. Use `@adaptive-agent/cli`, `/agent-create`, or `/commands` for the relevant CLI surface.
- Trace-session's root is headless; `/cli` and `/sidecar` are explicit host entrypoints. Workbench imports only the root; trace-session imports only SDK `/runtime-settings`.
- Production imports must be declared in `dependencies`, `peerDependencies`, or `optionalDependencies`, not just `devDependencies`. Only SDK, CLI and desktop-bridge tests may depend on the capability-gateway host.
- Do not import test modules from production code. Keep test-only host dependencies out of helper modules used by production.
- Build/release scripts may name executable source files as build inputs; that does not authorize cross-package implementation imports.
- Run `bun run boundaries:test` and `bun run boundaries:check` after changing exports, dependencies or cross-package imports. The same checks run in the `workspace-boundaries` PR workflow; a new workspace needs an explicit checker policy.
- The checker inspects literal TS/JS imports/re-exports, dynamic imports, `require`, import types and Svelte script blocks in `packages`, `scripts`, and `examples`. Generated build/native outputs, historical documents and root scratch scripts are not checked. Computed plugin imports and native protocol compatibility still require review and integration tests.

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
- Trace-session's public root is headless; argument parsing and renderers belong to `/cli`, and JSON-RPC adaptation belongs to `/sidecar`. Keep runtime SQL/read projections in trace-session, not trace-workbench.
- Preserve the distinction between workbench's recent-root navigation (`listRecentSessions`, limits before grouping) and canonical CLI/sidecar session listing (`listSessions`, labels/filtering/session cursors). Workbench owns HTTP and presentation, not a second runtime reader.

### Working on `packages/desktop-app`

This package crosses Svelte, Tauri/Rust, native OS APIs, persisted data, and sidecar processes. Diagnose failures at the owning boundary before changing architecture.

#### Diagnose stuck UI states end-to-end

Treat persistent states such as "Loading...", "Saving...", or "Initializing..." as symptoms, not proof that the underlying operation is still running.

Establish separately:

1. The UI event fired.
2. The Tauri command was invoked.
3. The native handler entered and returned or blocked.
4. Any sidecar request received a response.
5. The renderer received and applied the result.
6. Rendering completed without an exception.
7. The visible DOM transitioned out of the pending state.

A renderer exception can leave stale pending UI visible after native work has completed successfully. If native status is ready but the UI remains pending, inspect renderer errors and reduce the payload to identify a data-dependent failure.

#### Respect blocking and thread-affine operations

Do not perform blocking OS dialogs, filesystem work, database work, lifecycle initialization, or synchronous sidecar waits on the Tauri UI thread or on an async executor needed to process their completion.

- Check plugin documentation for thread-affinity requirements.
- Make the Tauri command asynchronous when appropriate.
- Move genuinely blocking work to `spawn_blocking`.
- Keep response-routing tasks free to drain sidecar output.
- Preserve cleanup and error propagation across the blocking-task boundary.

A timeout may indicate executor starvation or deadlock rather than a slow subprocess.

#### Do not call outward while holding native locks

Treat callbacks, state publication, tracing, sidecar RPC, and UI event emission as potentially re-entrant.

In Rust, temporary mutex guards in function arguments and `if let` scrutinees may live longer than expected. Copy or clone the protected value in a separate statement, allow the guard to drop, and only then call code that may reacquire state.

Avoid holding runtime, lifecycle, bridge, or quit-state locks across:

- callbacks;
- snapshot construction;
- state/event publication;
- sidecar requests;
- database operations;
- tracing or shutdown work.

#### Preserve sidecar observability and response progress

Sidecar stdout response demultiplexing is a critical path. Notification handling must not prevent responses from reaching pending RPC callers.

- Route responses promptly by request ID.
- Process notifications separately when they may perform locking, persistence, or UI publication.
- Bound protocol frames and request timeouts.
- Remove pending requests and unblock all waiters on transport failure.
- Distinguish spawn, handshake, profile initialization, transport, stderr, and unexpected-exit failures.
- Log native lifecycle diagnostics with agent identity and phase.
- Suppress expected-shutdown noise.
- Do not forward raw native diagnostics to the webview by default.

#### Preserve exact identity across boundaries

Keep the selected agent ID, configuration path, fingerprint, and runtime instance aligned. A global/default startup setting must not silently override a specifically selected catalog entry.

Retain per-agent initialization failures at the catalog/runtime-manager boundary instead of collapsing them into a generic attention state. Error messages should identify the relevant profile and failure phase.

#### Normalize persisted data before rendering

Do not assume persisted data has the ideal API representation. Normalize boundary values centrally and use the same normalization for sorting, comparison, and display.

In particular, timestamps may be ISO strings, numbers, or epoch-millisecond strings. Do not pass arbitrary strings directly to `new Date(...)` and assume they are valid. Handle blank and invalid values explicitly and test every supported persisted form.

For JSON/profile editors, provide actionable parse diagnostics such as line and column. Detect common typographic punctuation mistakes without rejecting smart punctuation that occurs inside otherwise valid string values.

#### Reconcile multiple data projections deliberately

Durable workbench records, live runtime state, trace reports, exports, and rendered views are different projections and may become available independently.

When UI surfaces disagree:

1. Inspect each source independently.
2. Prefer durable persisted data as a fallback.
3. Merge sources only where their semantics permit it.
4. Resolve and deduplicate artifacts against the actual workspace files.
5. Do not assume that an empty trace projection means no result exists.

#### Make refresh behavior converge

Events, polling, and timers can overlap. Avoid "most recently started request wins" logic when later requests can continuously discard earlier successful results.

Prefer:

- one request in flight;
- one coalesced trailing refresh;
- applying every completed valid response;
- polling only as a missed-event fallback;
- explicit no-argument event callback wrappers;
- teardown of listeners and timers.

#### Use evidence before speculative fixes

For native hangs:

1. Verify the actual running commit and rebuilt binary.
2. Inspect the process and sidecar tree.
3. Capture a short native stack sample or debugger backtrace.
4. Distinguish true lock waits from normal parked workers, event loops, channel receivers, and pipe readers.
5. Map blocked frames to exact source lines.
6. Rebuild, restart, and repeat the sample after the fix.

Once fresh native evidence shows no deadlock, stop making speculative native changes and move investigation to IPC completion, renderer state, data handling, and DOM rendering.

Payload reduction is useful for isolating the first failing record or field, but truncating the payload is not a production fix.

#### Validate the original workflow

Compilation and unit tests are necessary but do not prove that a native interaction or rendered workflow is fixed.

After focused regression tests, run the package's declared:

- Rust formatting, checks, and tests;
- frontend tests;
- Svelte/TypeScript typecheck;
- production web build;
- diff checks.

Then, when practical, repeat the original packaged or development UI workflow with the full realistic payload. Record when manual GUI verification was not performed.
