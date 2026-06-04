# Core Session and Swarm Orchestration Implementation Spec

## Purpose

Extend `@adaptive-agent/core` so a complex natural-language objective can be decomposed into independent subtasks, executed as a bounded swarm of agents under one persisted `sessionId`, quality-checked, and synthesized into one final result.

This spec captures the agreed implementation direction:

- Add first-class persisted `sessionId` support to core runs.
- Use the coordinator/top-level run id as the orchestration grouping id; do not introduce a separate `swarmId`.
- Keep the decomposer logic inside the coordinator flow.
- Preserve existing child-run delegation semantics for delegates-as-tools.
- Do not introduce multi-child parent runs.
- Represent swarm workers as independent session-linked runs, not simultaneous children of the coordinator.

## Background

`AdaptiveAgent.run()` and `AdaptiveAgent.chat()` already accept `metadata` and `context`, and gateway sessions already persist session records and session-run links. Core runtime runs, however, do not currently expose a first-class `sessionId` field. This limits durable grouping and querying of multiple related runs when no gateway session-run-link store is involved.

The desired swarm behavior is broader than current delegate child-run behavior:

- Delegate child runs are useful when an agent invokes a delegate as a custom tool.
- Swarm workers are independent tasks launched in parallel or bounded parallelism under one high-level objective.

The implementation should therefore add durable session correlation to core and layer swarm orchestration on top of independent root runs.

## Terminology

- `sessionId`: Durable core-level correlation key shared by all runs for one high-level task or conversation.
- `coordinatorRunId`: The run id of the top-level coordinator run for a swarm execution. This replaces any separate `swarmId` concept.
- `coordinator`: The top-level orchestration role. It owns decomposition, worker launch coordination, quality-check invocation, and synthesis invocation.
- `subtask`: One decomposed independent natural-language task derived from the top-level objective.
- `worker run`: An independent root run that executes one subtask under the same `sessionId` and with `coordinatorRunId` in orchestration metadata.
- `quality run`: A run that assesses worker outputs against the top-level objective and subtask objectives.
- `synthesizer run`: A run that produces the final answer from worker results and quality assessments.
- `child run`: Existing delegate-as-tool run linked by `parentRunId`, `parentStepId`, `delegateName`, and `currentChildRunId`. Child runs are not used for concurrent swarm fan-out.

## Design Principles

1. `sessionId` is a core run correlation field, not a replacement for gateway authorization or transcript ownership.
2. The coordinator run id is sufficient to group swarm members within a session.
3. Child runs remain the mechanism for delegate-as-tool execution.
4. Swarm worker runs are independent root runs linked by `sessionId` and orchestration metadata.
5. No multi-child parent model is introduced.
6. Agent definitions remain the source of truth for allowed tools; swarm task interfaces should not duplicate `allowedTools`.
7. Nomenclature must distinguish top-level objectives from subtask objectives.

## Core Data Model Changes

### Type changes

Add optional `sessionId` to run and chat requests:

```ts
export interface RunRequest {
  sessionId?: string;
  goal: string;
  input?: JsonValue;
  images?: ImageInput[];
  contentParts?: ModelContentPart[];
  context?: Record<string, JsonValue>;
  allowedTools?: string[];
  forbiddenTools?: string[];
  outputSchema?: JsonSchema;
  metadata?: Record<string, JsonValue>;
}

export interface ChatRequest {
  sessionId?: string;
  messages: ChatMessage[];
  context?: Record<string, JsonValue>;
  outputSchema?: JsonSchema;
  metadata?: Record<string, JsonValue>;
}
```

Add optional `sessionId` to `AgentRun`:

```ts
export interface AgentRun {
  id: UUID;
  sessionId?: string;
  rootRunId: UUID;
  parentRunId?: UUID;
  parentStepId?: string;
  delegateName?: string;
  delegationDepth: number;
  currentChildRunId?: UUID;
  goal: string;
  input?: JsonValue;
  context?: Record<string, JsonValue>;
  // existing fields unchanged
}
```

Add optional `sessionId` to `RunStore.createRun()` input:

```ts
export interface RunStore {
  createRun(run: {
    id?: UUID;
    sessionId?: string;
    rootRunId?: UUID;
    parentRunId?: UUID;
    parentStepId?: string;
    delegateName?: string;
    delegationDepth?: number;
    currentChildRunId?: UUID;
    goal: string;
    input?: JsonValue;
    context?: Record<string, JsonValue>;
    modelProvider?: string;
    modelName?: string;
    modelParameters?: Record<string, JsonValue>;
    metadata?: Record<string, JsonValue>;
    status: RunStatus;
  }): Promise<AgentRun>;
}
```

