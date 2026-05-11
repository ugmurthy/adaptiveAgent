# AdaptiveAgent Public API Guide

This document explains the public API exposed by [`AdaptiveAgent`](./src/adaptive-agent.ts) in `@adaptive-agent/core`.

It is intentionally consumer-focused:

- first, a quick API index
- then copyable examples
- then a critical analysis of the run restart and continuation APIs

The current public class surface is:

- `new AdaptiveAgent(options)`
- `run(request)`
- `chat(request)`
- `plan(request)`
- `executePlan(request)`
- `interrupt(runId)`
- `steer(runId, input)`
- `resolveApproval(runId, approved)`
- `resolveClarification(runId, message)`
- `resume(runId)`
- `retry(runId)`
- `getRecoveryOptions(runId)`
- `continueRun(options)`
- `createContinuationRun(options)`

`adaptive-agent.ts` also exports `SteerInput`.

## 1. Mental model

`AdaptiveAgent` is not just a stateless tool-calling wrapper. It is a run-oriented runtime with:

- durable `run` records
- snapshots for resumability
- event emission for auditability
- explicit human interaction states like `awaiting_approval` and `clarification_requested`
- child run support through delegate tools
- separate continuation runs for safe recovery from terminal failures

That design choice is the key to understanding why this API has more surface area than a simple "send prompt, get answer" agent API.

## 2. API index

| API | What it does | When to use it |
| --- | --- | --- |
| `new AdaptiveAgent(options)` | Creates a runtime-bound agent instance. | When wiring the runtime manually. |
| `run(request)` | Starts a new goal-oriented run. | Default entry point for agent execution. |
| `chat(request)` | Starts a conversational run from explicit messages. | When you already have chat history and want agent behavior. |
| `plan(request)` | Intended planning entry point. | Do not use yet; currently throws. |
| `executePlan(request)` | Executes a persisted plan through tools. | When a plan already exists in `planStore`. |
| `interrupt(runId)` | Marks an active run as interrupted. | Cooperative stop/pause. |
| `steer(runId, input)` | Queues extra guidance into an active run. | Mid-run correction without replacing the run. |
| `resolveApproval(runId, approved)` | Resolves a paused approval gate. | After host/UI gets a human decision. |
| `resolveClarification(runId, message)` | Provides the missing user answer and resumes the run. | After a run asks for clarification. |
| `resume(runId)` | Continues the same non-terminal run from stored state. | Lease expiry, interruption, or delegated child recovery. |
| `retry(runId)` | Retries the same failed run in place when policy allows. | Retryable failure on the same run boundary. |
| `getRecoveryOptions(runId)` | Analyzes whether a failed run can continue safely. | Before creating a new continuation run. |
| `continueRun(options)` | Creates and immediately executes a new continuation run. | Safe recovery after terminal failure. |
| `createContinuationRun(options)` | Creates a continuation run but does not execute it. | Review or schedule the continuation before running it. |

## 3. Minimal setup

You can construct `AdaptiveAgent` directly, but most consumers should use `createAdaptiveAgent()` so the in-memory runtime stores are wired for you.

```ts
import { createAdaptiveAgent, type ToolDefinition } from "@adaptive-agent/core";

const echoTool: ToolDefinition<{ text: string }, { echoed: string }> = {
  name: "echo",
  description: "Echo text back to the caller",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string" },
    },
    required: ["text"],
    additionalProperties: false,
  },
  async execute(input) {
    return { echoed: input.text };
  },
};

const { agent, runtime } = createAdaptiveAgent({
  model: {
    provider: "openai",
    model: "gpt-5.4-mini",
    apiKey: process.env.OPENAI_API_KEY!,
  },
  tools: [echoTool],
  defaults: {
    maxSteps: 20,
    capture: "summary",
  },
});
```

If you need durable restarts, use persistent `runStore`, `snapshotStore`, `eventStore`, and ideally `toolExecutionStore` and `continuationStore`.

## 4. Constructor API

### `new AdaptiveAgent(options: AdaptiveAgentOptions)`

Core inputs:

- `model`: the `ModelAdapter`
- `tools`: callable tools available to the runtime
- `delegates`: optional delegate profiles, exposed as synthetic `delegate.*` tools
- `runStore`: required
- `eventStore`: optional but strongly recommended
- `snapshotStore`: optional but strongly recommended for `resume()`
- `continuationStore`: required for `continueRun()` and `createContinuationRun()`
- `toolExecutionStore`: strongly recommended for exactly-once tool reuse and safer recovery
- `transactionStore`: recommended when you want event/snapshot/tool ledger writes to commit together
- `defaults`: runtime defaults like `maxSteps`, `toolTimeoutMs`, approval behavior, capture mode, and tool budgets

