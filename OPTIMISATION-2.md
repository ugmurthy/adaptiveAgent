# Performance Optimisation Proposal for `packages/core`

## Scope

This document critically examines the runtime algorithm and built-in tools in
`packages/core` from a performance point of view. It focuses on:

- `AdaptiveAgent` execution and resume loops.
- Delegation and child-run execution.
- Runtime persistence stores, especially PostgreSQL.
- Model adapters and provider request handling.
- Built-in tools such as file, web, search, shell, and PDF utilities.

The goal is not the smallest patch. The goal is a realistic performance roadmap
that preserves durability and resumability while reducing latency, cost, memory
use, and storage amplification.

## Executive assessment

`packages/core` is currently optimized for correctness, resumability, and
observability. That is a reasonable early-stage tradeoff, but several structural
choices will limit throughput and increase cost as runs become larger or more
parallel:

1. Full tool outputs are appended to model history and resent on every later
   model request.
2. Snapshots persist full cumulative execution state, including full message
   history.
3. PostgreSQL persistence performs many read-before-write operations and uses
   `MAX(seq) + 1` event sequencing.
4. Tool timeout handling races the tool promise but does not abort the tool's
   `AbortSignal`, so timed-out work can continue in the background.
5. The runtime executes pending tool calls serially even when the model returns
   multiple independent safe tool calls.
6. Delegation creates child runs but waits for them inline, so delegation is not
   operationally parallel.
7. SDK-backed model adapters bypass the shared base adapter's gate, cooldown,
   and retry behavior.

The highest-value path is to first contain prompt and persistence bloat, then
reduce PostgreSQL round trips, then add bounded parallelism for safe reads and
searches.

## Current hot paths and bottlenecks

### 1. Prompt and model-context growth

The runtime loop stores every assistant message and every tool result in
`state.messages`. Tool results are encoded through `toolResultMessage(...)` as
`JSON.stringify(output)`. Each subsequent model request sends the entire message
history.

This means a single large tool result from `read_file`, `read_web_page`,
`shell_exec`, PDF extraction, or a delegated child result can be paid for many
times:

- prompt tokens,
- request serialization,
- provider latency,
- snapshot bytes,
- event payload bytes,
- log summarization cost.

This is likely the largest cost driver for cloud-model runs.

### 2. Snapshot amplification

Snapshots store serialized execution state. Since state includes cumulative
messages, and messages include tool outputs, the total persisted snapshot bytes
can grow approximately quadratically with step count for tool-heavy runs.

For example, if each step adds a 50 KiB tool result and snapshots are written
after each step, the runtime persists roughly:

```text
50 KiB + 100 KiB + 150 KiB + ... + N * 50 KiB
```

This is not a TypeScript micro-optimization issue; it is a state-model issue.

### 3. PostgreSQL write and read amplification

The PostgreSQL store currently favors simple full-row semantics:

- `updateRun()` reads the row before updating it.
- `updateExecution()` reads the execution before updating it.
- `append()` computes per-run event sequence with `COALESCE(MAX(seq), 0) + 1`.
- Snapshot save reads latest snapshot before inserting the next snapshot.

This is acceptable for small sequential runs. It becomes a bottleneck for:

- local or fast models,
- many short tool calls,
- high-concurrency runs,
- parallel tools,
- large snapshots,
- long run histories.

### 4. Timeout without cancellation

The tool timeout wrapper races a timer against the tool promise, but it does not
abort the tool context signal. Fetches, child processes, PDF extraction, pandoc,
or other work can continue after the runtime has already treated the tool as
timed out.

This wastes resources and can lead to late side effects or late event emission.
This should be treated as correctness and performance work.

### 5. Serial pending tool execution

When a model returns multiple tool calls, the runtime pushes them all into
`pendingToolCalls`, but the loop executes only the first pending tool call. This
is deterministic and easy to recover, but it leaves clear wall-clock wins on the
table for independent read-only work such as web search, page reads, and file
reads.

### 6. Inline delegation

Delegation persists a child-run boundary, then immediately executes and awaits
the child run in the same call stack. The parent status may become
`awaiting_subagent`, but operationally the parent is blocked until the child
finishes.

This keeps scheduling simple, but it does not deliver parallel subagent
throughput and can interact poorly with parent lease semantics for long child
runs.

### 7. Adapter inconsistency

The base OpenAI-compatible adapter has useful request gating, cooldown, and
retry logic. SDK-backed adapters override `generate()` and call provider SDKs
directly, bypassing much of that behavior. Under load or provider throttling,
this can produce uneven retry behavior across providers.