### PostgreSQL changes

Add `session_id` to `agent_runs`:

```sql
alter table agent_runs
  add column if not exists session_id text;

create index if not exists agent_runs_session_idx
  on agent_runs (session_id, created_at desc, id)
  where session_id is not null;
```

The column is intentionally `text`, matching gateway session ids and allowing caller-owned session id formats.

### Store query support

Add a run query helper after the persistence field is in place:

```ts
export interface RunStore {
  listBySession?(sessionId: string, options?: {
    limit?: number;
    offset?: number;
  }): Promise<AgentRun[]>;
}
```

This can be optional initially to avoid forcing every in-memory or test store to implement advanced queries in the first patch. Once stabilized, it can become required.

## Session Propagation Rules

### Root runs

When `AdaptiveAgent.run()` receives `request.sessionId`, it must persist that value on the created run.

When `AdaptiveAgent.chat()` receives `request.sessionId`, it must persist that value on the created run.

### Delegate child runs

Child runs created by delegate tools must inherit the parent run's `sessionId` unless an explicit override is later introduced. No override is planned for the initial implementation.

This ensures a session query returns the coordinator run, worker runs, quality run, synthesizer run, and any delegate child runs created beneath them.

### Continuation and retry

Continuation and retry flows must preserve the source run's `sessionId` unless the caller explicitly supplies a new one in future API extensions. The initial implementation should preserve by default and avoid introducing a new override.

## Orchestration Metadata Convention

Use `metadata.orchestration` for swarm-specific linkage:

```ts
interface OrchestrationMetadata {
  kind: 'swarm';
  coordinatorRunId: UUID;
  role: 'coordinator' | 'worker' | 'quality' | 'synthesizer';
  subtaskId?: string;
}
```

Example worker metadata:

```ts
metadata: {
  orchestration: {
    kind: 'swarm',
    coordinatorRunId: '6f1c...',
    role: 'worker',
    subtaskId: 'subtask-3'
  }
}
```

No separate `swarmId` is introduced. The pair of `sessionId` and `coordinatorRunId` identifies one high-level swarm execution.

## Swarm API Shape

The initial orchestration API should be implemented as a helper/coordinator layer rather than deeply changing `AdaptiveAgent` execution internals.

```ts
export interface SwarmRequest {
  sessionId?: string;
  topLevelObjective: string;
  input?: JsonValue;
  contentParts?: ModelContentPart[];
  maxWorkers?: number;
  metadata?: Record<string, JsonValue>;
}

export interface SwarmAttachment {
  id: string;
  contentPart: ModelContentPart;
  description?: string;
  metadata?: Record<string, JsonValue>;
}

export interface SwarmSubtask {
  id: string;
  subObjective: string;
  input?: JsonValue;
  attachmentRefs?: string[];
  targetAgentId?: string;
  metadata?: Record<string, JsonValue>;
}

export interface SwarmSubtaskResult {
  subtaskId: string;
  runId: UUID;
  rootRunId: UUID;
  status: RunStatus;
  output?: JsonValue;
  errorCode?: string;
  errorMessage?: string;
}

export interface SwarmQualityAssessment {
  subtaskId: string;
  runId: UUID;
  usable: boolean;
  score?: number;
  issues?: string[];
  recommendation: 'use' | 'ignore' | 'retry' | 'needs_human';
}

export interface SwarmRunResult {
  sessionId: string;
  coordinatorRunId: UUID;
  subtaskResults: SwarmSubtaskResult[];
  qualityRunId?: UUID;
  synthesizerRunId?: UUID;
  qualityAssessments?: SwarmQualityAssessment[];
  status: RunStatus;
  output?: JsonValue;
  errorCode?: string;
  errorMessage?: string;
}
```

`targetAgentId` identifies which configured agent should run a subtask. The target agent's definition remains responsible for its model, instructions, and allowed tools.

`contentParts` carries the top-level multimodal input for the swarm request. It should use the same `ModelContentPart` shape as `RunRequest.contentParts`, including text, image, file, and audio parts. Decomposition output should not duplicate raw files or inline blobs into every subtask; it should refer to coordinator-owned attachments by id.

## Multimodal Input Decomposition and Attachment Routing

The coordinator must handle objectives that combine a natural-language description with files or other modalities. Examples include:

- one text objective plus multiple PDFs;
- one text objective plus screenshots or charts;
- one text objective plus audio files;
- mixed image, file, and text parts where only some subtasks need some inputs.

### Attachment inventory