Example:

```ts
import {
  AdaptiveAgent,
  InMemoryContinuationStore,
  InMemoryEventStore,
  InMemoryRunStore,
  InMemorySnapshotStore,
  type AdaptiveAgentOptions,
} from "@adaptive-agent/core";

const options: AdaptiveAgentOptions = {
  model: myModelAdapter,
  tools: [echoTool],
  runStore: new InMemoryRunStore(),
  eventStore: new InMemoryEventStore(),
  snapshotStore: new InMemorySnapshotStore(),
  continuationStore: new InMemoryContinuationStore(),
};

const agent = new AdaptiveAgent(options);
```

### Postgres-backed constructor example

If you want durable stores instead of the in-memory defaults, use the Postgres runtime bundle.

```ts
import { Pool } from "pg";
import {
  AdaptiveAgent,
  POSTGRES_RUNTIME_MIGRATIONS,
  createPostgresRuntimeStores,
  type AdaptiveAgentOptions,
  type ToolDefinition,
} from "@adaptive-agent/core";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL!,
});

for (const migration of POSTGRES_RUNTIME_MIGRATIONS) {
  await pool.query(migration.sql);
}

const runtime = createPostgresRuntimeStores({
  client: pool,
});

const searchDocsTool: ToolDefinition<{ query: string }, { hits: string[] }> = {
  name: "search_docs",
  description: "Search internal documentation",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async execute(input) {
    return { hits: [`result for: ${input.query}`] };
  },
};

const options: AdaptiveAgentOptions = {
  model: myModelAdapter,
  tools: [searchDocsTool],
  delegates: [
    {
      name: "researcher",
      description: "Performs bounded research with read-only tools",
      allowedTools: ["search_docs"],
    },
  ],
  runStore: runtime.runStore,
  eventStore: runtime.eventStore,
  snapshotStore: runtime.snapshotStore,
  planStore: runtime.planStore,
  continuationStore: runtime.continuationStore,
  toolExecutionStore: runtime.toolExecutionStore,
  transactionStore: runtime,
  defaults: {
    maxSteps: 30,
    toolTimeoutMs: 60_000,
    modelTimeoutMs: 90_000,
    capture: "summary",
  },
  recovery: {
    continuation: {
      enabled: true,
      defaultStrategy: "hybrid_snapshot_then_step",
    },
    retryableErrorCodes: ["MODEL_ERROR", "INTERRUPTED"],
  },
  systemInstructions: "Prefer concise, tool-grounded answers.",
};

const agent = new AdaptiveAgent(options);
```

Options used above:

- `model`: The model adapter that actually generates responses and tool calls.
- `tools`: The first-class executable tools available to the run.
- `delegates`: Optional delegate profiles exposed as synthetic `delegate.*` tools for child runs.
- `runStore`: Persists the canonical `agent_runs` records.
- `eventStore`: Persists the ordered run event log such as `tool.started` and `run.completed`.
- `snapshotStore`: Persists resumable execution state for `resume()` and recovery.
- `planStore`: Persists plans and plan executions for `executePlan()`.
- `continuationStore`: Persists lineage between a failed source run and a new continuation run.
- `toolExecutionStore`: Persists durable tool execution records for idempotency and replay-safe reuse.
- `transactionStore`: Commits run, event, snapshot, and tool-ledger updates together when possible.
- `defaults.maxSteps`: Caps how many model/tool steps a run may use before failing with `MAX_STEPS`.
- `defaults.toolTimeoutMs`: Sets the default timeout for each tool execution.
- `defaults.modelTimeoutMs`: Sets the default timeout and lease heartbeat window for model execution.
- `defaults.capture`: Controls how much tool input/output detail is captured in logs and persisted summaries.
- `recovery.continuation.enabled`: Turns on support for creating continuation runs after safe recovery analysis.
- `recovery.continuation.defaultStrategy`: Chooses the default continuation strategy when the caller does not override it.
- `recovery.retryableErrorCodes`: Declares which run error codes may be retried in place.
- `systemInstructions`: Injects extra system guidance into the runtime prompt.

Postgres-specific setup used above:

