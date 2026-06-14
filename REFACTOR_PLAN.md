# Refactor Plan for `@adaptive-agent/core`

## Purpose

Refactor `packages/core` so the runtime is easier for humans to read, faster on
hot paths, and lower in memory/storage amplification, without changing the
public API surface or existing runtime nomenclature.

This plan treats the current core as stable production code that has grown over
time. The refactor should preserve behavior first, then optimize the internals.
Streaming-backed provider inference is included as a future-facing requirement
and must follow `STREAM_PLAN.md`: adapters may use streaming internally, but the
runtime boundary remains `generate(request: ModelRequest): Promise<ModelResponse>`.

## Non-negotiable constraints

- Do not change exported public names, method signatures, event names, status
  names, type names, or persisted field names unless a later explicit migration
  task approves it.
- Do not rename existing functions or variables for style alone. Moving code to
  smaller internal files is allowed only when the existing names and behavior are
  preserved.
- Keep `AdaptiveAgent` as the public facade and keep these public methods as-is:
  `run`, `chat`, `plan`, `executePlan`, `interrupt`, `steer`,
  `resolveApproval`, `resolveClarification`, `resume`, `retry`,
  `getRetryability`, `getRecoveryOptions`, `continueRun`, and
  `createContinuationRun`.
- Keep `ToolDefinition` as the only first-class executable primitive. Plans,
  delegates, skills, and swarms must still execute through normal runtime runs
  and tools.
- Preserve core vs Agent SDK ownership from `CORE-SESSION-SWARM-SPEC.md`:
  core owns durable runtime semantics; Agent SDK owns agent-profile loading,
  CLI setup, catalog prompts, and user-facing command behavior.
- Do not introduce deferred concepts as part of this refactor: generalized DAG
  execution, parallel child runs, child messaging, chain-of-thought persistence,
  separate `swarmId`, or a skills runtime expansion.
- Use Bun-native verification.

## Current assessment

### What is already healthy

- The runtime contracts are explicit and typed in `packages/core/src/types.ts`.
- `sessionId`, `coordinatorRunId`, worker/quality/synthesizer roles, child runs,
  continuation, snapshots, and eventing are already represented in the core data
  model.
- Built-in tools have already moved in the right direction: `read_file`,
  `read_web_page`, `web_search`, `shell_exec`, and `list_directory` include
  model-visible result caps, summaries, pagination/range inputs, or bounded
  output behavior.
- Tool timeout now aborts the tool context signal, and built-in network/process
  tools mostly observe that signal.
- Adapter tests already cover important OpenAI-compatible behavior, retry,
  usage, delegate tool aliasing, structured output, and provider-specific SDK
  normalization.

### Main bloat and readability pressure

- `packages/core/src/adaptive-agent.ts` is the primary bloat point. It contains
  the public facade, execution loop, tool call execution, approval and
  clarification handling, retryability analysis, delegation recovery,
  continuation, state serialization, prompt construction, file input
  normalization, persistence coordination, logging, and JSON helpers in one
  large file.
- A large portion of that file is valid runtime logic, not dead code. The problem
  is concentration: local reasoning requires too much scrolling and too many
  unrelated helpers in the same module.
- Several helper groups are separable without changing behavior:
  - execution state serialization/deserialization;
  - prompt/message construction;
  - model turn orchestration;
  - tool call execution and model-visible result formatting;
  - run lifecycle persistence;
  - approval/clarification/steer message handling;
  - retryability and failure classification.

### Main speed and memory pressure

- Full execution state, including cumulative `messages`, is still saved in
  snapshots. This remains the largest durable-state amplification risk for long
  tool-heavy runs.
- `saveExecutionSnapshotWithStores()` reads the latest snapshot before saving
  the next one. Under a lease, the runtime can usually know the next snapshot
  sequence internally and avoid that read.
- PostgreSQL event append still uses `COALESCE(MAX(seq), 0) + 1`, which scans or
  indexes existing events on every append and is fragile under future concurrent
  append pressure.
- `PostgresRunStore.updateRun()` reads the full run before update even for hot
  patches that only touch mutable fields.
- In-memory stores use `structuredClone` at boundaries. That protects callers
  from mutating store state, but it becomes expensive for large snapshots and
  events.
- Adapter local file/image/audio materialization can reread and reencode the same
  inputs on repeated model turns.
- SDK-backed adapters duplicate request normalization and bypass some shared base
  adapter gate/retry behavior.
- Several debug log call sites still build summaries before knowing whether the
  target logger level will emit the entry.

