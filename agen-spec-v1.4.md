# High-Level Product Specification: AdaptiveAgent Library

**Version**: 1.4 (April 2026)
**Target Stack**: Bun + TypeScript
**Optional Example UI**: Svelte 5 + SvelteKit dashboard example
**Core Principle**: Keep the runtime small, typed, resumable, observable, and safe to extend into hierarchical supervision.

## 1. Product Goal

`AdaptiveAgent` is a lightweight TypeScript runtime for executing goal-oriented AI tasks with:

- typed tools
- structured events
- interrupt/resume support
- provider-agnostic model adapters
- optional persistence
- optional preserved plans that can be re-executed later
- optional supervisor delegation to bounded sub-agents

The v1.4 design continues to keep scope intentionally narrow. The library is not a general workflow engine, not a control plane, and not a dashboard product. It is a small runtime kernel with well-defined extension points.

## 2. Design Rules

- Keep the public API small.
- Treat `run` and `plan` as different artifacts.
- Keep `Tool` as the only first-class executable primitive.
- Model supervisor delegation as synthetic tools plus child runs, not as a second orchestration runtime.
- Use structured status and progress events instead of raw chain-of-thought streaming.
- Use an append-only event log plus snapshots for resumability.
- Keep Postgres, WebSocket broadcasting, and the dashboard outside the core package.
- Prefer deterministic re-execution over silent adaptation.
- Allow only bounded hierarchical delegation in core.

## 3. Non-Goals For v1.4

The following remain explicitly out of scope:

- long-term memory or retrieval
- parallel child-run execution
- child-to-child messaging
- mailbox or queue primitives
- DAG execution or arbitrary graph execution
- raw chain-of-thought persistence or UI display
- regex rewriting of model reasoning text
- delegate steps inside persisted plans
- built-in auth, tenancy, or rate limiting
- billing-grade cost accounting
- a separate skill runtime

If needed later, those capabilities can be added on top of the core runtime rather than embedded into it.

## 4. Core Concepts

### Agent

The main entry point. It coordinates planning, execution, persistence, interruption, resumption, event emission, and bounded delegation.

### Tool

A typed executable unit that the agent may invoke. A tool declares:

- `name`
- `description`
- `inputSchema`
- optional `outputSchema`
- execution function
- optional capture and redaction policy
- optional approval requirement

Tools remain the only first-class action primitive.

### Delegate Profile

A host-registered sub-agent profile that the runtime may expose to the planner as a synthetic tool such as `delegate.researcher`.

A delegate profile defines:

- a stable `name`
- a `description`
- optional delegate-specific instructions
- a bounded `allowedTools` list
- an optional model override
- optional agent default overrides

A delegate profile is configuration, not a second executable primitive.

### Run

A run is one execution attempt for a goal. A run owns:

- status
- current step
- usage and cost totals for that run record
- events
- snapshots
- final result or failure

### Child Run

A child run is a normal run created by a supervisor step. It is linked to a parent run, has its own lease, events, and snapshots, and returns a structured result back to the parent.

### Plan

A plan is a reusable artifact produced by the planner. It is stored separately from runs and may be executed later with new inputs.

In v1.4, persisted plans are:

- linear
- step-based
- tool-only
- schema-aware
- replayable when tool compatibility still holds

Persisted plans are not hidden reasoning transcripts, and they do not contain delegate steps.

### Event

An append-only structured record of what happened during a run or plan execution.

### Snapshot

A compact saved state that allows resumable execution without replaying the entire run from scratch.

## 5. Package Boundaries

The implementation should be split into separate packages.

### `@adaptive-agent/core`

Contains:

- `AdaptiveAgent`
- planner and executor
- delegate profile interfaces and delegation policy
- model adapter interfaces
- tool interfaces
- event types
- result types
- store interfaces

Does not contain:

- concrete Postgres code
- WebSocket server code
- Svelte dashboard code

### `@adaptive-agent/store-postgres`

Contains:

- Postgres schema
- SQL migrations
- Drizzle or Prisma adapter implementation
- lease acquisition and snapshot persistence
- run tree queries for parent and child relationships

### `@adaptive-agent/dashboard-example`

Contains:

- optional SvelteKit dashboard
- REST and WebSocket consumption examples
- CSV and JSON export examples
- run tree views for parent and child runs

The dashboard is an example package, not part of the runtime contract.

## 6. Public API

The public API should stay small.

```ts
const agent = new AdaptiveAgent({
  model,
  tools,
  delegates: [
    {
      name: 'researcher',
      description: 'Research facts and return structured findings',
      allowedTools: ['web_search', 'read_web_page'],
    },
    {
      name: 'writer',
      description: 'Draft polished output from structured inputs',
      allowedTools: ['doc_create', 'doc_update'],
    },
  ],
  delegation: {
    maxDepth: 1,
    maxChildrenPerRun: 5,
  },
  runStore,
  snapshotStore,
  eventSink,
  defaults: {
    maxSteps: 30,
    toolTimeoutMs: 60_000,
    modelTimeoutMs: 90_000, // raised to 360_000 automatically for provider='ollama' unless overridden
    maxRetriesPerStep: 2,
  },
});

const result = await agent.run({
  goal: 'Prepare a due-diligence packet for AcmePayments',
  input: {
    vendorName: 'AcmePayments',
    regions: ['US', 'EU'],
  },
  context: {
    currentDate: '2026-04-01',
    timezone: 'UTC',
  },
  outputSchema,
});

const plan = await agent.plan({
  goal: 'Prepare a due-diligence packet for AcmePayments',
  input,
  context,
});

await agent.executePlan({
  planId: plan.id,
  input,
  context,
});

await agent.interrupt(runId);
await agent.resume(runId);
```

The method surface remains:

- `run()`
- `plan()`
- `executePlan()`
- `interrupt()`
- `resume()`

There is no separate public `spawn()` or `supervise()` API in v1.4.

## 7. Configuration Model

Configuration should be split between construction-time defaults and per-run overrides.

```ts
type AgentDefaults = {
  maxSteps?: number;
  toolTimeoutMs?: number;
  modelTimeoutMs?: number;
  maxRetriesPerStep?: number;
  requireApprovalForWriteTools?: boolean;
  capture?: 'full' | 'summary' | 'none';
  toolBudgets?: Record<string, ToolBudget>;
  researchPolicy?: ResearchPolicyName | ResearchPolicy;
};

Goal-directed external research may be bounded through optional tool budgets. This keeps search-like tools available, but pushes the model to search only when current or unknown facts are actually needed, to checkpoint when the evidence is probably sufficient, and to answer with explicit uncertainty instead of searching broadly after the configured budget is exhausted.

type DelegationPolicy = {
  maxDepth?: number;
  maxChildrenPerRun?: number;
  allowRecursiveDelegation?: boolean;
  childRunsMayRequestApproval?: boolean;
  childRunsMayRequestClarification?: boolean;
};

type RunInput = {
  goal: string;
  input?: unknown;
  context?: {
    currentDate?: string;
    timezone?: string;
    locale?: string;
    [key: string]: unknown;
  };
  allowedTools?: string[];
  forbiddenTools?: string[];
  outputSchema?: unknown;
};
```

Notes:

- synthetic delegate tools participate in `allowedTools` and `forbiddenTools` the same way ordinary tools do
- the host decides which delegate profiles are registered at construction time
- per-run delegation filtering should happen by allowing or forbidding the corresponding synthetic tool names

## 8. Tool And Delegate Model

### Tool Model

Each tool must have a stable name and schema.

Required fields:

- `name`
- `description`
- `inputSchema`
- `execute()`

Optional fields:

- `outputSchema`
- `timeoutMs`
- `requiresApproval`
- `capture`
- `redact`
- `summarizeResult`

Guidelines:

- tools that mutate external systems should set `requiresApproval: true` unless the host deliberately opts out
- side-effecting tools must receive an idempotency key derived from `runId` and `stepId`
- tool input and output should be schema-validated before persistence when feasible

### Delegate Model

A delegate profile is turned into a synthetic tool at runtime using the reserved `delegate.` namespace.

Example:

- delegate profile: `researcher`
- synthetic tool name: `delegate.researcher`

Delegate tool input should contain:

- child goal
- optional child input
- optional child context
- optional child output schema
- optional child metadata

Guidelines:

- every delegate profile should have a stable name
- delegate profiles should declare a narrow `allowedTools` boundary
- delegate profiles should not be used to bypass approval policy
- self-delegation should be disabled by default
- retry policy for delegate-bound child runs should be configured at the runtime boundary, not encoded into persisted plans

## 9. Execution Model

### `run()`

`run()` is the default one-shot entry point.

Behavior:

1. Create a root run record.
2. Acquire a lease if a store supports distributed execution.
3. Ask the planner for a linear plan.
4. Execute the plan step by step.
5. Save snapshots after important boundaries.
6. Return a typed terminal result.

The runtime may create an internal ephemeral plan even when the caller never persists it.

Internal ephemeral plans may include delegate steps.

### Supervisor Delegation

When the planner selects a synthetic delegate tool such as `delegate.researcher`, the runtime should:

1. validate delegation policy limits
2. create a child run linked to the parent run
3. move the parent run to `awaiting_subagent`
4. emit structured delegation events
5. execute the child run using the selected delegate profile
6. treat the child result as the delegate tool result when the child completes

v1.4 intentionally allows only one active child run per parent run at a time.

Delegate retries follow the same boundary:

- the parent remains parked on the same delegate tool step while retry is still allowed
- retry state belongs to runtime execution state, not to a persisted plan artifact
- transient child model failures such as provider timeout should prefer in-place child `resume()` over spawning a fresh child run
- if a child has already reached terminal `failed`, the runtime may create a new child attempt for the same parent delegate execution when policy marks the failure as retryable
- the parent should emit a retry-specific delegation event before the next child attempt starts
- the parent should fail the delegate tool only after retry budget is exhausted or the child failure is non-retryable

### `plan()`

`plan()` creates and returns a persisted plan artifact without executing it.

Use cases:

- human review before execution
- later reuse with different inputs
- preserving a plan separately from the original run

Persisted plans created by `plan()` must not contain delegate steps.

### `executePlan()`

`executePlan()` executes a previously stored plan with provided input and context.

Execution rules:

- plan execution is deterministic relative to the saved steps
- required tools must still exist
- tool schemas must still be compatible
- persisted plans must not contain `delegate.*` steps
- if compatibility fails, the runtime emits `replan.required` instead of silently drifting

### `interrupt()` and `resume()`

Interruption is cooperative. The runtime checks interruption state:

- between steps
- before tool execution
- before waiting for approval
- before waiting on a child run
- before replanning

`resume()` continues from the latest valid snapshot after acquiring the run lease.

`continueRun({ fromRunId })` is a recovery API for terminal `failed` runs. It must not reopen the failed run. The runtime creates a new linked continuation run, records lineage separately from parent/child delegation, and builds a continuation brief from the latest compatible snapshot plus durable progress after that snapshot.

The MVP continuation strategy is `hybrid_snapshot_then_step`:

- restore the latest compatible snapshot as the base state
- inspect durable events to identify the last safely completed step
- continue from the next incomplete step
- block with `requires_reconciliation` if a side-effecting tool may have started without a durable completion record
- allow the host to route continuation to a different configured provider/model

If a parent run is in `awaiting_subagent`, `resume()` must inspect the linked child run before the parent continues.

If the child failed with a retryable delegate error and retry budget remains, `resume()` should continue the same delegate boundary instead of failing the parent immediately:

- prefer resuming the same child run from its latest snapshot when the child is `interrupted`
- if the child is already terminal `failed`, create a new child attempt linked to the same parent step and keep the parent in `awaiting_subagent`
- preserve already completed child tool work whenever resuming the same child run is possible
- only emit the parent `tool.failed` once the delegate boundary is conclusively terminal

### Child Run Interaction Policy

For the first multi-agent iteration:

- child runs should be treated as non-interactive
- if a child run reaches approval wait state, the runtime should fail that child and surface the failure to the parent
- if a child run reaches clarification state, the runtime should fail that child and surface the failure to the parent

This keeps interaction ownership with the supervisor or host application.

## 10. Plan Artifacts

Plans are optional first-class artifacts.

Each persisted plan contains:

- metadata
- goal and summary
- input schema
- toolset hash
- ordered steps
- failure policies
- optional success criteria

Plan steps contain:

- stable step id
- title
- tool name
- input template
- optional preconditions
- optional output binding key
- failure policy: `stop`, `skip`, or `replan`

To keep v1.4 understandable, persisted plans do not support:

- branches
- loops
- concurrent execution
- subplans
- delegate steps

## 11. Resumability And Reliability

Resumability is based on two storage layers:

- append-only events for traceability
- compact snapshots for restart speed

Recommended snapshot boundaries:

- after root run creation
- after child run creation
- after plan creation
- after each tool completion
- before entering approval wait state
- before entering child-wait state
- after each successful replan
- before terminal completion

Distributed safety requirements:

- a lease owner field
- a lease expiry timestamp
- heartbeat updates while running
- optimistic version increments on run updates

Delegation requires additional run-tree linkage:

- `rootRunId`
- `parentRunId`
- `parentStepId`
- `delegateName`
- `delegationDepth`
- `currentChildRunId`

This is the minimum needed to make `resume()` reliable for hierarchical execution outside single-process demos.

## 12. Observability

All runtime telemetry should use structured events.

Recommended event types:

- `run.created`
- `run.status_changed`
- `plan.created`
- `plan.execution_started`
- `step.started`
- `step.completed`
- `tool.started`
- `tool.completed`
- `tool.failed`
- `delegate.spawned`
- `approval.requested`
- `approval.resolved`
- `clarification.requested`
- `usage.updated`
- `snapshot.created`
- `run.completed`
- `run.failed`
- `run.continuation_created`
- `run.interrupted`
- `run.resumed`
- `recovery.analyzed`
- `replan.required`

The event payload should be structured and versioned. Event ordering should be based on a per-run sequence number.

Delegation payloads should include linkage fields such as:

- `parentRunId`
- `childRunId`
- `delegateName`
- `delegationDepth`

The runtime should emit status summaries and progress updates, not raw hidden reasoning text.

## 13. Model Adapter Contract

Each model adapter must declare capability flags.

Minimum capabilities to expose:

- `toolCalling`
- `jsonOutput`
- `streaming`
- `usage`

The runtime should degrade gracefully when a provider lacks a capability. For example, if a provider has no structured JSON mode, the runtime may fall back to validated text parsing rather than pretending structured output is guaranteed.

The core package may ship concrete provider adapters as long as they remain behind the `ModelAdapter` boundary. Current reference adapters are:

- `OpenRouterAdapter`, backed by `@openrouter/sdk`
- `MistralAdapter`, backed by `@mistralai/mistralai`
- `MeshAdapter`, backed by `meshapi-node-sdk`
- `OllamaAdapter`, backed by the OpenAI-compatible HTTP chat-completions path

Provider SDK adapters must map `ModelRequest` into the SDK's typed request shape rather than assuming the raw REST wire shape. In particular, SDKs may require different field naming from OpenAI-compatible HTTP payloads, such as `toolCalls` versus `tool_calls`, `toolCallId` versus `tool_call_id`, `imageUrl` versus `image_url`, or `responseFormat` versus `response_format`. Each adapter owns this request and response normalization while preserving the shared runtime semantics for tool calling, structured output, usage accounting, abort signals, and resumability.

The OpenAI-compatible base adapter remains a fallback and parser reference for providers or local endpoints that expose `/chat/completions` directly. It should not become the public runtime contract; the public contract remains `ModelAdapter`.

## 14. Result Envelope

The runtime should always return a small terminal envelope.

```ts
type RunResult<T> =
  | {
      status: 'success';
      output: T;
      runId: string;
      planId?: string;
      stepsUsed: number;
      usage: {
        promptTokens: number;
        completionTokens: number;
        reasoningTokens?: number;
        estimatedCostUSD: number;
      };
    }
  | {
      status: 'failure';
      runId: string;
      error: string;
      code: 'MAX_STEPS' | 'TOOL_ERROR' | 'MODEL_ERROR' | 'APPROVAL_REJECTED' | 'REPLAN_REQUIRED' | 'INTERRUPTED';
      stepsUsed: number;
      usage: {
        promptTokens: number;
        completionTokens: number;
        reasoningTokens?: number;
        estimatedCostUSD: number;
      };
    }
  | {
      status: 'clarification_requested';
      runId: string;
      message: string;
      suggestedQuestions?: string[];
    }
  | {
      status: 'approval_requested';
      runId: string;
      message: string;
      toolName: string;
    };
```