- `Pool`: A `pg` pool that satisfies the runtime's `PostgresPoolClient` shape.
- `POSTGRES_RUNTIME_MIGRATIONS`: The SQL migrations that create the runtime tables and indexes.
- `createPostgresRuntimeStores({ client })`: Builds the full Postgres-backed store bundle from one client or pool.

Best practice for production:

- run the exported migrations in your deployment flow rather than inline at process startup
- use `createPostgresRuntimeStores({ client: pool })` so `transactionStore` support is available
- keep `snapshotStore`, `eventStore`, `continuationStore`, and `toolExecutionStore` enabled together for the strongest recovery behavior

## 5. Starting execution

### `run(request: RunRequest): Promise<RunResult>`

Starts a new goal-oriented run.

Key fields:

- `goal`: required natural-language objective
- `input`: structured input payload
- `images`: optional image inputs
- `context`: structured execution context
- `allowedTools` / `forbiddenTools`: constrain tool use
- `outputSchema`: request structured output
- `metadata`: host metadata

Example:

```ts
const result = await agent.run({
  goal: "Summarize the uploaded incident log and extract action items",
  input: {
    incidentId: "INC-204",
  },
  context: {
    team: "platform",
    priority: "high",
  },
  outputSchema: {
    type: "object",
    properties: {
      summary: { type: "string" },
      actionItems: {
        type: "array",
        items: { type: "string" },
      },
    },
    required: ["summary", "actionItems"],
    additionalProperties: false,
  },
});
```

Use `run()` when the host thinks in terms of tasks, not chat history.

### `chat(request: ChatRequest): Promise<ChatResult>`

Starts a new run from explicit messages.

Use `chat()` when the host already owns the conversation transcript and wants agent execution on top of it.

```ts
const result = await agent.chat({
  messages: [
    { role: "system", content: "You are a precise research assistant." },
    { role: "user", content: "Find likely causes for the outage trend." },
  ],
  context: {
    service: "payments-api",
  },
});
```

### `plan(request: PlanRequest): Promise<never>`

Current state:

- public but not implemented
- always throws `"plan() is not implemented in this scaffold yet"`

Treat it as reserved surface, not a production API.

### `executePlan(request: ExecutePlanRequest): Promise<RunResult>`

Executes a previously stored plan using `planStore`.

Requirements:

- `planStore` must be configured
- `planId` must already exist

```ts
const result = await agent.executePlan({
  planId: "42f3f5f8-9ba7-4f2c-bf9e-cfea9dfe5386",
  input: {
    reportDate: "2026-05-10",
  },
  context: {
    region: "apac",
  },
});
```

This is not "make a plan and run it." It is specifically "run an already persisted plan artifact."

## 6. Human-in-the-loop APIs

### `interrupt(runId: UUID): Promise<void>`

Interrupts an active run and, when present, also interrupts its active child run.

Use it for:

- cooperative stop
- pause before host maintenance
- reclaiming stale execution before explicit recovery

```ts
await agent.interrupt(runId);
```

### `steer(runId: UUID, input: SteerInput | string): Promise<void>`

Queues a new message into an active run without creating a new run.

Important behavior:

- the run must still be active, not terminal
- the message is queued into run metadata first
- it is injected on the next execution turn
- for some delegated child runs, steering may be rerouted to the parent run if the requested action needs parent-only tools

Simple form:

```ts
await agent.steer(runId, "Focus on root cause analysis, not mitigation steps.");
```

Structured form:

```ts
await agent.steer(runId, {
  role: "system",
  message: "Do not call web research tools unless existing evidence is insufficient.",
  metadata: {
    source: "dashboard-operator",
  },
});
```

`steer()` is guidance injection, not a restart primitive.

### `resolveApproval(runId: UUID, approved: boolean): Promise<void>`

Resolves a run paused in `awaiting_approval`.

```ts
await agent.resolveApproval(runId, true);
```

If approved:

- the pending tool call is marked approved
- the run is transitioned back to `running`
- execution resumes later through `resume(runId)`

If rejected:

- the run fails with `APPROVAL_REJECTED`

Best practice: after approval, call `resume(runId)` from the host if you want immediate forward progress.

### `resolveClarification(runId: UUID, message: string): Promise<RunResult>`

Provides the missing user answer to a run paused in `clarification_requested`.

```ts
const result = await agent.resolveClarification(
  runId,
  "Use only the incidents from the last 14 days and exclude staging."
);
```

Unlike `resolveApproval()`, this API resumes execution for you and returns the resulting `RunResult`.

## 7. Recovery and continuation APIs