### Streaming gap

Current adapter capabilities often declare `streaming: true`, but `generate()`
still uses non-streaming SDK or HTTP completion paths. Per `STREAM_PLAN.md`, the
first streaming phase should be a transport-only change:

- `AdaptiveAgent.generateModelResponse()` continues calling
  `this.options.model.generate()`.
- Adapters may stream provider chunks internally, aggregate to the final
  `ModelResponse`, and return that final response.
- Partial token chunks are not persisted and are not sent to gateway/TUI clients
  in this phase.

## Target internal architecture

The public shape stays the same. Internally, `AdaptiveAgent` becomes a thin
facade over smaller runtime components.

```diagram
+------------------------------+
| AdaptiveAgent public facade   |
+--------------+---------------+
               | same public methods
               v
+------------------------------+
| internal runtime context      |
| options, defaults, logger,    |
| stores, toolRegistry          |
+-------+----------------+-----+
        |                |
        v                v
+---------------+  +----------------+
| Run lifecycle |  | Execution loop |
| leases,       |  | steps, pending |
| transitions   |  | tool calls     |
+-------+-------+  +-------+--------+
        |                  |
        v                  v
+---------------+  +----------------+
| Persistence   |  | Tool call      |
| snapshots,    |  | execution,     |
| events, usage |  | budgets, output|
+---------------+  +-------+--------+
                         |
                         v
                  +-------------+
                  | Model turn  |
                  | request,    |
                  | retry, usage|
                  +------+------+
                         |
                         v
                  +-------------+
                  | ModelAdapter|
                  | generate()  |
                  +-------------+
```

Suggested internal modules, not exported from `packages/core/src/index.ts`:

- `runtime/execution-state-codec.ts`
  - Move `serializeExecutionState`, `deserializeExecutionState`, model message
    guards, pending tool-call guards, and related JSON helpers.
- `runtime/prompt-messages.ts`
  - Move `buildAgentSystemMessage`, `buildRuntimeToolManifestMessage`,
    `buildInitialMessages`, `buildInitialChatMessages`, output schema guidance,
    chat goal summarization, and system-message normalization.
- `runtime/model-turn.ts`
  - Move the body of `generateModelResponse`, structured output repair helpers,
    model retry event construction, and usage application coordination.
- `runtime/tool-call-runner.ts`
  - Move `executePendingToolCall`, `formatToolOutputForModel`, budget admission,
    tool lifecycle event construction, idempotency key handling, and timeout
    execution.
- `runtime/run-lifecycle.ts`
  - Move `createRunWithInitialSnapshot`, `saveExecutionSnapshot`, terminal
    transitions, `completeRun`, `failRun`, `transitionRun`, lease helpers, and
    run result conversion.
- `runtime/interaction-resolution.ts`
  - Move approval, clarification, interrupt, steer routing, pending steer message
    append/drain, and interaction-specific snapshot updates.
- `runtime/retryability.ts`
  - Move failed-run retryability, child retryability, invalid tool-call repair
    retryability, failure classification, and retry delay helpers that are still
    in `adaptive-agent.ts`.
- `runtime/file-input-normalization.ts`
  - Move `normalizeFileInputsForReadFile`, chat file normalization,
    materialization, and content part summaries.

The exact file names can change, but the principle should not: split by runtime
responsibility, not by arbitrary line count.

## Phase 0: Baseline and API guardrails

Goal: make refactoring safe before moving code.

Implementation:

1. Capture a before/after public API declaration diff for `@adaptive-agent/core`.
   The useful check is declaration output comparison, not a code style diff.
2. Run the current focused test baseline:
   - `bunx vitest run packages/core/src/adaptive-agent.test.ts`
   - `bunx vitest run packages/core/src/adapters/adapters.test.ts`
   - `bunx vitest run packages/core/src/postgres-runtime-stores.test.ts`
   - `bunx vitest run packages/core/src/swarm-coordinator.test.ts`
   - `bun run --cwd packages/core build`
3. Record current rough metrics from tests or a small local run:
   - model request bytes;
   - model response bytes;
   - model-visible tool output bytes;
   - snapshot state bytes;
   - event payload bytes;
   - number of run-store/event-store/snapshot-store calls per step;
   - adapter gate wait, retry delay, and response latency.

Guardrail:

- If declaration output changes, the refactor stops unless the change is
  explicitly approved as a separate API migration.

## Phase 1: Mechanical readability refactor