## Proposal by phase

### Phase 0: Add measurement before major rewrites

Add explicit performance measurements to events and/or structured logs:

- DB query count and total DB time per run and per step.
- Event payload byte size.
- Snapshot state byte size.
- Tool raw output bytes and model-visible output bytes.
- Model request serialized byte size and message count.
- Adapter gate wait, retry delay, response latency, and status code.
- Tool duration and timeout/cancel outcome.
- Number of pending tool calls returned by each model response.

This should be low risk and will prevent optimizing the wrong layer. Cloud-model
runs may be dominated by prompt size and provider latency; local-model runs may
be dominated by persistence overhead.

### Phase 1: Contain output, prompt, and snapshot bloat

This is the highest-impact phase.

#### Separate raw tool output from model-visible output

Extend `ToolDefinition` with a model-format hook:

```ts
export interface ToolDefinition<I extends JsonValue = JsonValue, O extends JsonValue = JsonValue> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  timeoutMs?: number;
  requiresApproval?: boolean;
  capture?: CaptureMode;
  redact?: ToolRedactionPolicy;
  retryPolicy?: ToolRetryPolicy;
  budgetGroup?: string;
  summarizeResult?: (output: O) => JsonValue;
  formatResultForModel?: (output: O, context: ToolResultFormatContext) => JsonValue;
  maxModelResultBytes?: number;
  execute(input: I, context: ToolContext): Promise<O>;
}
```

Then use `formatResultForModel` for `toolResultMessage(...)`, not the raw output.
Raw output can be persisted in `tool_executions` or artifact storage when needed.
Events and logs should use `summarizeResult` by default.

Guardrail: truncation must be explicit. Every capped result should include
metadata such as `truncated`, `bytesReturned`, `bytesAvailable`, and a suggested
follow-up input to read more.

#### Add default model-result caps

Add a default cap for model-visible tool results, such as 16-64 KiB, with
tool-specific overrides.

Recommended defaults:

- `read_file`: return bounded content with line or byte continuation hints.
- `read_web_page`: prefer excerpts plus title and URL when `objective` is set.
- `web_search`: return compact search results and keep diagnostics out of the
  model-visible payload unless useful.
- `shell_exec`: return capped head/tail output and truncation metadata.
- PDF extraction: cap pages and extracted text length.
- Delegate tools: summarize child output before feeding it back to the parent
  unless an explicit schema requires the full object.

#### Add range-oriented file and page reads

For `read_file`, support inputs such as:

```ts
interface ReadFileInput {
  path: string;
  lineStart?: number;
  lineEnd?: number;
  offsetBytes?: number;
  maxBytes?: number;
}
```

Large reads should return continuation hints instead of full content:

```json
{
  "path": "report.txt",
  "content": "...",
  "truncated": true,
  "next": { "lineStart": 401, "lineEnd": 800 }
}
```

For `read_web_page`, add similar continuation around extracted text and make
`relevantExcerpts` the default when an objective is present.

#### Fix timeout cancellation

Change the timeout flow so the timeout owner can abort the tool context signal.
The current wrapper accepts a signal but does not use it for cancellation.

Target behavior:

```ts
async function runToolWithTimeout<T>(timeoutMs: number, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    return await task(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}
```

Then ensure built-in tools observe abort:

- fetch-based tools pass the signal to `fetch`,
- pandoc and shell tools kill child processes,
- PDF extraction checks the signal between pages,
- archive and parquet extraction checks the signal between expensive phases.

#### Add lazy logging

Several debug logs compute summaries before knowing whether the log will be
emitted. Introduce a lazy logging helper:

```ts
this.logLifecycleLazy('debug', 'model.request', () => ({
  ...runLogBindings(run),
  ...summarizeModelRequestForLog(modelRequest),
}));
```

This avoids walking large message histories or tool outputs when debug logging is
disabled.

#### Reduce duplicated tool schema in prompts

The runtime sends provider-native tool schemas through `tools`, and also injects
a JSON tool manifest into the system prompt. Disable the full manifest by
default for native tool-calling models and keep only short behavioral guidance.

Also wire `RunRequest.allowedTools` and `RunRequest.forbiddenTools` into runtime
tool visibility. Smaller per-run tool sets reduce provider schema tokens and
improve model tool selection.

### Phase 2: Reduce PostgreSQL amplification

#### Replace `MAX(seq) + 1` event sequencing

Create a per-run event counter table:

```sql
create table agent_run_event_counters (
  run_id uuid primary key references agent_runs(id) on delete cascade,
  next_seq bigint not null default 1
);
```