### `resume(runId: UUID): Promise<RunResult>`

Continues the same run from its latest stored execution state.

Use it when:

- a run was interrupted
- a lease expired and the host is reclaiming execution
- a delegated child boundary needs recovery
- the run is already active but you want the runtime to continue it safely from persisted state

Here, a `lease` means a short-lived ownership lock on a `run`. The active executor acquires the lease before running, refreshes it with heartbeats while work is in progress, and releases it when done. If that executor crashes or stops heartbeating, the lease expires and another host or worker can safely acquire it and call `resume(runId)`.

```ts
const result = await agent.resume(runId);
```

What `resume()` does not do:

- it does not create a new run
- it does not clear a terminal failure
- it does not bypass approval or clarification gates

If the run is terminal, `resume()` returns the stored terminal result instead of advancing the run again.

### `retry(runId: UUID): Promise<RunResult>`

Retries the same failed run in place.

Requirements:

- run status must be `failed`
- the failure must be retryable according to runtime policy

```ts
const result = await agent.retry(runId);
```

What it does:

- keeps the same `runId`
- clears the failure fields
- increments retry metadata
- re-enters execution from persisted state

This is run-level retry, not generic step replay.

### `getRecoveryOptions(runId: UUID): Promise<RunRecoveryOptions>`

Analyzes whether a failed run can be safely continued as a new run.

```ts
const recovery = await agent.getRecoveryOptions(runId);

if (recovery.continuable) {
  console.log(recovery.recommendedStrategy);
  console.log(recovery.recommendedProvider, recovery.recommendedModel);
}
```

This is the diagnostic API you should call before `continueRun()` when the source run already failed terminally.

### `continueRun(options: ContinueRunOptions): Promise<RunResult>`

Creates a new continuation run from a failed source run and executes it immediately.

```ts
const recovery = await agent.getRecoveryOptions(failedRunId);

const result = await agent.continueRun({
  fromRunId: failedRunId,
  strategy: recovery.recommendedStrategy,
  provider: recovery.recommendedProvider,
  model: recovery.recommendedModel,
  requireApproval: true,
});
```

Important semantics:

- this creates a new run with a new `runId`
- the failed source run remains immutable history
- lineage is recorded in `continuationStore`

Use `continueRun()` when you want "recover forward from the last safe boundary as a new run."

### `createContinuationRun(options: ContinueRunOptions): Promise<ContinueRunResult>`

Creates the continuation run record and initial snapshot, but does not execute it yet.

```ts
const continuation = await agent.createContinuationRun({
  fromRunId: failedRunId,
  requireApproval: true,
});

const resumed = await agent.resume(continuation.continuationRunId);
```

Use it when you need a two-phase flow:

- inspect the continuation first
- queue it for later
- attach separate approval or scheduling around the new run id

## 8. Result handling

Most execution APIs return `RunResult`, which is one of:

- `success`
- `failure`
- `clarification_requested`
- `approval_requested`

Pattern:

```ts
const result = await agent.run({ goal: "Draft a release summary" });

switch (result.status) {
  case "success":
    console.log(result.output);
    break;
  case "approval_requested":
    console.log(result.toolName, result.message);
    break;
  case "clarification_requested":
    console.log(result.message, result.suggestedQuestions);
    break;
  case "failure":
    console.error(result.code, result.error);
    break;
}
```

## 9. Critical analysis of restart and recovery APIs

This is the most subtle part of the surface.

### First clarification: there is no public `continue()`

The public APIs are:

- `continueRun(options)`
- `createContinuationRun(options)`

If you mean "continue the same run," the API is usually `resume(runId)`, not `continueRun(...)`.

### 9.1 Fine-grained differences

| API | Same run or new run? | Expected source status | Human input required | Main purpose |
| --- | --- | --- | --- | --- |
| `resume(runId)` | Same run | Non-terminal, or terminal for read-only return | No | Continue existing state safely |
| `retry(runId)` | Same run | `failed` only | No | Retry a retryable failed run in place |
| `resolveApproval(runId, approved)` | Same run | `awaiting_approval` | Yes | Unblock or reject a gated tool call |
| `resolveClarification(runId, message)` | Same run | `clarification_requested` | Yes | Add missing user input and continue |
| `steer(runId, input)` | Same run | Active only | Optional operator guidance | Influence future turns |
| `continueRun(options)` | New run | Usually terminal `failed` source | Maybe, depending on policy | Recover forward as a new linked run |
| `createContinuationRun(options)` | New run | Usually terminal `failed` source | Maybe, depending on policy | Materialize continuation without starting it |