Goal: reduce `adaptive-agent.ts` without changing behavior.

Implementation:

1. Move pure helper groups first:
   - execution-state codec;
   - prompt/message builders;
   - JSON guards;
   - failure classification;
   - content part summaries.
2. Keep function names intact when moving helpers. Do not rename for aesthetics.
3. Keep `AdaptiveAgent` method bodies behaviorally identical during the first
   move. Public methods may call internal functions/classes, but return values,
   thrown errors, event ordering, and snapshots must remain unchanged.
4. Move stateful runtime logic only after pure helpers are stable:
   - model turn runner;
   - tool call runner;
   - run lifecycle persistence;
   - interaction resolution.
5. Avoid new abstractions that merely wrap one line. A component is justified
   only if it owns a real responsibility and reduces cross-cutting state.

Expected result:

- `AdaptiveAgent` reads as the public facade and high-level control flow.
- Runtime implementation details live in focused internal files.
- Tests remain green after each small extraction.

## Phase 2: Snapshot and state memory reduction

Goal: reduce repeated serialization and snapshot overhead while keeping replay
semantics.

Implementation:

1. Centralize `ExecutionState` serialization in `execution-state-codec.ts`.
2. Track the current snapshot sequence internally while a run is leased:
   - initial run creation knows `snapshotSeq = 1`;
   - resume loads the latest snapshot and knows its `snapshotSeq`;
   - subsequent saves increment the known sequence in memory.
3. Keep `SnapshotStore.save()` and `SnapshotStore.getLatest()` unchanged.
   The optimization is in the runtime call pattern, not in the public store
   interface.
4. Continue saving snapshots at the same behavioral boundaries at first. Do not
   reduce snapshot frequency in the same patch that removes the latest-snapshot
   read.
5. After sequence tracking is stable, evaluate sparse historical snapshots plus
   a current-state row as a separate migration. That requires explicit approval
   because it changes persistence behavior even if public TypeScript APIs stay
   unchanged.
6. Review in-memory store clone boundaries:
   - keep defensive clones on public reads/writes;
   - avoid clone chains where one internal store immediately clones data already
     cloned by the caller;
   - avoid cloning for no-op listener paths;
   - keep tests proving callers cannot mutate stored state.

Guardrail:

- A run resumed after every persisted snapshot boundary must produce the same
  next model request and same terminal result as before the refactor.

## Phase 3: Persistence hot-path optimization

Goal: reduce PostgreSQL query count and write amplification without changing the
store interfaces.

Implementation:

1. Replace event sequence allocation internally:
   - add an additive migration for a per-run event counter table;
   - keep `EventStore.append()` unchanged;
   - make `PostgresEventStore.append()` allocate `seq` with an update/insert
     counter operation instead of `MAX(seq) + 1`.
2. Add fast paths inside `PostgresRunStore.updateRun()` for common mutable
   patches:
   - lease acquire/heartbeat/release already use dedicated queries;
   - status/current step/current child/usage/result/error/metadata patches can
     avoid the preliminary `getRun()` when `expectedVersion` is supplied;
   - fallback to the current read-and-validate path for uncommon patches or
     patches that mention immutable fields.
3. Keep immutable-field validation. Fast paths must fail closed rather than
   silently accepting a changed `sessionId`, `rootRunId`, `parentRunId`,
   `parentStepId`, `delegateName`, `delegationDepth`, `modelProvider`,
   `modelName`, or `modelParameters`.
4. Keep transaction semantics through the existing `RuntimeTransactionStore`.
   Do not add public `appendMany()` or public batch APIs in this refactor.
5. Where several events are constructed together, compute payload performance
   once and avoid repeated `JSON.stringify` for byte metrics.

Guardrail:

- Event order for one run remains strictly monotonic by `seq`.
- Existing migrations remain valid for old databases, and new migrations are
  additive.

## Phase 4: Model adapter cleanup and streaming-backed `generate()`

Goal: reduce adapter duplication and implement streaming transport without
changing the model contract.

Implementation:

1. Follow `STREAM_PLAN.md` exactly for the first streaming phase:
   - no `ModelRequest` change;
   - no `ModelResponse` change;
   - no `AdaptiveAgent` change to call `model.stream()`;
   - no persisted partial chunk events;
   - no UX token streaming.
2. Extract adapter-local pure helpers before changing transport:
   - provider tool-name aliasing;
   - OpenAI-compatible response parsing;
   - usage/cost mapping;
   - SDK request/response field-name normalization;
   - local input materialization.