Append with a counter update:

```sql
with allocated as (
  update agent_run_event_counters
  set next_seq = next_seq + 1
  where run_id = $1
  returning next_seq - 1 as seq
)
insert into agent_events (
  run_id, plan_execution_id, seq, step_id, tool_call_id,
  event_type, schema_version, payload
)
select $1, $2, allocated.seq, $3, $4, $5, $6, $7
from allocated
returning *;
```

This avoids scanning prior events and gives deterministic per-run ordering under
concurrency.

#### Add `appendMany`

Add an optional batch API:

```ts
export interface EventStore {
  append(event: Omit<AgentEvent, 'id' | 'seq' | 'createdAt'>): Promise<AgentEvent>;
  appendMany?(events: Array<Omit<AgentEvent, 'id' | 'seq' | 'createdAt'>>): Promise<AgentEvent[]>;
  listByRun(runId: UUID, afterSeq?: number): Promise<AgentEvent[]>;
}
```

Use it when persisting related transitions:

- tool completion + step completion + snapshot created,
- model retry chains,
- delegation spawn boundaries,
- delegation resolution boundaries,
- terminal transition events.

#### Avoid reading latest snapshot before every snapshot save

Use a snapshot counter or a `run_current_state` row rather than calling
`getLatest()` before every insert.

Example current-state table:

```sql
create table run_current_state (
  run_id uuid primary key references agent_runs(id) on delete cascade,
  snapshot_seq bigint not null,
  status text not null,
  summary jsonb not null,
  state jsonb not null,
  updated_at timestamptz not null default now()
);
```

Full historical snapshots can then be saved at durable recovery boundaries:

- run creation,
- approval request/resolution,
- delegation spawn/resolution,
- terminal transitions,
- every N steps,
- or when state changes exceed M bytes.

#### Make hot-path updates single-query

Replace full-row read-before-update with dynamic partial updates for common
patches:

```sql
update agent_runs
set status = $2,
    current_step_id = $3,
    updated_at = $4,
    version = version + 1
where id = $1 and version = $5
returning *;
```

Disallow immutable fields in patches rather than rereading the row to validate
them in every hot-path update.

### Phase 3: Normalize adapter throttling, retries, and input caching

#### Share gated retry execution across adapters

Extract the base adapter's gate and retry loop into a protected helper:

```ts
protected async executeWithGateAndRetry<T>(
  request: ModelRequest,
  invoke: () => Promise<T>,
): Promise<T>;
```

Use it in all adapters, including OpenRouter, Mistral, and Mesh SDK adapters.

#### Normalize provider SDK errors

Map SDK errors into shared retry classes:

- `429`: rate limit,
- `500`, `502`, `503`, `504`, `524`: provider transient,
- network failures: network,
- abort/timeouts: timeout.

Emit consistent `model.retry` events regardless of adapter.

#### Cache local input materialization

Cache repeated local input conversion by `{ path, size, mtimeMs, mimeType }`:

- image data URLs,
- file data URLs,
- audio base64,
- text-like file inline content.

This prevents rereading and reencoding the same attachments on every model turn.

### Phase 4: Add bounded parallelism for safe tool batches

Only do this after output caps and persistence batching are in place.

Add tool metadata:

```ts
type ToolParallelism = 'exclusive' | 'read_only_safe';

export interface ToolDefinition<I extends JsonValue = JsonValue, O extends JsonValue = JsonValue> {
  parallelism?: ToolParallelism;
  resourceKey?: (input: I) => string;
}
```

Initial safe tools:

- `read_file`,
- `read_web_page`,
- `web_search`,
- possibly PDF extraction with a CPU concurrency cap.

Keep these exclusive initially:

- `write_file`,
- `shell_exec`,
- delegate tools,
- approval-gated tools,
- tools with unknown side effects.

Execution rules:

1. Take the longest prefix of pending read-only-safe tool calls.
2. Execute with bounded concurrency, such as `maxParallelToolsPerRun = 2` or `4`.
3. Append tool result messages in original tool-call order.
4. Persist lifecycle events in deterministic order, preferably with `appendMany`.
5. Abort remaining in-flight tools if one fails terminally.
6. Keep approval handling serial.

This should materially improve web/search/read-heavy runs without allowing
unsafe mutation parallelism.

### Phase 5: Make delegation truly asynchronous

Current delegation creates a child run but waits inline for that child to finish.
A scalable delegation design would be scheduler-driven:

1. Parent persists child spawn boundary.
2. Parent transitions to `awaiting_subagent` and returns or pauses.
3. A worker leases and executes child runs independently.
4. Parent resumes when the child reaches a terminal status.
5. Later, allow multiple active children for fan-out/fan-in delegation.