### 9.2 `resume()` vs `retry()`

`resume()` means:

- "the same run should keep going from the stored state"

`retry()` means:

- "the same failed run should be given another chance because the failure is considered retryable"

In practice:

- choose `resume()` for `interrupted`, stale leased, or waiting delegate situations
- choose `retry()` only for `failed` runs and only when policy says the failure kind is retryable

`resume()` is continuity.

`retry()` is failure recovery inside the same run id.

### 9.3 `retry()` vs `continueRun()`

This is the most important distinction.

`retry()`:

- keeps the same `runId`
- mutates the failed run back to `running`
- is appropriate when retryability is high-confidence and the current run record should remain the active lineage head

`continueRun()`:

- creates a fresh `continuationRunId`
- keeps the failed source run immutable
- is appropriate when recovery should preserve failure history and start from the last safe boundary

Good rule:

- prefer `retry()` for transient, in-place recovery
- prefer `continueRun()` for terminal failure recovery that should preserve the failed run as historical fact

### 9.4 `continueRun()` vs `createContinuationRun()`

`continueRun()` is one-step:

- create continuation
- execute continuation

`createContinuationRun()` is two-step:

- create continuation
- let the host decide when to actually run it

Use `createContinuationRun()` when:

- the host wants review before execution
- continuation must be scheduled elsewhere
- a UI wants to show the new run before launching it

### 9.5 `resolveApproval()` and `resolveClarification()` are also restart-like

They are not general recovery APIs, but they do restart progress after a paused state.

Differences:

- `resolveApproval()` decides whether a blocked tool call may proceed
- `resolveClarification()` appends missing user input and immediately resumes execution

This asymmetry is useful, but slightly surprising:

- approval resolution is split into decision first, then host-driven continuation
- clarification resolution both supplies input and resumes

That difference should be documented clearly in any host integration.

### 9.6 `steer()` is not a restart primitive

`steer()` often gets mentally grouped with resume/retry, but it is different.

It does not:

- reset failure state
- create a new run
- guarantee immediate execution

It only queues additional guidance into an active run.

## 10. Best-practice minimum inputs

If you want the minimum sensible payload for each API:

### `resume(runId)`

Provide only:

- `runId`

This is intentionally minimal. If you need model or strategy changes, you probably want continuation, not resume.

### `retry(runId)`

Provide only:

- `runId`

Do not add your own retry metadata in parallel unless your host has a strong reason. Let runtime retryability rules stay authoritative.

### `resolveApproval(runId, approved)`

Provide:

- `runId`
- a real human decision as `approved`

Best practice:

- if approved, call `resume(runId)` immediately from the host
- if rejected, surface the resulting failure to the user

### `resolveClarification(runId, message)`

Provide:

- `runId`
- the narrowest high-signal user answer possible

Avoid:

- dumping a whole new task description
- changing multiple unrelated constraints at once

### `steer(runId, input)`

Minimum:

- `runId`
- one concise message

Prefer:

- one corrective instruction
- one scope change
- one priority change

Avoid using `steer()` as a substitute for a fresh `run()` when the task itself has changed.

### `continueRun({ fromRunId, ... })`

Minimum safe input:

- `fromRunId`

Better practice:

- call `getRecoveryOptions(fromRunId)` first
- adopt the recommended `strategy`
- adopt the recommended `provider` and `model` unless you intentionally want a fallback
- set `requireApproval: true` when your product wants an explicit operator checkpoint

### `createContinuationRun({ fromRunId, ... })`

Minimum safe input:

- `fromRunId`

Use this API only if your host actually benefits from separating creation from execution.

## 11. Is this API valuable compared with other popular agent APIs?

Short answer:

- yes, if you need durable backend orchestration
- less so if you only need lightweight prompt-plus-tool calling

### Where this design is better

