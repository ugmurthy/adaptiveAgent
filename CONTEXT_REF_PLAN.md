# Context References, Memory, and Evaluation Loops Plan

## Purpose

Add a durable, inspectable way for a new run to use prior `run` and `sessionId`
outputs as context through simple references such as `@<runId>` or
`@<sessionId>`.

This plan also lays out two extensions that build on the same primitive:

- named context bundles, including tool-backed agentic memory;
- evaluation-driven continuation loops that launch new runs until a goal is
  satisfied, blocked, or bounded controls stop execution.

The design must preserve the existing Adaptive Agent boundary:

- `@adaptive-agent/core` owns durable execution semantics, validation,
  persistence, eventing, snapshots, usage accounting, and loop/session budget
  enforcement.
- `@adaptive-agent/agent-sdk` owns CLI-facing syntax, agent profile loading,
  user-friendly errors, memory policy prompts, and translation of user intent
  into strict core requests.

## Non-Goals

- Do not make `@<id>` mean `resume`.
- Do not introduce a separate `swarmId`.
- Do not introduce a DAG runtime, parallel child runs, child messaging, or
  hidden chain-of-thought persistence.
- Do not make memory invisible prompt magic.
- Do not let Agent SDK become the owner of durable loop execution or budget
  enforcement.
- Do not make core depend on Agent SDK agent specs, CLI syntax, config paths, or
  default profiles.

## Terminology

- `context ref`: A typed reference to prior durable runtime data. Initial kinds
  are `run`, `session`, and later `bundle`.
- `resolved context ref`: The bounded, structured context material produced from
  a `context ref`.
- `context bundle`: A named collection of refs and optional notes that can be
  attached to future runs.
- `memory`: A durable, searchable context bundle or note created by a user or by
  an agent through explicit tools.
- `evaluation-driven continuation`: A loop where an evaluator run reviews prior
  run outputs and decides whether to `stop`, `continue`, `replan`, or
  `ask_user`.
- `loop session`: A group of attempt, evaluation, and synthesis runs under one
  `sessionId`.
- `budget envelope`: A persisted cost and iteration policy shared by all runs in
  a loop session or bundle-driven workflow.

## Product Shape

### CLI Examples

```bash
adaptive-agent run --context-ref @run_123 "Use the prior research and write a final brief"

adaptive-agent run --context-ref @session_456 "Continue the investigation from this session"

adaptive-agent context create migration-research \
  --ref @run_123 \
  --ref @run_789 \
  --note "Research collected for the migration plan"

adaptive-agent run --context-bundle migration-research "Draft the migration plan"

adaptive-agent loop \
  --context-ref @session_456 \
  --max-iterations 5 \
  --max-total-cost 3.00 \
  "Research until evidence is sufficient, then summarize"
```

### Programmatic Shape