Before decomposition, the coordinator should convert `SwarmRequest.contentParts` into a deterministic attachment inventory:

```ts
interface SwarmAttachment {
  id: string;
  contentPart: ModelContentPart;
  description?: string;
  metadata?: Record<string, JsonValue>;
}
```

Attachment ids should be stable within the coordinator run, such as `attachment-1`, `attachment-2`, or caller-provided names normalized to unique ids. The inventory should preserve original `ModelContentPart` values and any useful metadata such as `name`, `mimeType`, source kind, and size when available.

### Decomposer input

The decomposer logic inside the coordinator receives:

- `topLevelObjective`;
- `input`, if supplied;
- the attachment inventory summary;
- optionally the actual `contentParts` when the coordinator model supports the relevant input modalities.

The attachment inventory summary should be structured enough for the decomposer to reference files without inventing paths or duplicating payloads. Example:

```json
{
  "attachments": [
    {
      "id": "attachment-1",
      "type": "file",
      "name": "financials.pdf",
      "mimeType": "application/pdf"
    },
    {
      "id": "attachment-2",
      "type": "image",
      "name": "dashboard.png",
      "mimeType": "image/png"
    }
  ]
}
```

### Decomposer output

Each `SwarmSubtask` may include `attachmentRefs`:

```ts
export interface SwarmSubtask {
  id: string;
  subObjective: string;
  input?: JsonValue;
  attachmentRefs?: string[];
  targetAgentId?: string;
  metadata?: Record<string, JsonValue>;
}
```

`attachmentRefs` must contain only ids from the coordinator attachment inventory. The coordinator must validate refs before launching workers.

Example decomposition result:

```json
{
  "id": "subtask-2",
  "subObjective": "Extract revenue assumptions from the financial model PDF and summarize risks.",
  "attachmentRefs": ["attachment-1"],
  "targetAgentId": "finance-analysis-agent"
}
```

### Worker input construction

For each worker run, the coordinator resolves `attachmentRefs` to `contentParts` and passes only the selected attachments to that worker.

Worker request construction:

```ts
const selectedContentParts = resolveAttachmentRefs(subtask.attachmentRefs, attachmentInventory);

await workerAgent.run({
  sessionId,
  goal: subtask.subObjective,
  input: subtask.input,
  contentParts: selectedContentParts,
  context: {
    topLevelObjective,
    subtaskId: subtask.id,
    attachmentRefs: subtask.attachmentRefs ?? [],
  },
  metadata: {
    ...subtask.metadata,
    orchestration: {
      kind: 'swarm',
      coordinatorRunId,
      role: 'worker',
      subtaskId: subtask.id,
    },
  },
});
```

The worker should receive the subtask-specific objective as `goal`. The top-level objective should be included in context for alignment, not substituted for the worker goal.

### Capability and policy checks

Before launching a worker, the coordinator must verify that the selected target agent can accept the selected modalities. If the target model cannot consume a modality natively, the coordinator should follow the existing core file input policy behavior:

- pass provider-native content parts when supported;
- use `fileInputPolicy=read_file` where appropriate and ensure `read_file` is visible to the worker;
- materialize URL or file-id inputs through existing `materializeFileInput` behavior when required;
- fail the subtask with a clear validation error if the selected agent cannot consume or materialize a required attachment.

The coordinator should not silently drop attachments selected by the decomposer.

### Large or partially relevant files

The initial version may route whole attachments by id. A later refinement can add selectors for file ranges, pages, timestamps, or regions:

```ts
interface SwarmAttachmentRef {
  attachmentId: string;
  pages?: number[];
  lineStart?: number;
  lineEnd?: number;
  timeStartSeconds?: number;
  timeEndSeconds?: number;
  region?: JsonObject;
}
```

Do not require partial attachment selectors in the first implementation unless needed by a concrete tool or provider adapter. The first version should keep `attachmentRefs: string[]` and route complete selected attachments.

## Coordinator Flow

The coordinator owns decomposition. There is no separate decomposer run in the initial design.

1. Accept `SwarmRequest`.
2. Generate or reuse `sessionId`.
3. Build an attachment inventory from `SwarmRequest.contentParts`, if present.
4. Create a coordinator run with:
   - `sessionId`
   - `goal` or equivalent set to `topLevelObjective`
   - `metadata.orchestration.role = 'coordinator'`
