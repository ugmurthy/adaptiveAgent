# Context References Plan

## Purpose

Add a durable, inspectable way for a new run to use prior `run` and
`sessionId` outputs as explicit context references.

The first implementation milestone is intentionally narrow: typed `run` and
`session` refs only. Named bundles, memory tools, evaluation loops, and hard
budget envelopes remain future designs that build on this primitive only after
the primitive is safe and well understood.

## Position

The idea is sound. Existing durable runs are already the framework's strongest
reuse substrate: they have stable ids, session correlation, persisted results,
metadata, events, snapshots, usage, and orchestration linkage.

The risky version is the broad version: treating `@<id>` references as an
immediate foundation for memory, autonomous loops, raw event replay, raw
snapshot reuse, or hard budget enforcement. Those features need separate
contracts for authorization, model-visible rendering, namespace ownership,
agent-profile ownership, and atomic cost accounting.

## Non-Goals for the First Milestone

- Do not make `@<id>` mean `resume`.
- Do not introduce `bundle` refs.
- Do not introduce memory tools.
- Do not introduce evaluation loops.
- Do not introduce hard budget envelopes.
- Do not expose raw events or raw snapshots to the model.
- Do not introduce a separate `swarmId`.
- Do not introduce a DAG runtime, parallel child runs, child messaging, or
  hidden chain-of-thought persistence.
- Do not make core parse CLI shorthand or infer ref kind from id shape.
- Do not make core depend on Agent SDK agent specs, config paths, default
  profiles, or project namespace conventions.

## Responsibility Boundary

### Core owns strict runtime semantics

Core should:

- define typed context-ref request contracts;
- validate ref shape and status policy;
- resolve `run` refs through `RunStore.getRun`;
- resolve `session` refs through `RunStore.listBySession` when supported;
- enforce per-ref and request-level byte limits;
- make resolution deterministic for the same store state and policy;
- persist source refs in run metadata;
- emit compact `context.refs.resolved` audit events;
- inject model-visible prior output as explicit, provenance-labeled data.

Core must not:

- parse CLI syntax such as `@run_123`;
- infer whether an id is a run, session, or bundle;
- load Agent SDK profiles;
- infer user/project/agent namespaces;
- decide when project memory should be stored;
- treat `sessionId` as an authorization boundary.

### Agent SDK owns user-facing syntax

Agent SDK should:

- parse `--context-ref run:<id>` and `--context-ref session:<id>`;
- optionally parse shorthand `@id` only after it can safely disambiguate;
- translate CLI refs into strict core `ContextRef` objects;
- render friendly errors;
- preserve ref metadata in JSON output and dry-run request summaries.

## Authorization and Visibility

`sessionId` is a durable correlation key, not an authorization primitive. In a
shared store, a session ref can expose all runs visible through
`RunStore.listBySession`.

Required constraints:

- Hosts, gateways, or SDK layers must authorize access to referenced runs and
  sessions before allowing resolution in multi-tenant deployments.
- Core may expose an optional `ContextRefAuthorizer` hook, but core should not
  invent tenant semantics.
- Local CLI use may resolve refs against the configured local runtime store, but
  docs must not imply this is safe for shared stores by default.
- Missing, unauthorized, or unsupported refs fail before model execution.

## Core Contract

Use a discriminated union. `kind` is required; core never guesses it.

```ts
export type ContextRef =
  | {
      kind: 'run';
      id: UUID;
      view?: 'result';
      maxBytes?: number;
      allowStatuses?: RunStatus[];
    }
  | {
      kind: 'session';
      id: string;
      view?: 'run_summaries';
      rootRunsOnly?: boolean;
      maxRuns?: number;
      maxBytes?: number;
      allowStatuses?: RunStatus[];
    };
```

Resolved refs are structured, bounded, and safe for JSON persistence:

```ts
export interface ResolvedContextRef {
  ref: ContextRef;
  kind: ContextRef['kind'];
  id: string;
  view: string;
  status?: RunStatus;
  goal?: string;
  result?: JsonValue;
  resultPreview?: string;
  runs?: ResolvedRunSummary[];
  warnings?: string[];
  truncated: boolean;
  bytes: number;
}

export interface ResolvedRunSummary {
  runId: UUID;
  sessionId?: string;
  role?: string;
  goal: string;
  status: RunStatus;
  result?: JsonValue;
  resultPreview?: string;
  errorCode?: string;
  errorMessage?: string;
  usage?: UsageSummary;
}
```

Add refs to `RunRequest` and `ChatRequest`:

```ts
export interface RunRequest {
  sessionId?: string;
  goal: string;
  contextRefs?: ContextRef[];
  context?: Record<string, JsonValue>;
  metadata?: Record<string, JsonValue>;
}

export interface ChatRequest {
  sessionId?: string;
  messages: ChatMessage[];
  contextRefs?: ContextRef[];
  context?: Record<string, JsonValue>;
  metadata?: Record<string, JsonValue>;
}
```