The terminal result envelope does not add multi-agent-specific statuses in v1.4.

## 15. Storage Model

The recommended persistence model uses these tables:

- `agent_runs`
- `agent_events`
- `run_snapshots`
- `plans`
- `plan_steps`
- `plan_executions`
- `run_continuations`

The `agent_runs` table now also carries run-tree linkage for parent and child relationships.

Continuation lineage must use `run_continuations` rather than `parent_run_id`; `parent_run_id` remains reserved for delegated child runs.

The core package should only depend on store interfaces. Postgres details belong in the storage adapter package.

## 16. Dashboard Example

The example dashboard should consume the runtime externally via REST and WebSocket.

Recommended features:

- run list with status and usage
- parent and child run tree view
- event timeline
- plan viewer
- interrupt and resume controls
- approval queue view
- CSV and JSON export

The dashboard should show progress summaries, step execution state, and parent-child linkage. It should not show raw chain-of-thought.

## 17. Security And Retention

The runtime must support capture policies because prompts, tool inputs, and tool outputs may contain sensitive data.

Recommended capture modes:

- `full`
- `summary`
- `none`

Recommended redaction hooks:

- per-tool input redaction
- per-tool output redaction
- model prompt redaction
- event payload redaction before persistence

Retention should be owned by the host application or storage adapter.

## 18. User Story

A product operations lead asks:

> Prepare a due-diligence packet for adopting AcmePayments. I need a risk summary, pricing estimate, and a final recommendation memo.

The host application configures three delegate profiles:

- `researcher` with `web_search` and `read_web_page`
- `finops` with `pricing_lookup` and `spreadsheet_calculate`
- `writer` with `doc_create` and `doc_update`

A typical run looks like this:

1. The caller invokes `agent.run()` with the due-diligence goal and a final output schema.
2. The supervisor creates a root run and plans the work.
3. The supervisor invokes `delegate.researcher` to gather evidence and return structured findings.
4. The runtime creates a child run linked to the supervisor, waits for the child result, and records both runs separately.
5. After the research child completes, the supervisor invokes `delegate.finops` to estimate cost scenarios.
6. After the finance child completes, the supervisor invokes `delegate.writer` to produce a memo from the collected findings.
7. The supervisor validates the final output schema and returns a single typed `RunResult`.

The host can inspect:

- the root run for the overall request
- each child run for delegated work
- event timelines for every run
- snapshots that allow parent or child resumption after interruption or process failure

## 19. Implementation Plan

### Phase 1: Core Runtime

- define updated types and interfaces
- implement agent lifecycle for root and child runs
- implement synthetic delegate tool generation
- implement interrupt and resume hooks across parent and child runs
- add structured delegation events

### Phase 2: Postgres Adapter

- update schema and migrations for run tree fields
- implement run queries for parent and child linkage
- implement lease and heartbeat handling for root and child runs
- support resume logic that inspects child state before continuing parent state

### Phase 3: Dashboard Example

- render run tree and child relationships
- consume delegation events via WebSocket
- show parent waiting-on-child state
- support interrupts, resumes, and approvals

### Phase 4: Plan Preservation Workflow

- preserve tool-only plans created by `plan()`
- enforce delegate-step rejection during `executePlan()`
- add compatibility checks for reserved `delegate.` namespace
- keep deterministic replay as the default behavior

## 20. Summary Of Changes From v1.3

- added bounded supervisor delegation through synthetic `delegate.*` tools
- added child runs as linked run artifacts rather than a new orchestration graph
- added parent and child linkage requirements to resumability and storage
- added `delegate.spawned` as a first-class observability event
- kept the public method surface unchanged
- kept persisted plans tool-only and deterministic by excluding delegate steps
- explicitly deferred parallel delegation, child messaging, and general workflow features