3. Use a shared internal invocation helper for gate/retry/diagnostics across
   HTTP and SDK adapters. Prefer a module-level internal helper over adding
   public/protected class surface to exported adapter classes.
4. Implement streaming-backed `generate()` provider by provider:
   - Mesh first;
   - OpenAI-compatible base path for Ollama-compatible endpoints;
   - OpenRouter SDK;
   - Mistral SDK.
5. Add a stream accumulator only when two providers need materially identical
   logic. Until then, keep provider-local mapping small and explicit.
6. Preserve parity requirements from `STREAM_PLAN.md`:
   - concatenate text deltas in order;
   - reconstruct tool calls by index/id/name/argument fragments;
   - parse structured output from final text only after stream completion;
   - preserve finish reason, usage, provider response id, reasoning fields, and
     performance where provider data is available;
   - do not retry automatically after partial chunks are received.
7. Add bounded local input materialization cache keyed by path, size, mtime,
   mime type, and provider format. This avoids rereading/reencoding the same
   image/file/audio input across repeated model turns.

Guardrail:

- Existing core tests should not need to know whether an adapter used streaming
  internally.
- Provider-specific parity exceptions, especially missing stream usage, must be
  documented before streaming becomes the default for that provider.

## Phase 5: Execution-loop hot-path cleanup

Goal: reduce CPU work per step without changing step semantics.

Implementation:

1. Add lazy logging for expensive debug summaries:
   - model request summaries;
   - model response summaries;
   - snapshot summaries;
   - large tool input/output summaries.
2. Cache runtime tool manifest messages by visible tool set and
   `injectToolManifest` setting. `plannerTools` is already cached; the stringified
   manifest should not be rebuilt repeatedly for identical visibility.
3. Avoid repeated system-message normalization when state messages have not
   changed since the last model turn.
4. Keep pending tool calls serial. Do not introduce safe tool parallelism under
   the current API freeze because safe host custom-tool parallelism needs public
   metadata or a policy hook.
5. Keep delegate child runs inline unless a separate scheduler design is
   explicitly approved. This refactor must not introduce parallel child runs.

Guardrail:

- For a model response with multiple tool calls, model-visible tool result
  messages remain appended in the same order as today.

## Phase 6: Built-in tool memory and cache hygiene

Goal: keep existing tool names and schemas while making large inputs cheaper.

Implementation:

1. `read_file`:
   - for direct text files with `offsetBytes`/`maxBytes`, read only the requested
     byte range from disk when possible instead of loading the whole file;
   - keep whole-file extraction for PDF, ZIP, Parquet, and pandoc formats until
     a format-specific range strategy exists;
   - keep current truncation metadata and continuation hints.
2. `read_web_page` and `web_search`:
   - keep per-run caches but add bounded size/entry limits;
   - include cache metrics in debug logs without exposing cache internals to the
     model;
   - keep objective-driven excerpts as the preferred model-visible payload.
3. `shell_exec`:
   - keep `spawn` and bounded buffers;
   - ensure abort kills the process tree on supported platforms and resolves to
     one terminal output path.
4. `list_directory`:
   - keep deterministic sorting, pagination, filtering, and summary output;
   - avoid reading unnecessary metadata until a caller asks for it.
5. PDF/parquet/archive extraction:
   - continue checking abort between expensive phases;
   - keep maximum rows, entries, and cell lengths;
   - consider worker-thread isolation only if large document extraction becomes
     a proven bottleneck.

Guardrail:

- Do not silently drop content. Any cap must include `truncated`, byte/line
  counts where available, and a `next` hint when continuation is possible.

## Phase 7: Swarm and delegation cleanup inside current boundaries

Goal: keep current core orchestration semantics readable without moving CLI or
agent-profile responsibilities into core.

Implementation:

1. Keep `SwarmCoordinator` as a programmatic core helper/prototype. Do not add
   CLI catalog loading or agent JSON resolution to core.
2. Replace repeated `as unknown as JsonValue` casts with small internal JSON
   object builders where that improves readability and type safety.
3. Keep worker runs as independent root runs grouped by `sessionId` and
   `coordinatorRunId`.
4. Keep delegate child runs for `delegate.*` tool execution only.
5. Preserve all terminology exactly:
   `top-level objective`, `subObjective`, `worker run`, `quality run`,
   `synthesizer run`, `child run`, `coordinatorRunId`, and `replan.required`.

Guardrail:

- Do not duplicate agent definition fields such as model, instructions,
  delegates, or allowed tools into orchestration task objects.