Compared with the [OpenAI Responses API](https://platform.openai.com/docs/api-reference/responses) and its tool/call loop model:

- `AdaptiveAgent` has a stronger explicit runtime concept of `run`, `snapshot`, `event`, and `continuation`
- it gives you clearer host-visible recovery choices: `resume`, `retry`, and `continueRun`
- child run delegation is a first-class runtime concern rather than an application convention

Compared with [LangGraph](https://langchain-ai.github.io/langgraph/) and its durable execution model:

- `AdaptiveAgent` has a simpler execution primitive boundary: tools are first-class, plans are separate artifacts
- the restart semantics are relatively easy to reason about because they are centered on run state instead of graph-wide node semantics
- run lineage for continuation vs child delegation is cleanly separated

Compared with the [Vercel AI SDK](https://sdk.vercel.ai/docs) loop-oriented API surface:

- `AdaptiveAgent` is better suited to long-lived, resumable, audit-heavy server workflows
- it exposes a more operationally useful recovery model for hosts that manage leases, approvals, and failure analysis

### Where this design is worse

Compared with OpenAI Responses:

- it requires more infrastructure and more host understanding
- simple use cases feel heavier than they need to
- the user must understand multiple restart-like APIs

Compared with LangGraph:

- it is less expressive for complex orchestration patterns
- it does not aim for graph-native branching, DAG execution, or parallel child execution
- it currently leaves `plan()` public but unimplemented, which weakens trust in the surface

Compared with Vercel AI SDK:

- it is less ergonomic for fast product integration
- frontend streaming and "just get a loop working" workflows are less turnkey
- the host owns more of the lifecycle contract

### Why it still has real value

This API is strongest when your system cares about:

- durability
- resumability
- audit trails
- human approval gates
- explicit recovery analysis
- delegated child work with lineage

That is a real gap in many simpler agent APIs.

## 12. What is better or worse specifically about the restart surface?

### Better

- `resume`, `retry`, and `continueRun` are meaningfully different, not aliases
- same-run recovery and new-run recovery are separated cleanly
- `getRecoveryOptions()` gives the host a real decision point before continuation
- immutable source failure plus new continuation run is a strong operational pattern

### Worse

- the names are close enough to be confused
- `resolveApproval()` and `resolveClarification()` have different continuation behavior
- `continueRun()` sounds like "continue the same run" to many users, but it actually means "create a new continuation run"
- `plan()` being public-but-unimplemented creates surface noise

## 13. What should be improved?

### 13.1 Naming

The biggest improvement would be naming clarity.

Possible future naming:

- `resume(runId)` stays
- `retry(runId)` stays
- `continueRun()` could become `continueAsNewRun()` or `forkContinuationRun()`
- `createContinuationRun()` could become `prepareContinuationRun()`

That would reduce misuse immediately.

### 13.2 Approval/clarification symmetry

Today:

- approval resolution updates state but does not itself continue execution
- clarification resolution updates state and immediately continues

Better options:

- either make both "resolve only"
- or make both "resolve and continue"

Consistency would simplify host integrations.

### 13.3 Public surface cleanup

Improve trust by:

- either implementing `plan()`
- or removing/hiding it until supported

### 13.4 A higher-level recovery helper

A useful addition would be a host-friendly helper like:

```ts
type RecoverRunDecision =
  | { action: "resume"; runId: UUID }
  | { action: "retry"; runId: UUID }
  | { action: "continue"; options: ContinueRunOptions }
  | { action: "manual"; reason: string };
```

Then a host could ask the runtime:

- "What is the best next recovery action?"

That would reduce duplicated policy logic in applications.

## 14. Recommended host policy

If you are building on this API, a good default policy is:

1. If run is `awaiting_approval`, call `resolveApproval(...)`, then `resume(runId)`.
2. If run is `clarification_requested`, call `resolveClarification(...)`.
3. If run is `interrupted` or stale-active, call `resume(runId)`.
4. If run is `failed`, call `getRecoveryOptions(runId)`.
5. If the failure is safely retryable in place, call `retry(runId)`.
6. Otherwise create a new continuation with `continueRun(...)`.

That policy preserves the intended distinction between in-place recovery and forward recovery.

## 15. References

- [`AdaptiveAgent` source](./src/adaptive-agent.ts)
- [`types.ts` contracts](./src/types.ts)
- [`create-adaptive-agent.ts`](./src/create-adaptive-agent.ts)
- [`RETRY-REPLAY.md`](../../RETRY-REPLAY.md)
- [`agen-contracts-v1.4.md`](../../agen-contracts-v1.4.md)
- [`agen-runtime-v1.4-algorithms.md`](../../agen-runtime-v1.4-algorithms.md)
- OpenAI Responses API: [platform.openai.com/docs/api-reference/responses](https://platform.openai.com/docs/api-reference/responses)
- LangGraph docs: [langchain-ai.github.io/langgraph](https://langchain-ai.github.io/langgraph/)
- Vercel AI SDK docs: [sdk.vercel.ai/docs](https://sdk.vercel.ai/docs)