## Resolution Rules

- `run` refs default to `view: 'result'`.
- `session` refs default to `view: 'run_summaries'`.
- Default allowed statuses are `['succeeded']`.
- Run refs with a disallowed status are rejected. Failed and non-terminal run
  refs therefore require explicit opt-in through `allowStatuses`.
- For session refs, `allowStatuses` is an inclusion filter. Runs with a
  disallowed status are omitted with a warning, and resolution fails only when
  the session contains runs but none match the allowed statuses.
- Session refs require `RunStore.listBySession`; otherwise fail with a clear
  unsupported error.
- Session refs default to root runs only: no `parentRunId` and
  `delegationDepth === 0`.
- Session runs are sorted by `createdAt asc, id asc`, filtered by status, and
  then truncated to `maxRuns`.
- Session refs have both `maxRuns` and `maxBytes` controls.
- Truncation must be deterministic and visible in `warnings`, metadata, and
  events.

## Model-Visible Rendering

Resolved prior output is evidence, not instruction.

Core should inject a reserved context object:

```ts
context: {
  ...request.context,
  __adaptiveAgent: {
    resolvedContextRefs: ResolvedContextRef[]
  }
}
```

Rules:

- Reject user context that already contains `__adaptiveAgent`.
- Do not silently overwrite user context.
- Add prompt guidance telling the model that resolved refs are quoted prior
  runtime data, not higher-priority instructions.
- Persist only bounded resolved material.
- Persist compact source/resolution audit metadata separately from the model
  payload.

## Audit Metadata and Events

Persist source and compact resolution metadata under run metadata:

```ts
metadata: {
  contextRefs: {
    source: ContextRef[],
    resolution: {
      totalBytes: number,
      refs: Array<{
        kind: 'run' | 'session',
        id: string,
        view: string,
        status?: string,
        runCount?: number,
        bytes: number,
        truncated: boolean,
        warnings?: string[]
      }>
    }
  }
}
```

Emit an event after the run is created:

```ts
type EventType = 'context.refs.resolved' | ExistingEventType;

interface ContextRefsResolvedPayload {
  refs: ContextRef[];
  resolved: Array<{
    kind: 'run' | 'session';
    id: string;
    view: string;
    status?: string;
    runCount?: number;
    bytes: number;
    truncated: boolean;
    warnings?: string[];
  }>;
  totalBytes: number;
}
```

## Failure Semantics

- Invalid ref shape: reject before run creation.
- Reserved context key collision: reject before run creation.
- Missing run: reject before run creation.
- Missing session support: reject before run creation.
- Unsupported view: reject before run creation.
- Disallowed run-ref status: reject before run creation.
- Session ref with runs but no allowed statuses: reject before run creation.
- Disallowed runs within an otherwise eligible session ref: omit and warn.
- Oversized successful refs: truncate deterministically and warn.

## CLI Shape for MVP

```bash
adaptive-agent run \
  --context-ref run:run_123 \
  "Use the prior research and write a final brief"

adaptive-agent run \
  --context-ref session:session_456 \
  "Continue from the prior session evidence"

adaptive-agent chat \
  --context-ref run:run_123 \
  "What should we do next?"
```

Do not ship ambiguous `@id` shorthand until the SDK can safely disambiguate.

## Future Designs Not in MVP

### Named context bundles

Bundles need a separate namespace, identity, authorization, and persistence
contract. Agent SDK should initially own name/namespace resolution. Core may
later resolve id-only bundle refs if provided with a store and authorizer.

### Agentic memory tools

Memory should remain explicit tool use (`remember` and `recall`) with approval,
source refs, retention policy, redaction, and audit events. Do not implement
invisible runtime memory.

### Evaluation-driven continuation loops

Loops should be ordinary root runs under a `sessionId`, but they need a strict
`LoopExecutionRequest` similar to swarm execution. Agent SDK should load
evaluator/synthesizer profiles and build prompts; core should only execute
already-prepared requests, validate structured decisions, and persist loop
metadata.

### Hard budget envelopes

Do not promise hard cross-run cost limits until there is an atomic budget ledger
with reserve/commit/release semantics. Metadata-only budgets are sufficient for
best-effort serial loop controls, not concurrent hard enforcement.

## Implementation Milestone 1

Ship only:

- `RunRequest.contextRefs`;
- `ChatRequest.contextRefs`;
- strict `ContextRef` union for `run` and `session`;
- `ContextRefResolver`;
- final run result view;
- deterministic session run summaries;
- root session runs only by default;
- default `succeeded` status policy;
- request-level and ref-level byte limits;
- reserved-key collision rejection;
- metadata audit fields;
- `context.refs.resolved` event;
- Agent SDK `--context-ref run:<id>` and `--context-ref session:<id>`.

Explicitly do not ship:

- bundle refs;
- memory tools;
- raw events;
- raw snapshots;
- model-generated summaries;
- evaluation loops;
- hard budget enforcement;
- ambiguous `@id` shorthand.