## Verification matrix

Minimum checks by phase:

- Mechanical helper moves:
  - `bunx vitest run packages/core/src/adaptive-agent.test.ts`
  - `bun run --cwd packages/core build`
- Persistence changes:
  - `bunx vitest run packages/core/src/postgres-runtime-stores.test.ts`
  - `bunx vitest run packages/core/src/in-memory-event-store.test.ts`
  - focused resume/retry tests in `adaptive-agent.test.ts`
- Adapter changes:
  - `bunx vitest run packages/core/src/adapters/adapters.test.ts`
  - targeted provider tests for Mesh/OpenRouter/Mistral/Ollama paths
- Swarm changes:
  - `bunx vitest run packages/core/src/swarm-coordinator.test.ts`
- Built-in tool changes:
  - `bunx vitest run packages/core/src/tools/tools.test.ts`
  - `bunx vitest run packages/core/src/tools/pdf-text.test.ts`
- Final package check:
  - `bunx vitest run packages/core/src`
  - `bun run --cwd packages/core build`

For public API preservation, compare generated declarations before and after the
refactor. Any declaration diff must be classified as either:

- internal-only and not exported from `src/index.ts`; or
- a blocker requiring explicit approval.

## Success metrics

The refactor is successful when:

- `AdaptiveAgent` is significantly smaller and reads as a facade plus high-level
  runtime flow.
- No public API declaration diff is introduced.
- Existing tests pass without changing expected event names, run statuses, or
  persisted field names.
- Snapshot saves no longer require a latest-snapshot read on every save during a
  leased run.
- PostgreSQL event append no longer relies on `MAX(seq) + 1`.
- SDK-backed adapters share gate/retry/diagnostic behavior with the
  OpenAI-compatible adapter path.
- At least Mesh has streaming-backed `generate()` parity for final text, tool
  calls, finish reason, usage where available, abort, and mid-stream errors.
- Large file/web/shell-heavy runs show lower model request bytes, lower snapshot
  bytes, or lower repeated materialization cost without losing continuation
  hints.

## Risks and mitigations

- **Behavior drift during extraction:** move pure helpers first and keep tests
  green after each small patch.
- **Hidden API drift:** declaration diff before/after every phase.
- **Persistence compatibility:** use additive migrations and keep old store
  interfaces.
- **Snapshot sequence races:** rely on existing run lease semantics; fall back to
  `getLatest()` if a run is resumed without a known loaded snapshot sequence.
- **Streaming parity gaps:** make one provider default only after tests prove
  text, tool calls, usage, abort, errors, and structured output behavior.
- **Over-abstraction:** do not create generic frameworks. Extract only modules
  that map to existing core responsibilities.
- **Unsafe parallelism:** defer tool or child-run parallelism unless a separate
  design explicitly extends the policy surface.

## Resolved design decisions

These decisions should guide implementation work unless a later task explicitly
changes them:

1. The API freeze does not forbid additive PostgreSQL migrations. It applies to
   exported TypeScript/runtime APIs and public behavioral contracts. The event
   counter migration is allowed as long as it is additive and preserves existing
   store interfaces.
2. Internal files may be added under `packages/core/src/runtime` as long as
   `packages/core/src/index.ts` exports remain unchanged.
3. Hide `plan()` from public documentation until it is implemented. Keep the
   existing runtime method during this refactor for compatibility unless a
   separate approved API task removes it.
4. Mesh streaming-backed `generate()` should use a private fallback during
   burn-in. Streaming can become the normal path after parity tests and real
   usage build confidence; the fallback should be removed once no longer needed.
5. Safe tool parallelism is intentionally out of scope while the public API is
   frozen. Tool execution remains serial and deterministic in this refactor.

## Recommended implementation order

1. Establish test and declaration-diff guardrails.
2. Extract pure helper modules from `adaptive-agent.ts`.
3. Extract model turn, tool call, run lifecycle, and interaction-resolution
   internals without behavior changes.
4. Add internal snapshot sequence tracking to remove repeated latest-snapshot
   reads.
5. Add PostgreSQL event counter migration and update `PostgresEventStore.append`.
6. Add `PostgresRunStore.updateRun` fast paths for common mutable patches.
7. Add lazy logging and manifest caching.
8. Clean adapter duplication and shared invocation behavior.
9. Implement Mesh streaming-backed `generate()`, then the other providers per
   `STREAM_PLAN.md`.
10. Tighten built-in tool range reads and cache hygiene.