```ts
export type ContextRefKind = 'run' | 'session' | 'bundle';

export type ContextRefInclude =
  | 'output'
  | 'summary'
  | 'events'
  | 'snapshot'
  | 'tree';

export interface ContextRef {
  kind?: ContextRefKind;
  id: string;
  include?: ContextRefInclude;
  maxBytes?: number;
  allowNonTerminal?: boolean;
}

export interface ResolvedContextRef {
  ref: ContextRef;
  kind: ContextRefKind;
  id: string;
  status?: RunStatus;
  goal?: string;
  output?: JsonValue;
  summary?: string;
  runs?: ResolvedRunSummary[];
  warnings?: string[];
  truncated?: boolean;
}

export interface ResolvedRunSummary {
  runId: UUID;
  sessionId?: string;
  role?: string;
  goal: string;
  status: RunStatus;
  outputSummary?: JsonValue;
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

Core should resolve refs into a reserved context key before model execution:

```ts
context: {
  ...request.context,
  __resolvedContextRefs: ResolvedContextRef[]
}
```

The reserved key is intentionally explicit so downstream runs and events can
show exactly which prior runtime data was used.

## Core Responsibilities

Core should provide strict, reusable primitives:

- validate `ContextRef` shapes;
- resolve `run` refs through `RunStore.getRun`;
- resolve `session` refs through `RunStore.listBySession`;
- resolve optional event and snapshot summaries through `EventStore` and
  `SnapshotStore`;
- cap serialized context size by ref and by request;
- reject or warn on non-terminal refs according to policy;
- emit context resolution events;
- persist source refs in run metadata;
- enforce hard budget envelopes for loop/session execution.

Core must not:

- parse CLI syntax such as `@run_123`;
- infer user-facing names from config paths;
- decide when project memory should be stored;
- load Agent SDK agent profiles;
- bypass validation because Agent SDK prevalidated refs.

## Agent SDK Responsibilities

Agent SDK should own user-facing workflows:

- parse `--context-ref @id`, `--context-bundle <name>`, and shorthand `@id`
  where appropriate;
- disambiguate ids into `run`, `session`, or `bundle` using CLI rules;
- render friendly errors and suggested commands;
- load memory and loop agent profiles;
- construct evaluator prompts and structured output schemas;
- expose memory tools according to user or project policy;
- translate CLI options into strict core requests.

## Context Resolution Rules

Initial rules:

- `run` refs default to `include: 'output'`.
- `session` refs default to `include: 'summary'`.
- `bundle` refs expand to their member refs and notes.
- Non-terminal refs are rejected by default unless `allowNonTerminal` is true.
- Failed refs are allowed only when explicitly requested or when the new run is
  an evaluation/recovery run.
- Context resolution must be deterministic for the same store state and policy.
- Resolution must emit warnings instead of silently dropping unavailable fields.
- Raw snapshots are not model-visible by default; snapshot summaries may be
  model-visible.

Suggested event:

```ts
type EventType = 'context.refs.resolved' | ExistingEventType;

interface ContextRefsResolvedPayload {
  refs: ContextRef[];
  resolved: Array<{
    kind: ContextRefKind;
    id: string;
    status?: string;
    bytes: number;
    truncated?: boolean;
    warnings?: string[];
  }>;
  totalBytes: number;
}
```

## Named Context Bundles

Context bundles are durable named collections of refs and notes.

```ts
export interface ContextBundle {
  id: string;
  namespace: string;
  name: string;
  refs: ContextRef[];
  notes?: string;
  createdBy: 'user' | 'agent' | 'system';
  sourceRunId?: UUID;
  trust: 'scratch' | 'derived' | 'pinned';
  metadata?: Record<string, JsonValue>;
  createdAt: string;
  updatedAt: string;
}
```

Initial storage can be in a new `ContextBundleStore`:

```ts
export interface ContextBundleStore {
  create(bundle: Omit<ContextBundle, 'id' | 'createdAt' | 'updatedAt'>): Promise<ContextBundle>;
  getById(id: string): Promise<ContextBundle | null>;
  getByName(namespace: string, name: string): Promise<ContextBundle | null>;
  list(namespace: string, options?: { limit?: number; offset?: number }): Promise<ContextBundle[]>;
  update(id: string, patch: Partial<ContextBundle>): Promise<ContextBundle>;
  delete(id: string): Promise<void>;
}
```

Namespace examples:

- `user:<userId>`;
- `project:<workspaceHash>`;
- `session:<sessionId>`;
- `agent:<agentId>`.

## Agentic Memory Tools

Agentic memory should be explicit tool use over context bundles and memory
records. The agent may decide to remember something, but the action must be
observable, policy-controlled, and optionally approval-gated.

Initial tools:

```ts
remember({
  namespace: 'project:adaptive-agent',
  title: 'Core vs Agent SDK boundary',
  content: 'Core owns durable runtime semantics. Agent SDK owns CLI setup.',
  sourceRefs: ['@run_123', '@session_456'],
  trust: 'derived'
})
```

```ts
recall({
  namespace: 'project:adaptive-agent',
  query: 'core session swarm boundary',
  limit: 5
})
```

Memory categories:

- `user-pinned`: durable, high trust, usually user-approved;
- `project`: scoped to a repo or workspace;
- `run-derived`: generated from run/session output, lower trust until promoted;
- `scratch`: temporary workflow memory.

Memory write policy should support:

- require approval for durable writes;
- require source refs;
- reject writes without namespace;
- optional expiration;
- max record size;
- max records per namespace;
- audit events for create/update/delete.

## Evaluation-Driven Continuation Loops

Loops should be sequences of ordinary durable runs under one `sessionId`, not a
single hidden long-running run.

Example loop:

```text
sessionId: s1
  run r1: attempt
  run r2: evaluate @r1
  run r3: continue from @r1 and @r2
  run r4: evaluate @r3
  run r5: synthesize final result
