# High-Level Product Specification: AdaptiveAgent Library

**Version**: 1.3 (April 2026)  
**Target Stack**: Bun + TypeScript  
**Optional Example UI**: Svelte 5 + SvelteKit dashboard example  
**Core Principle**: Keep the runtime small, typed, resumable, and observable.

## 1. Product Goal

`AdaptiveAgent` is a lightweight TypeScript runtime for executing goal-oriented AI tasks with:

- typed tools
- structured events
- interrupt/resume support
- provider-agnostic model adapters
- optional persistence
- optional preserved plans that can be re-executed later

The v1.3 design intentionally narrows scope. The library is not a general workflow engine, not a control plane, and not a dashboard product. It is a small runtime kernel with well-defined extension points.

## 2. Design Rules

- Keep the public API small.
- Treat `run` and `plan` as different artifacts.
- Make `Tool` the only first-class executable primitive in v1.
- Use structured status/progress events instead of raw chain-of-thought streaming.
- Use an append-only event log plus snapshots for resumability.
- Keep Postgres, WebSocket broadcasting, and the dashboard outside the core package.
- Prefer deterministic re-execution over silent adaptation.

## 3. Non-Goals For v1

The following are explicitly out of scope for v1:

- long-term memory or retrieval
- multi-agent orchestration
- DAG execution or parallel step execution
- raw chain-of-thought persistence or UI display
- regex rewriting of model reasoning text
- built-in auth, tenancy, or rate limiting
- billing-grade cost accounting
- a separate skill runtime

If needed later, those capabilities can be added on top of the core runtime rather than embedded into it.

## 4. Core Concepts

### Agent

The main entry point. It coordinates planning, execution, persistence, interruption, resumption, and event emission.

### Tool

A typed executable unit that the agent may invoke. A tool declares:

- `name`
- `description`
- `inputSchema`
- optional `outputSchema`
- execution function
- optional capture/redaction policy
- optional approval requirement

In v1, tools are the only first-class action primitive. Anything previously described as a "skill" should be expressed as either:

- a host-authored composite tool, or
- a preserved plan artifact

### Run

A run is one execution attempt for a goal. A run owns:

- status
- current step
- usage and cost totals
- events
- snapshots
- final result or failure

### Plan

A plan is a reusable artifact produced by the planner. It is stored separately from runs and may be executed later with new inputs.

In v1, plans are:

- linear
- step-based
- tool-only
- schema-aware
- replayable when tool compatibility still holds

Plans are not hidden reasoning transcripts.

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

### `@adaptive-agent/dashboard-example`

Contains:

- optional SvelteKit dashboard
- REST and WebSocket consumption examples
- CSV and JSON export examples

The dashboard is an example package, not part of the runtime contract.

## 6. Public API

The public API should stay small.