5. Inside the coordinator flow, produce a structured list of `SwarmSubtask` records, including `attachmentRefs` when a subtask needs selected files or other modalities.
6. Validate each subtask's `attachmentRefs` against the attachment inventory.
7. Launch worker runs for subtasks using bounded concurrency, passing only the selected `contentParts` to each worker.
8. Collect `SwarmSubtaskResult` records, including failures.
9. Run the quality agent against the top-level objective, subtasks, attachment refs, and worker results.
10. Run the synthesizer agent against the top-level objective, worker results, attachment refs, and quality assessments.
11. Persist the final coordinator result and return `SwarmRunResult`.

The coordinator may use model instructions, schemas, or existing tools to perform decomposition, but the decomposition remains part of the coordinator's responsibility.

## Worker Run Semantics

Worker runs are independent root runs, not child runs of the coordinator.

Each worker run must include:

- same `sessionId` as the coordinator;
- `metadata.orchestration.kind = 'swarm'`;
- `metadata.orchestration.coordinatorRunId = coordinatorRunId`;
- `metadata.orchestration.role = 'worker'`;
- `metadata.orchestration.subtaskId = subtask.id`.

The worker run goal should be the `subObjective`, not the top-level objective. The top-level objective can be included in context for alignment.

```ts
const selectedContentParts = resolveAttachmentRefs(subtask.attachmentRefs, attachmentInventory);

await workerAgent.run({
  sessionId,
  goal: subtask.subObjective,
  input: subtask.input,
  contentParts: selectedContentParts,
  context: {
    topLevelObjective,
    subtaskId: subtask.id,
    attachmentRefs: subtask.attachmentRefs ?? [],
  },
  metadata: {
    ...subtask.metadata,
    orchestration: {
      kind: 'swarm',
      coordinatorRunId,
      role: 'worker',
      subtaskId: subtask.id,
    },
  },
});
```

## Quality and Synthesis Semantics

The quality run and synthesizer run are also independent root runs under the same `sessionId`.

Quality run metadata:

```ts
metadata: {
  orchestration: {
    kind: 'swarm',
    coordinatorRunId,
    role: 'quality'
  }
}
```

Synthesizer run metadata:

```ts
metadata: {
  orchestration: {
    kind: 'swarm',
    coordinatorRunId,
    role: 'synthesizer'
  }
}
```

The quality agent should produce structured assessments rather than free-form prose. The synthesizer should receive:

- top-level objective;
- subtask list;
- subtask attachment refs and attachment summaries, not necessarily full raw attachments;
- worker run ids, statuses, outputs, and errors;
- quality assessments;
- any caller input/context needed for the final response.

## Relationship to Existing Child Runs

Existing child-run delegation remains unchanged.

Use child runs when an agent invokes a delegate as a custom tool:

```text
parent run -> delegate.some_specialist(...) -> child run
```

Use swarm worker runs when the coordinator launches independent subtasks:

```text
coordinator run -> independent worker root runs grouped by sessionId + coordinatorRunId
```

This avoids a multi-child parent model and preserves current resumability assumptions around `currentChildRunId`.

## CLI/Gateway Direction

The existing Agent SDK CLI already uses `eval --swarm <n>` to mean "run eval cases with up to `n` concurrent eval runs." That existing flag is a concurrency control for evaluation workloads; it does not decompose one objective into subtasks and should not be treated as this feature.

A future CLI or gateway entrypoint for coordinated decomposition must avoid ambiguity with the existing eval flag. The exact command name is therefore intentionally TBD, but `swarm-run` is the preferred candidate because it preserves the meaningful swarm terminology without overloading `eval --swarm <n>`.

Possible shapes include:

```sh
adaptive-agent swarm-run "Analyze this complex objective and produce a final answer"
adaptive-agent run --orchestrate "Analyze this complex objective and produce a final answer"
adaptive-agent run --decompose "Analyze this complex objective and produce a final answer"
```

If implemented, `adaptive-agent run --decompose` must be an alias for the same `SwarmCoordinator` execution path as `adaptive-agent swarm-run`. `adaptive-agent run --orchestrate` is intentionally not the initial alias because it is broader than decomposition and may later cover other orchestration modes.

Avoid reusing `--swarm` for this feature because `eval --swarm <n>` already has a different meaning.

Expected behavior:

- create or accept a `sessionId`;
- create one coordinator run;
- run bounded worker tasks under the same `sessionId`;
- return all relevant run ids and the synthesizer output;
- preserve normal non-swarm `agent.run()` behavior.

Gateway interactive sessions should remain serialized for chat/write safety unless an explicit coordinated decomposition mode creates independent runs under the same core `sessionId`.

## Non-Goals