This is a larger runtime design change. It is justified if the system needs
parallel research, long-running children, or high-throughput subagent execution.
If delegation is mostly for organizational prompt isolation, keep inline
delegation and at least fix lease heartbeat/cancellation semantics.

## Built-in tool recommendations

### `read_file`

Problems:

- Reads whole files into memory before extraction.
- Default 10 MiB input can become huge model context.
- ZIP, PDF, parquet, and pandoc paths can be CPU or memory heavy.
- No default summarized event payload for returned file content.

Recommendations:

- Add line and byte range reads.
- Add default model-visible output cap.
- Add `summarizeResult` and `formatResultForModel`.
- Cache file stat and extracted text within a run.
- Add abort checks around ZIP, PDF, parquet, and pandoc phases.
- Add PDF `maxPages` and `maxTextLength`.

### `read_web_page`

Problems:

- No URL cache.
- Full extracted text up to 50,000 chars can be resent repeatedly.
- Regex stripping is fast but often noisy.

Recommendations:

- Cache by URL within a run.
- Prefer relevant excerpts when `objective` is provided.
- Return continuation hints for truncated text.
- Track fetched bytes and extracted text bytes.

### `web_search`

Problems:

- DuckDuckGo path can make multiple sequential HTTP requests.
- No provider-level cache or rate limiter.
- No max HTML body cap for fallback pages.

Recommendations:

- Cache by effective query within a run.
- Add provider-level rate limiting.
- Add max response body size for DuckDuckGo HTML/deep paths.
- Prefer API-backed search for production workloads.

### `shell_exec`

Problems:

- Uses `exec`, which buffers output.
- Timeout does not currently guarantee abort.
- Max-buffer errors are flattened into generic exit output.

Recommendations:

- Replace with `spawn`.
- Stream stdout and stderr into bounded buffers.
- Return head/tail output and truncation metadata.
- Kill process tree on abort where possible.

### `list_directory`

Problems:

- Returns all entries.
- No pagination or filtering.

Recommendations:

- Add `maxEntries`, `cursor`, and optional glob/filter.
- Sort deterministically.
- Return truncation metadata.

### PDF extraction

Problems:

- Extracts pages sequentially with no page or text cap.
- No direct abort checks inside the page loop.

Recommendations:

- Add `maxPages` and `maxTextLength`.
- Check abort between pages.
- Consider worker-thread isolation only if large PDFs are common.

## Suggested implementation order

1. Add runtime performance metrics and byte accounting.
2. Fix real timeout cancellation for tools.
3. Split raw tool output from model-visible output.
4. Add caps, summaries, and continuation hints to built-in tools.
5. Add lazy logging for expensive summaries.
6. Wire per-run tool filtering and make full tool manifest opt-in by default.
7. Add PostgreSQL event counters, snapshot counters/current state, and
   `appendMany`.
8. Normalize adapter gated retries and add local input caching.
9. Add bounded parallelism for safe read-only tool batches.
10. Move delegation to an asynchronous worker model if product requirements need
    true subagent parallelism.

## Expected impact

- Prompt and token reduction: potentially 10x-100x on file, web, and
  shell-heavy runs.
- Snapshot and event storage reduction: large, especially once raw outputs are
  no longer duplicated across messages, snapshots, events, and logs.
- DB round-trip reduction: likely 30-60% per step after batching and single-query
  updates.
- Wall-clock latency reduction: meaningful for web/search/read-heavy runs after
  safe tool parallelism.
- Operational stability: improved after real cancellation and consistent adapter
  retry/gating.

## Key risks and guardrails

- Do not truncate silently. Always include metadata and continuation hints.
- Do not parallelize mutation tools by default.
- Preserve deterministic tool result ordering for model API compatibility.
- Avoid duplicating raw output in tool executions, events, snapshots, logs, and
  model messages.
- Treat timeout cancellation as correctness work, not only performance work.
- Keep recoverability explicit when moving from every-step full snapshots to
  current-state rows and sparse checkpoints.

## Decision point

The first three phases are broadly useful for all workloads and should be done
before larger concurrency work. Phases 4 and 5 should be driven by product needs:

- If workloads are mostly simple sequential assistant runs, bounded output and DB
  improvements are enough.
- If workloads involve research, many web reads, local models, or high run
  concurrency, safe tool parallelism becomes important.
- If subagents are expected to run independently or in parallel, delegation needs
  an asynchronous scheduler rather than inline child execution.