```

Evaluator output should be structured:

```ts
export type LoopDecision = 'stop' | 'continue' | 'replan' | 'ask_user';

export interface LoopEvaluation {
  decision: LoopDecision;
  reason: string;
  goalSatisfied: boolean;
  nextGoal?: string;
  contextRefs?: ContextRef[];
  confidence?: number;
}
```

Loop policy:

```ts
export interface LoopPolicy {
  maxIterations: number;
  maxRuns?: number;
  evaluatorAgentId?: string;
  synthesizerAgentId?: string;
  requireApprovalBeforeContinue?: boolean;
  budget?: BudgetPolicy;
}
```

The loop orchestrator should launch independent root runs, each with:

- same `sessionId`;
- metadata linking to the loop coordinator run;
- context refs to prior attempts and evaluations;
- explicit role metadata such as `attempt`, `evaluation`, or `synthesizer`.

Do not use child runs for loop iterations. Child runs remain delegate-as-tool
runs.

## Budget and Hard Cost Controls

Total cost limits should be first-class durable controls.

```ts
export interface BudgetPolicy {
  maxTotalCostUSD?: number;
  maxModelCostUSD?: number;
  maxToolCostUSD?: number;
  maxRuns?: number;
  maxIterations?: number;
  minFinalizationBudgetUSD?: number;
  unknownCostBehavior?: 'reject' | 'allow' | 'estimate';
  unknownCostEstimateUSD?: number;
  exhaustionBehavior?: 'stop' | 'summarize_current_best' | 'ask_user';
}
```

Core enforcement rules:

- Persist the budget envelope on loop/session metadata.
- Check the envelope before launching a new run.
- Check again before model calls and billable tool calls when an estimate is
  available.
- After each `usage.updated` event, recompute aggregate session/loop spend.
- Stop before exceeding `maxTotalCostUSD`.
- Preserve the envelope across resume and retry.
- Under strict mode, reject unpriced paid tools or use the configured worst-case
  estimate.

Budget exhaustion should produce a structured stop reason:

```ts
export interface BudgetExhausted {
  reason: 'budget_exhausted';
  spentUSD: number;
  maxTotalCostUSD: number;
  phase: 'before_run' | 'before_model' | 'before_tool' | 'after_usage_update';
}
```

Default loop behavior should be `summarize_current_best` when enough budget
remains for one final synthesis run. Otherwise stop with a clear result.

## Persistence

### Context bundles

Postgres table:

```sql
create table if not exists context_bundles (
  id text primary key,
  namespace text not null,
  name text not null,
  refs jsonb not null default '[]'::jsonb,
  notes text,
  created_by text not null,
  source_run_id text references agent_runs(id) on delete set null,
  trust text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (namespace, name)
);

create index if not exists context_bundles_namespace_idx
  on context_bundles (namespace, updated_at desc, id);