- No multi-child parent-run structure.
- No replacement of existing delegate child runs.
- No separate `swarmId` in the initial implementation.
- No duplicated `allowedTools` on `SwarmSubtask`.
- No raw attachment duplication across all subtasks by default.
- No required partial file/page/timestamp selectors in the first implementation.
- No gateway authorization/session ownership migration into core.
- No DAG scheduler in the initial version.
- No parallel child-run delegation changes.

## Implementation Phases

### Phase 0: Contract cleanup and naming lock

- Treat `swarm-run` as the canonical coordinated decomposition command name.
- If supported, make `run --decompose` an exact alias for the same coordinator flow.
- Do not introduce `run --orchestrate` in the initial CLI unless a broader orchestration mode is explicitly designed.
- Keep specialist routing on `SwarmSubtask.targetAgentId`; do not model specialist selection as nested orchestration.
- Keep nested swarm/coordinator execution out of the initial implementation.
- Preserve the no-`swarmId`, independent-worker-root-run, and no-multi-child-parent-run constraints.

### Phase 1: Core persisted `sessionId`

- Add `sessionId` to `RunRequest`, `ChatRequest`, `AgentRun`, and `RunStore.createRun()` input.
- Add `session_id` to PostgreSQL runtime migrations and row mapping.
- Add `sessionId` support to in-memory/file/test stores if present.
- Persist `request.sessionId` from `AdaptiveAgent.run()` and `AdaptiveAgent.chat()`.
- Propagate parent `sessionId` to delegate child runs.
- Preserve `sessionId` through retry/continuation paths.

### Phase 2: Session run query support

- Add `listBySession(sessionId)` to stores or a runtime query helper.
- Add PostgreSQL query and index coverage.
- Add tests for ordering and missing-session behavior.

### Phase 3: Swarm coordinator prototype

- Implement a `SwarmCoordinator` or equivalent orchestration helper.
- Keep decomposition inside the coordinator flow.
- Build a deterministic attachment inventory from `SwarmRequest.contentParts`.
- Require decomposer output to reference attachments through validated `attachmentRefs`.
- Launch independent worker root runs with bounded concurrency.
- Pass only selected `contentParts` to each worker run.
- Collect structured worker results.
- Invoke quality and synthesis runs.
- Return `SwarmRunResult`.

### Phase 4: CLI or gateway coordinated decomposition integration

- Add a command or frame option that invokes the coordinator.
- Avoid overloading or confusing the existing Agent SDK `eval --swarm <n>` concurrency flag.
- Surface `sessionId`, `coordinatorRunId`, worker run ids, quality run id, and synthesizer run id.
- Keep non-swarm gateway session write semantics unchanged.

## Verification Plan

### Unit tests

- `AdaptiveAgent.run()` persists `sessionId`.
- `AdaptiveAgent.chat()` persists `sessionId`.
- Delegate child runs inherit parent `sessionId`.
- Continuation/retry preserves `sessionId`.
- PostgreSQL row mapping reads/writes `session_id`.
- `listBySession()` returns all matching runs in deterministic order.

### Orchestration tests

- Coordinator creates one coordinator run with role `coordinator`.
- Worker runs are independent root runs with the same `sessionId` and coordinator metadata.
- Quality and synthesizer runs share the same `sessionId` and coordinator metadata.
- Failed worker runs are represented in `SwarmSubtaskResult` and do not prevent quality/synthesis unless policy says so.
- `targetAgentId` selects an agent whose own definition controls tools.
- Coordinator builds stable attachment ids for multimodal `contentParts`.
- Decomposer output with unknown `attachmentRefs` is rejected before worker launch.
- Worker runs receive only the attachments selected by their subtask.
- Worker launch fails clearly when the selected target agent cannot consume or materialize a required modality.

### Integration tests

- PostgreSQL migration is idempotent.
- A full swarm run can be queried by `sessionId` and grouped by `coordinatorRunId`.
- A full swarm run with mixed file/image/audio inputs preserves attachment routing in run context or metadata.
- Existing delegate child-run tests continue to pass without multi-child behavior.

## Open Implementation Decisions

1. Whether `listBySession()` should become required on `RunStore` immediately or remain optional for one release.
2. Whether the coordinator run should persist intermediate decomposition and final synthesis in `result`, events, or both.
3. Whether failed worker runs should be retried automatically based on quality-agent recommendations in the first version.
4. Whether `maxWorkers` default should live in `AdaptiveAgentOptions.defaults`, a coordinator option, or CLI/gateway config.
5. Whether quality and synthesis should be required phases or configurable profiles.
6. Whether attachment inventory summaries should be persisted in coordinator `metadata`, coordinator `result`, events, or all three.
7. When to promote `attachmentRefs: string[]` to structured refs with page, range, timestamp, or region selectors.
