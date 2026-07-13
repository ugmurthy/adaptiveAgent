# Context References Plan

## Purpose

Add a durable, inspectable way for a new run to use prior `run` and
`sessionId` outputs as explicit context references.

Implementation Milestone 1, Context Ref 1.1, and named context bundles are now
implemented. The runtime supports typed `run` and `session` refs, deterministic
session selection, per-run session authorization, source provenance, and CLI
visibility. Agent SDK adds project-scoped named bundles without adding another
core ref abstraction.

Memory tools, evaluation loops, and hard budget envelopes remain later designs
that build on the stable context-ref and bundle primitives.

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
      selection?: 'latest' | 'earliest';
      rootRunsOnly?: boolean;
      maxRuns?: number;
      maxScanRuns?: number;
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
  selection?: 'latest' | 'earliest';
  scannedRunCount?: number;
  goal?: string;
  sourceRunVersion?: number;
  sourceUpdatedAt?: string;
  sourceCompletedAt?: string;
  result?: JsonValue;
  resultPreview?: string;
  runs?: ResolvedRunSummary[];
  warnings?: string[];
  truncated: boolean;
  bytes: number;
}

export interface ResolvedRunSummary {
  runId: UUID;
  sourceRunVersion: number;
  sourceUpdatedAt: string;
  sourceCompletedAt?: string;
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
- Session refs default to `selection: 'latest'`; `earliest` is available
  explicitly.
- Core pages from the selected chronological end, applies root-run,
  authorization, and status filters, and then truncates to `maxRuns`.
- Selected runs are rendered in `createdAt asc, id asc` presentation order.
- Session refs have `maxRuns`, `maxScanRuns`, and `maxBytes` controls.
- Each candidate session run is authorized with `targetRun` before any of its
  content enters resolved material.
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
        selection?: 'latest' | 'earliest',
        runCount?: number,
        scannedRunCount?: number,
        sources?: Array<{
          runId: UUID,
          sourceRunVersion: number,
          sourceUpdatedAt: string,
          sourceCompletedAt?: string
        }>,
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
    selection?: 'latest' | 'earliest';
    runCount?: number;
    scannedRunCount?: number;
    sources?: Array<{
      runId: UUID;
      sourceRunVersion: number;
      sourceUpdatedAt: string;
      sourceCompletedAt?: string;
    }>;
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
  --context-ref run:550e8400-e29b-41d4-a716-446655440000 \
  "Use the prior research and write a final brief"

adaptive-agent run \
  --context-ref session:session_456 \
  "Continue from the prior session evidence"

adaptive-agent chat \
  --context-ref run:550e8400-e29b-41d4-a716-446655440000 \
  "What should we do next?"
```

Do not ship ambiguous `@id` shorthand until the SDK can safely disambiguate.

## Future Designs Not in MVP

### Named context bundles

Bundles need a separate namespace, identity, authorization, and persistence
contract. Agent SDK should initially own name/namespace resolution. Core may
later resolve id-only bundle refs if provided with a store and authorizer.

The initial bundle milestone is specified below and implemented. It expands an
SDK-owned bundle to existing `run` and `session` refs before calling core; it
does not add a `bundle` variant to core's `ContextRef` union.

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

## Implementation Milestone 1 (Implemented)

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

## Context Ref 1.1 Rationale

Milestone 1 is implemented end to end:

- `RunRequest` and `ChatRequest` accept strict `ContextRef[]` values;
- core resolves refs before run creation;
- resolved evidence is bounded and injected under the reserved runtime context;
- source refs and compact resolution data are persisted in run metadata;
- core emits `context.refs.resolved`;
- Agent SDK parses and forwards explicit `run:<id>` and `session:<id>` refs.

The Milestone 1 implementation review identified the following issues that
Context Ref 1.1 addresses before named bundles, memory, or loops build on the
primitive.

### Cross-store session determinism

Before Context Ref 1.1, the resolver called `RunStore.listBySession` without
explicit paging. The Postgres store applied a default limit while the in-memory
store could return the complete session. The resolver then re-sorted the
returned subset and kept the first matching runs, so large sessions could
resolve to different run sets in different stores.

The prior oldest-first selection was also a weak default for the main session
ref use case: continuing from recent session evidence normally needs the latest
successful root runs.

### Per-run session authorization

The Milestone 1 authorization hook could authorize the session ref, but it was
not invoked with each candidate `targetRun`. A `sessionId` remains a correlation
key, not proof that every run returned for that id is visible to the caller.

### Resolution-time source provenance

Milestone 1 resolved material recorded source ids and results but not the source
run version or resolution-time timestamps. Runtime operations such as retry can
change a run record in place. The consuming run kept its bounded resolved
payload, but an inspector could not prove which source record version produced
that payload.

### CLI and orchestration consistency

Context Ref 1.1 requires interactive chat to preserve command-line context refs
when constructing each chat request. Event and inspection output also make ref
resolution and truncation visible without requiring raw metadata inspection.

Context refs remain direct `run` and `chat` request inputs in Context Ref 1.1.
They must not be partially or accidentally propagated across orchestration
stages. Orchestration requests should reject context refs clearly until a later
design defines which stages receive them and whether they are resolved once or
once per stage.

## Context Ref 1.1 (Implemented)

Context Ref 1.1 is a hardening milestone plus one small capability: explicit
session selection. It does not introduce a new ref kind or a new autonomous
workflow.

### Session selection contract

Extend only the `session` variant:

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
      selection?: 'latest' | 'earliest';
      rootRunsOnly?: boolean;
      maxRuns?: number;
      maxScanRuns?: number;
      maxBytes?: number;
      allowStatuses?: RunStatus[];
    };
```

Rules:

- `selection` defaults to `latest`.
- Selection is applied after root-run and status filtering.
- `latest` returns the newest matching runs in chronological presentation order.
- `earliest` returns the oldest matching runs in chronological presentation
  order.
- `maxScanRuns` defaults to `500` and bounds candidate discovery from the
  selected end of the session chronology.
- Ordering uses `createdAt` and then `id` as a stable tie-breaker.
- Truncation warnings state which end was retained, for example
  `included latest 10 of 37 matching runs`.
- Changing the Milestone 1 oldest-first default to `latest` is a behavior change
  and must be called out in release notes.

### Store ordering and paging

`RunStore.listBySession` must have a documented ordering and paging contract.
The resolver must request the selected end of the chronology explicitly rather
than depending on a store's default limit or return order.

Implementation may add an explicit order option or an equivalent store query,
but both in-memory and Postgres stores must satisfy the same contract. The
resolver should also enforce a bounded scan policy for very large sessions and
report when the scan bound affects selection.

### Per-run session authorization

Resolution should:

1. authorize the session ref before listing its runs;
2. invoke `ContextRefAuthorizer` for each candidate with `targetRun` set;
3. omit unauthorized candidates without exposing their content;
4. record only a compact omission warning;
5. fail before run creation when the session has candidate runs but none are
   authorized and eligible.

Core still does not define tenant or project semantics. A host may additionally
scope its `RunStore` so unauthorized rows are never returned.

### Resolution-time source provenance

Add provenance stamps to both a resolved run ref and every session run summary:

```ts
interface ResolvedSourceRunProvenance {
  sourceRunVersion: number;
  sourceUpdatedAt: string;
  sourceCompletedAt?: string;
}
```

Persist the stamps in the bounded model-visible resolved material and compact
audit data. Include them in `context.refs.resolved` so inspectors can identify
the exact source record generation that was consumed.

### CLI and inspection behavior

- Interactive and inline `chat` must forward the same `contextRefs`.
- JSON and dry-run output must show the strict refs that will be submitted.
- Pretty event output should summarize ref count, total bytes, and truncation.
- `inspect` should show compact source and resolution metadata.
- CLI shorthand remains explicit; do not add ambiguous `@id` parsing.

### Context Ref 1.1 acceptance criteria

- A session with more than the Postgres default page size resolves to the same
  run ids in in-memory and Postgres stores.
- `latest` and `earliest` have deterministic tests with equal timestamps and id
  tie-breakers.
- Status and root-run filtering occur before `maxRuns` selection.
- Scan-bound and byte-bound truncation are deterministic and visible in
  warnings, metadata, and events.
- A session authorizer is called for the ref and each candidate run.
- No unauthorized run goal, result, error, or usage enters resolved material.
- Source version and timestamps are preserved even if the source run record is
  later retried or updated.
- Interactive `chat --context-ref ...` submits the ref on every intended chat
  request.
- Orchestration does not silently propagate context refs to only some stages.

## Implementation Milestone 2: Named Context Bundles (Implemented)

After Context Ref 1.1, add Agent SDK-owned named bundles as the first new
feature. Bundles solve the immediate usability problem of repeatedly supplying
the same curated evidence set without introducing invisible memory or autonomous
execution.

### Bundle contract

The initial SDK contract is deliberately small:

```ts
export interface ContextBundle {
  schemaVersion: 1;
  name: string;
  description?: string;
  refs: ContextRef[];
}
```

Rules:

- `refs` contains only core `run` and `session` refs.
- `description` is for display and audit only; it is not model-visible context.
- Bundles cannot contain other bundles.
- Bundle expansion preserves declaration order.
- An unknown, empty, invalid, or unauthorized bundle fails before model
  execution.
- Existing per-ref and request-level byte limits apply after expansion.
- Core revalidates and authorizes every expanded primitive ref.

### Ownership and resolution flow

Agent SDK owns:

- the initial local bundle registry and project-scoped name resolution;
- CLI commands that create, list, show, and delete bundles;
- resolving `--context-bundle <name>`;
- expanding bundle refs into strict `ContextRef[]` before calling core;
- friendly namespace and validation errors.

Core continues to own:

- validation of expanded `run` and `session` refs;
- authorization hooks;
- deterministic resolution and limits;
- model-visible rendering;
- persisted audit metadata and events.

Core does not add a `bundle` ref kind in this milestone.

The local project registry is stored at
`<cwd>/.adaptiveAgent/context-bundles/<name>.json`. Bundle digests are lowercase
SHA-256 values over canonical JSON: object keys are sorted recursively and array
order, including ref declaration order, is preserved.

### CLI shape

```bash
adaptive-agent context create migration-research \
  --ref run:550e8400-e29b-41d4-a716-446655440000 \
  --ref session:session_456

adaptive-agent context show migration-research

adaptive-agent run \
  --context-bundle migration-research \
  "Draft the migration plan"
```

`--context-ref` and `--context-bundle` may be combined. Agent SDK expands
bundles in command-line order and submits one explicit primitive ref list.

### Bundle audit and reproducibility

At request preparation, Agent SDK should add compact non-model-visible metadata:

```ts
metadata: {
  contextBundles: [
    {
      name: 'migration-research',
      scope: 'project',
      digest: '<canonical-content-digest>',
      expandedRefs: [
        { kind: 'run', id: '550e8400-e29b-41d4-a716-446655440000' },
        { kind: 'session', id: 'session_456' }
      ]
    }
  ]
}
```

Core's existing `metadata.contextRefs` remains the runtime source of truth for
what was resolved. Bundle name and digest explain how Agent SDK assembled that
list. A later edit to the named bundle must not change the historical consuming
run's expanded refs or resolved payload.

### Named bundle acceptance criteria

- The same project-scoped name resolves deterministically to the same ordered
  primitive refs and digest.
- Bundle expansion occurs before the core request and does not require a core
  dependency on Agent SDK storage or config.
- Dry-run and JSON output show bundle identity and expanded refs.
- Historical run metadata remains sufficient to inspect the exact expansion
  after the bundle is changed or deleted.
- Authorization and byte-limit failures occur before model execution.
- Bundle descriptions are never injected as model instructions or evidence.

### Explicitly deferred after Milestone 2

- global, organization, or cross-tenant bundle namespaces;
- nested bundles;
- dynamic bundle queries such as `all runs tagged research`;
- automatic bundle refresh or mutation;
- core-owned bundle persistence or a core `bundle` ref variant;
- agent-created bundles;
- `remember` and `recall` tools;
- evaluation-driven continuation loops;
- hard cross-run budget enforcement.