```

### Memory records

Memory can initially reuse bundles with `trust` and `metadata`. If search needs
outgrow simple name/list lookup, add a separate `memory_records` table later:

```sql
create table if not exists memory_records (
  id text primary key,
  namespace text not null,
  title text not null,
  content text not null,
  source_refs jsonb not null default '[]'::jsonb,
  trust text not null,
  created_by text not null,
  source_run_id text references agent_runs(id) on delete set null,
  expires_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

### Loop metadata

Loop state can be represented in run metadata first:

```ts
interface LoopMetadata {
  kind: 'evaluation_loop';
  coordinatorRunId: UUID;
  role: 'coordinator' | 'attempt' | 'evaluation' | 'synthesizer';
  iteration?: number;
  sourceRunIds?: UUID[];
  budget?: BudgetPolicy;
}
```

Add a separate `loop_executions` table only after the metadata convention proves
insufficient for querying and dashboards.

## Phased Implementation

### Phase 0: Contract Alignment

Goal: Update docs and type contracts without changing behavior.

Tasks:

- Add `ContextRef`, `ResolvedContextRef`, and related types in
  `packages/core/src/types.ts`.
- Add optional `contextRefs` to `RunRequest` and `ChatRequest`.
- Add reserved context key documentation for `__resolvedContextRefs`.
- Add event type placeholder for `context.refs.resolved`.
- Add test fixtures for valid and invalid ref shapes.

Verification:

- `bunx vitest run packages/core/src/types.test.ts` if type tests exist.
- `bun run build` in `packages/core`.

### Phase 1: Run and Session Context Refs

Goal: Allow a new run/chat request to reference prior run or session outputs.

Core tasks:

- Implement `ContextRefResolver`.
- Resolve `run` refs with `RunStore.getRun`.
- Resolve `session` refs with `RunStore.listBySession`.
- Include final `AgentRun.result`, goal, status, usage, and role metadata.
- Add request-level and ref-level byte limits.
- Add non-terminal and failed-run policy checks.
- Emit `context.refs.resolved`.
- Attach source refs to created run metadata.
- Inject resolved refs into `context.__resolvedContextRefs`.

Agent SDK tasks:

- Add `--context-ref <ref>` to `run` and `chat` commands.
- Parse explicit refs such as `run:<id>`, `session:<id>`, and shorthand `@id`.
- Produce CLI-friendly errors for ambiguous or missing refs.
- Preserve JSON output fields with refs metadata.

Verification:

- Core unit tests for run ref resolution.
- Core unit tests for session ref resolution.
- Core tests for truncation, failed refs, non-terminal refs, and missing refs.
- Agent SDK CLI tests for `--context-ref`.
- `bunx vitest run packages/core/src`.
- `bunx vitest run packages/agent-sdk/src`.

### Phase 2: Context Bundles

Goal: Add named reusable groups of refs.

Core tasks:

- Add `ContextBundleStore` interface.
- Add in-memory bundle store.
- Add Postgres bundle store and migration.
- Extend resolver to expand `bundle` refs.
- Prevent recursive bundle expansion cycles.
- Emit bundle expansion warnings.

Agent SDK tasks:

- Add `adaptive-agent context create`.
- Add `adaptive-agent context list`.
- Add `adaptive-agent context show`.
- Add `adaptive-agent context delete`.
- Add `--context-bundle <name-or-id>` to `run` and `chat`.
- Choose namespace defaults from project/workspace configuration.

Verification:

- Store tests for in-memory and Postgres implementations.
- Resolver tests for nested bundles and cycle detection.
- CLI tests for context bundle commands.

### Phase 3: Explicit Agentic Memory Tools

Goal: Let agents remember and recall important information through observable
tools.

Core tasks:

- Implement memory tools as normal `ToolDefinition`s or a small helper that
  produces them from a configured store.
- Ensure `remember` emits tool execution records and normal events.
- Add redaction and size limits.
- Add approval support for durable memory writes.
- Record `sourceRunId` and `sourceRefs`.

Agent SDK tasks:

- Add memory policy configuration.
- Add CLI flags to enable memory tools for selected agents.
- Add default prompts that tell agents when memory writes are appropriate.
- Add commands to promote derived memory to pinned memory.

Verification:

- Tool tests for `remember` and `recall`.
- Approval-gated memory write tests.
- Tests that memory tools are absent unless configured.
- Tests that memory writes preserve source refs.

### Phase 4: Evaluation-Driven Continuation

Goal: Implement bounded loops using ordinary durable runs and context refs.

Core tasks:

- Add strict loop execution request types.
- Implement a core loop executor that accepts already-prepared attempt,
  evaluator, and synthesizer requests.
- Persist loop role metadata on each root run.
- Validate evaluator structured output.
- Stop on `stop`, `ask_user`, `maxIterations`, `maxRuns`, terminal failures, or
  budget exhaustion.
- Use context refs between iterations instead of hidden state mutation.

Agent SDK tasks:

- Add `adaptive-agent loop`.
- Load evaluator and synthesizer agent profiles.
- Build evaluator prompt and output schema.
- Translate evaluator decisions into strict core loop requests.
- Render loop progress and final status.

Verification:

- Core tests for loop stop decisions.
- Core tests for `continue`, `replan`, and `ask_user` decisions.
- Core tests that each loop member is an independent root run under the same
  `sessionId`.
- Agent SDK CLI tests for loop workflows.

### Phase 5: Hard Budget Envelope

Goal: Enforce total cost limits across loop/session execution.

Core tasks:

- Add `BudgetPolicy` types.
- Persist budget policy in loop/session metadata.
- Aggregate spend from `AgentRun.usage.estimatedCostUSD` and tool accounting.
- Check budget before launching runs.
- Check budget before model calls when an estimate is available.
- Check budget before billable tools when accounting is known.
- Handle unknown-cost tools according to `unknownCostBehavior`.
- Emit budget stop events and structured results.
- Preserve budget policy through resume and retry.

Agent SDK tasks:

- Add `--max-total-cost`, `--max-model-cost`, `--max-tool-cost`,
  `--unknown-cost-behavior`, and `--budget-exhaustion-behavior`.
- Render spent/remaining cost in pretty and JSON output.
- Warn when provider usage lacks cost estimates.

Verification:

- Unit tests for aggregate cost computation.
- Tests that loops stop before exceeding `maxTotalCostUSD`.
- Tests for unknown-cost tool behavior.
- Tests for resume/retry preserving budget.
- CLI tests for cost flags and rendered output.

### Phase 6: Dashboard and Trace Integration

Goal: Make refs, memory, loops, and budgets inspectable.

Tasks:

- Show `context.refs.resolved` events in trace/session views.
- Show source refs on run detail pages.
- Show context bundle membership.
- Show memory writes as normal tool executions.
- Show loop tree grouped by `sessionId` and coordinator run id.
- Show budget spent, remaining, and stop reason.

Verification:

- Dashboard API tests where available.
- Trace-session tests must continue to work without gateway tables.
- Manual inspection of run trees with context refs and loops.

## Implementation Guidance for Coding Agents

Work in small vertical slices:

1. Add types and validation first.
2. Implement core resolver with in-memory stores.
3. Add Postgres persistence only after behavior tests pass.
4. Add Agent SDK CLI flags after core APIs are stable.
5. Add bundles before memory tools.
6. Add loops before hard budget enforcement only if loop cost is clearly marked
   experimental; otherwise implement budget checks before exposing loops broadly.

Keep tests focused on durable behavior:

- source refs are persisted;
- resolved refs are deterministic;
- context size limits are enforced;
- events are emitted;
- loops create independent root runs;
- budget exhaustion is durable and structured.

Avoid broad refactors. Do not alter historical v1.4 docs. Update v1.5 docs only
when public contracts change.

## Open Questions

- Should `contextRefs` be part of the public v1.5 contract or staged as an
  experimental extension first?
- Should `bundle` refs live in core immediately, or begin in Agent SDK with a
  core-compatible store interface?
- What namespace defaults should CLI use for local repositories?
- Should failed source runs be allowed by default for evaluation runs?
- Should session refs include child runs by default, or only root runs?
- What is the first acceptable summarization strategy: deterministic truncation,
  model-generated summaries, or both?
- Should memory search start with plain text matching and graduate to embeddings
  later?
- Should budget enforcement be tied to `sessionId`, loop coordinator metadata,
  or both?

## Recommended First Milestone

Ship a narrow `context-ref` MVP:

- `RunRequest.contextRefs`;
- `ChatRequest.contextRefs`;
- `ContextRefResolver`;
- `run` and `session` refs;
- final output and run summary only;
- `context.refs.resolved` event;
- `--context-ref` CLI flag;
- strict byte limits;
- no bundles, no memory, no loops.

This milestone is immediately useful and creates the stable substrate for named
bundles, agentic memory, evaluation-driven continuation, and cost-bounded loops.