```ts
const agent = new AdaptiveAgent({
  model,
  tools,
  runStore,
  snapshotStore,
  eventSink,
  defaults: {
    maxSteps: 30,
    toolTimeoutMs: 60_000,
    modelTimeoutMs: 90_000,
    maxRetriesPerStep: 2,
  },
});

const result = await agent.run({
  goal: 'Book flights from Delhi to NYC for 2 adults',
  input: {
    origin: 'DEL',
    destination: 'NYC',
    travelers: 2,
  },
  context: {
    currentDate: '2026-04-01',
    timezone: 'Asia/Kolkata',
  },
  outputSchema,
});

const plan = await agent.plan({
  goal: 'Book flights from Delhi to NYC for 2 adults',
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

The previous v1.2 `skills`, `toolPriorityFirst`, and placeholder-rule configuration are removed from the public runtime surface.

## 8. Tool Model

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

- Tools that mutate external systems should set `requiresApproval: true` unless the host deliberately opts out.
- Side-effecting tools must receive an idempotency key derived from `runId` and `stepId`.
- Tool input and output should be schema-validated before persistence when feasible.

## 9. Execution Model

### `run()`

`run()` is the default one-shot entry point.

Behavior:

1. Create a run record.
2. Acquire a lease if a store supports distributed execution.
3. Ask the planner for a linear tool-based plan.
4. Execute the plan step by step.
5. Save snapshots after important boundaries.
6. Return a typed terminal result.

The run may create an internal ephemeral plan even when the caller never persists it.

### `plan()`

`plan()` creates and returns a persisted plan artifact without executing it.

Use cases:

- human review before execution
- later reuse with different inputs
- preserving a plan separately from the original run

### `executePlan()`

`executePlan()` executes a previously stored plan with provided input and context.

Execution rules:

- plan execution is deterministic relative to the saved steps
- required tools must still exist
- tool schemas must still be compatible
- if compatibility fails, the runtime emits `replan_required` instead of silently drifting

### `interrupt()` and `resume()`

Interruption is cooperative. The runtime checks interruption state:

- between steps
- before tool execution
- before waiting for approval
- before replanning

`resume()` continues from the latest valid snapshot after acquiring the run lease.

## 10. Plan Artifacts

Plans are optional first-class artifacts.

Each plan contains:

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

To keep v1 understandable, plans do not support:

- branches
- loops
- concurrent execution
- subplans

## 11. Resumability And Reliability

Resumability is based on two storage layers:

- append-only events for traceability
- compact snapshots for restart speed

Recommended snapshot boundaries:

- after run creation
- after plan creation
- after each tool completion
- before entering approval wait state
- after each successful replan
- before terminal completion

Distributed safety requirements:

- a lease owner field
- a lease expiry timestamp
- heartbeat updates while running
- optimistic version increments on run updates

This is the minimum needed to make `resume()` reliable outside single-process demos.

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
- `approval.requested`
- `approval.resolved`
- `clarification.requested`
- `usage.updated`
- `snapshot.created`
- `run.completed`
- `run.failed`
- `run.interrupted`
- `run.resumed`
- `replan.required`

The event payload should be structured and versioned. Event ordering should be based on a per-run sequence number.

The runtime should emit status summaries and progress updates, not raw hidden reasoning text.

## 13. Model Adapter Contract

Each model adapter must declare capability flags.

Minimum capabilities to expose:

- `toolCalling`
- `jsonOutput`
- `streaming`
- `usage`

The runtime should degrade gracefully when a provider lacks a capability. For example, if a provider has no structured JSON mode, the runtime may fall back to validated text parsing rather than pretending structured output is guaranteed.

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

## 15. Storage Model

The recommended persistence model uses these tables:

- `agent_runs`
- `agent_events`
- `run_snapshots`
- `plans`
- `plan_steps`
- `plan_executions`

The core package should only depend on store interfaces. Postgres details belong in the storage adapter package.

## 16. Dashboard Example

The example dashboard should consume the runtime externally via REST and WebSocket.

Recommended features:

- run list with status and usage
- event timeline
- plan viewer
- interrupt/resume controls
- approval queue view
- CSV and JSON export

The dashboard should show progress summaries and step execution state. It should not show raw chain-of-thought.

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

## 18. Implementation Plan

### Phase 1: Core Runtime

- define types and interfaces
- implement agent lifecycle
- implement planner and executor for linear plans
- add interrupt/resume hooks
- add structured events

### Phase 2: Postgres Adapter

- define schema and migrations
- implement run, event, snapshot, and plan stores
- implement lease and heartbeat handling

### Phase 3: Dashboard Example

- consume events via WebSocket
- render run timeline and usage
- support interrupts, resumes, and approvals

### Phase 4: Plan Preservation Workflow

- support explicit `plan()` creation
- support `executePlan()`
- add plan compatibility checks
- add `replan_required` handling

## 19. Summary Of Changes From v1.2

- removed first-class `Skill` from the core runtime
- removed tools-first versus skills-first priority mode
- removed placeholder rewriting of internal reasoning
- replaced raw thought streaming with structured progress events
- replaced single checkpoint blob thinking with event log plus snapshots
- elevated plans to optional first-class artifacts separate from runs
- tightened core versus storage versus UI package boundaries
