# Orchestration SDK Sketch

This document describes the currently implemented SDK-side orchestration design in `packages/agent-sdk`.

The implementation supports:

- capability-based modality routing
- SDK-level orchestration plans with dependency nodes
- single-run execution when the requested agent supports the input
- sequential specialist-then-synthesis execution for one unsupported modality
- parallel specialist fanout followed by requested-agent synthesis for multiple unsupported modalities
- a stable `sessionId` for every orchestration request
- explicit SDK-side session/run links without changing `@adaptive-agent/core`
- optional TUI entry through `adaptive-agent-tui --orchestrate`

## Goals

- Keep `@adaptive-agent/core` unchanged.
- Keep existing `AgentSdk` behavior unchanged.
- Implement orchestration in `packages/agent-sdk` as an additive API.
- Treat every orchestration-launched runtime execution as a root run from core's perspective.
- Link root runs using SDK-side session records, run-link records, metadata, and context.
- Allow independent root runs to execute concurrently when their orchestration nodes have no dependencies.

## Non-Goals

- No changes to `AdaptiveAgent`, `RunStore`, `ModelAdapter`, or core delegate semantics.
- No reinterpretation of orchestration sessions as core parent/child run trees.
- No parallel core child runs under a single parent run.
- No new core Postgres tables in this pass.
- No orchestration support for `chat`; the TUI currently routes only `/run` through orchestration.

## Core Boundary

The most important boundary is:

> SDK orchestration sessions are not core delegation trees.

Core delegation is model/tool-selected through synthetic `delegate.*` tools. SDK orchestration is host-selected routing across root runs.

| Concern | Core delegation | SDK orchestration |
| --- | --- | --- |
| Trigger | model calls `delegate.*` | SDK routing plan |
| Relationship | parent/child runs | session-linked root runs |
| Parallel child execution | not supported | supported as independent root runs |
| Join logic | one synthetic tool result | SDK final synthesis node |
| Persistence | core run fields/events | SDK stores plus run metadata/context |

This means the current implementation can run multiple independent root runs while an orchestration session is in progress, but it does not allow one core parent run to wait on multiple active child runs.

## Public API Surface

The existing `AgentSdk` API remains unchanged.

`packages/agent-sdk/src/index.ts` exports:

```ts
export async function createOrchestrationSdk(
  options: OrchestrationSdkOptions = {},
): Promise<OrchestrationSdk>;

export class OrchestrationSdk {
  static async create(options: OrchestrationSdkOptions = {}): Promise<OrchestrationSdk>;

  async run(goal: string, options?: OrchestratedRunOptions): Promise<OrchestratedRunResult>;
  async runRaw(goal: string, options?: OrchestratedRunOptions): Promise<OrchestratedRunResult>;

  async inspectSession(sessionId: string): Promise<OrchestrationSessionInspection>;
  async close(): Promise<void>;
}
```

`run()` and `runRaw()` currently behave the same at orchestration level. Individual stage execution uses `AgentSdk.runRaw()`.

## Agent Config Capability Extension

`AgentConfigFile` now includes typed modality capabilities:

```ts
export type SupportedModality = 'text' | 'image' | 'file' | 'audio';

export interface AgentCapabilityConfig {
  modalitiesSupported?: SupportedModality[];
  modalitiesPreferred?: SupportedModality[];
  modalityRoles?: Partial<
    Record<SupportedModality, 'ingest' | 'analyze' | 'summarize' | 'synthesize'>
  >;
  subjectsPreferred?: string[];
}

export interface AgentConfigFile {
  // existing fields omitted
  capabilities?: AgentCapabilityConfig;
}
```

The AJV agent config validator accepts and validates `capabilities` while still allowing additional properties.

Example specialist config fragment:

```json
{
  "capabilities": {
    "modalitiesSupported": ["text", "audio"],
    "modalitiesPreferred": ["audio"],
    "subjectsPreferred": ["clinical notes", "medical transcription"],
    "modalityRoles": {
      "audio": "analyze"
    }
  },
  "routing": {
    "keywords": ["symptom", "diagnosis", "medication"]
  }
}
```

Default capability rule:

- if `capabilities.modalitiesSupported` is absent or empty, the agent is treated as supporting only `text`
- `capabilities.subjectsPreferred` and `routing.keywords` are optional deterministic subject-routing hints for text-only specialist selection

## Implemented Orchestration Types

The implementation lives in `packages/agent-sdk/src/orchestration.ts`.

```ts
export type OrchestrationSessionStatus =
  | 'routing'
  | 'running'
  | 'succeeded'
  | 'failed';

export type OrchestrationStageKind =
  | 'single'
  | 'modality_specialist'
  | 'parallel_specialist'
  | 'subject_specialist'
  | 'final_synthesis';

export type OrchestrationExecutionShape =
  | 'single'
  | 'sequential'
  | 'parallel_fanout_then_synthesis';

export type OrchestrationPlanNodeStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped';
```

## Input Claims

Routing uses input claims rather than only a flat modality set.

```ts
export interface InputClaim {
  id: string;
  modality: SupportedModality;
  source: 'goal' | 'images' | 'contentParts' | 'input';
  index?: number;
  mimeType?: string;
  name?: string;
}
```

Implemented claim detection rules:

- the goal always creates a `text` claim named `goal`
- `options.images[]` creates `image` claims
- `options.contentParts[]` creates `text`, `image`, `file`, or `audio` claims based on part type
- object-shaped `options.input` with keys named `image`, `file`, or `audio` creates corresponding claims

The resulting detected modalities are the unique modalities across all claims.

## Orchestration Plan

Routing produces an orchestration plan instead of a single initial-agent decision.

```ts
export interface OrchestrationInputSelector {
  claimIds?: string[];
  includeGoal?: boolean;
  includeOriginalInput?: boolean;
  includePriorOutputs?: string[];
}

export interface OrchestrationPlanNode {
  id: string;
  agentId: string;
  stage: OrchestrationStageKind;
  dependsOn: string[];
  inputSelector?: OrchestrationInputSelector;
  outputRole?: string;
  metadata?: JsonObject;
}

export interface OrchestrationPlan {
  sessionId: string;
  requestedAgentId: string;
  detectedModalities: SupportedModality[];
  detectedSubjects: string[];
  inputClaims: InputClaim[];
  executionShape: OrchestrationExecutionShape;
  nodes: OrchestrationPlanNode[];
  finalNodeId: string;
  routingReason: string;
}
```

Implemented plan shapes:

### 1. Single

When the requested agent supports all detected modalities:

```text
requested
```

The single node has:

- `id = 'requested'`
- `stage = 'single'`
- `agentId = requestedAgentId`
- `dependsOn = []`

### 2. Sequential

When the requested agent lacks one non-text modality and `finalizeWithRequestedAgent` is true:

```text
<modality>_specialist -> final_synthesis
```

Example:

```text
audio_specialist -> final_synthesis
```

### 3. Parallel Fanout Then Synthesis

When the requested agent lacks multiple non-text modalities and `finalizeWithRequestedAgent` is true:

```text
image_specialist -+
                  +-> final_synthesis
audio_specialist -+
```

Specialist nodes have no dependencies, so the executor may run them concurrently up to `maxConcurrentRunsPerSession`.

## Routing Algorithm

`buildOrchestrationPlan()` implements deterministic routing.

Inputs:

- `sessionId`
- `requestedAgentId`
- original `goal`
- original `AgentSdkRunOptions`
- agent catalog
- `finalizeWithRequestedAgent`

Algorithm:

1. Resolve the requested agent from the catalog.
2. Build input claims.
3. Compute unique detected modalities from claims.
4. Read requested-agent supported modalities, defaulting to `['text']`.
5. Compute unsupported modalities:
   - ignore `text`
   - include every detected non-text modality not supported by the requested agent
6. If unsupported is empty, return the single-node plan.
7. For every unsupported modality, select a specialist that supports that modality.
8. Specialist selection tie-breaks by:
   - `modalitiesPreferred` includes the modality
   - `modalityRoles[modality] === 'analyze'`
   - `agentId` contains the modality name
   - smaller supported-modality set
   - lexical `agentId`
9. Independently score subject/domain matches against the goal:
   - each matching `capabilities.subjectsPreferred` phrase scores higher than a keyword
   - each matching `routing.keywords` phrase contributes a smaller score
   - a subject specialist is selected only when its score is greater than the requested agent's score
10. If no modality or subject specialist is selected, return the single-node plan.
11. If no specialist exists for a required modality, throw before any run starts.
12. If `finalizeWithRequestedAgent` is true, append a `final_synthesis` node using the originally requested agent.
13. If `finalizeWithRequestedAgent` is false, return only specialist node(s). The first specialist is currently used as the final node.

Text-only domain routing example:

```json
{
  "id": "legal-analyst",
  "name": "Legal Analyst",
  "invocationModes": ["run"],
  "defaultInvocationMode": "run",
  "model": { "provider": "openrouter", "model": "..." },
  "tools": ["read_file", "web_search"],
  "systemInstructions": "Analyze legal questions and summarize risks clearly.",
  "capabilities": {
    "modalitiesSupported": ["text"],
    "subjectsPreferred": ["contract law", "employment law"]
  },
  "routing": {
    "keywords": ["indemnity", "warranty", "liability", "termination clause"]
  }
}
```

With this config in the catalog, a text goal containing `contract law` or matching keywords can route to `legal-analyst` first, then synthesize with the requested default agent.

Default:

- `finalizeWithRequestedAgent = true`

## Session And Link Stores

Default stores are in-memory.

```ts
export interface OrchestrationSessionRecord {
  id: string;
  requestedAgentId: string;
  status: OrchestrationSessionStatus;
  executionShape: OrchestrationExecutionShape;
  detectedModalities: SupportedModality[];
  routingReason: string;
  metadata?: JsonObject;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface OrchestrationSessionRunLinkRecord {
  sessionId: string;
  nodeId: string;
  runId: string;
  rootRunId: string;
  stage: OrchestrationStageKind;
  agentId: string;
  requestedAgentId: string;
  status: OrchestrationPlanNodeStatus;
  dependsOn: string[];
  upstreamRunIds?: string[];
  metadata?: JsonObject;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}
```

Store interfaces:

```ts
export interface OrchestrationSessionStore {
  create(session: OrchestrationSessionRecord): Promise<OrchestrationSessionRecord>;
  get(sessionId: string): Promise<OrchestrationSessionRecord | undefined>;
  update(session: OrchestrationSessionRecord): Promise<OrchestrationSessionRecord>;
}

export interface OrchestrationSessionRunLinkStore {
  append(link: OrchestrationSessionRunLinkRecord): Promise<OrchestrationSessionRunLinkRecord>;
  update(link: OrchestrationSessionRunLinkRecord): Promise<OrchestrationSessionRunLinkRecord>;
  listBySession(sessionId: string): Promise<OrchestrationSessionRunLinkRecord[]>;
  getByRunId(runId: string): Promise<OrchestrationSessionRunLinkRecord | undefined>;
}
```

Important distinction:

- SDK stores are convenience indices for orchestration sessions
- core run stores remain the source of runtime execution history
- every stage run remains a normal root run from core's perspective

## Catalog And Options

```ts
export interface AgentCatalogEntry {
  agentId: string;
  configPath?: string;
  agentConfig: AgentConfigFile;
}

export interface OrchestrationConcurrencyPolicy {
  maxConcurrentRunsPerSession?: number;
  failurePolicy?: 'fail_fast' | 'wait_for_all';
}

export interface OrchestrationSdkOptions extends AgentSdkOptions {
  requestedAgentConfig?: AgentConfigFile;
  requestedAgentConfigPath?: string;
  agentCatalog?: AgentCatalogEntry[];
  agentCatalogPaths?: string[];
  sessionStore?: OrchestrationSessionStore;
  sessionRunLinkStore?: OrchestrationSessionRunLinkStore;
  sessionIdFactory?: () => string;
  now?: () => Date;
  concurrency?: OrchestrationConcurrencyPolicy;
  agentRunnerFactory?: (
    agentId: string,
    agentConfig: AgentConfigFile,
    options: AgentSdkOptions,
  ) => Promise<OrchestrationAgentRunner>;
}
```

Implemented catalog sources:

- inline `agentCatalog`
- JSON config files from `agentCatalogPaths`
- `requestedAgentConfig` or `agentConfig`

`agentCatalogDir` is not implemented in the current pass.

Default concurrency:

```ts
{
  maxConcurrentRunsPerSession: 2,
  failurePolicy: 'fail_fast'
}
```

## Execution Algorithm

`OrchestrationSdk.runRaw()` executes the plan as a small dependency graph.

1. Create or accept `sessionId`.
2. Resolve requested agent ID.
3. Build the orchestration plan.
4. Store the plan in memory for `inspectSession()`.
5. Create an `OrchestrationSessionRecord` with status `routing`.
6. Update the session to `running`.
7. Maintain:
   - `pending`: node IDs not yet executed
   - `results`: node ID to `OrchestratedRunStageResult`
8. Repeatedly select ready nodes whose dependencies are all present in `results`.
9. Run a batch of ready nodes with `Promise.all()`, bounded by `maxConcurrentRunsPerSession`.
10. For every completed node:
    - resolve `rootRunId` from `runner.inspect(runId)` or fall back to `runId`
    - append an `OrchestrationSessionRunLinkRecord`
    - store the stage result
11. If a node returns failure and `failurePolicy = 'fail_fast'`, stop pending execution and use that failure as the final result.
12. Otherwise continue until all nodes complete.
13. Use the `finalNodeId` result as the final result.
14. Mark the session `succeeded` or `failed` based on final result status.
15. Return `OrchestratedRunResult`.

## Stage Run Options

Every stage receives orchestration metadata and context:

```ts
orchestration = {
  sessionId,
  requestedAgentId,
  selectedAgentId: node.agentId,
  executionShape,
  stage: node.stage,
  nodeId: node.id,
  dependsOn: node.dependsOn,
  detectedModalities,
  routingReason,
}
```

For specialist and single nodes, the original run options are forwarded with enriched `metadata` and `context`.

For `final_synthesis`, raw attachments are not forwarded by default. The final node receives structured upstream results:

```ts
input = {
  originalInput: options.input ?? null,
  upstreamResults: {
    [nodeId]: outputOrFailureSummary,
  },
}
```

The final synthesis goal is:

```text
Complete the original user request using the specialist result(s) already produced.
Do not assume access to raw attachments unless they are included explicitly.

Original user request: <goal>
```

## Result Shape

```ts
export interface OrchestratedRunStageResult {
  nodeId: string;
  stage: OrchestrationStageKind;
  agentId: string;
  runId: string;
  rootRunId: string;
  result: RunResult;
}

export interface OrchestratedRunResult {
  sessionId: string;
  requestedAgentId: string;
  detectedModalities: SupportedModality[];
  detectedSubjects: string[];
  executionShape: OrchestrationExecutionShape;
  plan: OrchestrationPlan;
  stages: OrchestratedRunStageResult[];
  finalResult: RunResult;
}
```

## TUI Integration

`adaptive-agent-tui` can route `/run` through orchestration when started with `--orchestrate`.

CLI flags:

```text
--orchestrate             Route /run through the orchestration SDK
--catalog <path>          Agent config path to add to orchestration catalog; repeatable
```

Example:

```bash
bun run packages/agent-sdk/src/adaptive-agent-tui.ts \
  --agent ./path/to/general-agent.json \
  --orchestrate \
  --catalog ./path/to/audio-agent.json \
  --catalog ./path/to/image-agent.json
```

TUI commands for modality testing:

```text
/run <goal>
/run-image <path> <goal>
/run-audio <path> <goal>
/run-file <path> <goal>
/inspect-session <sessionId>
```

Notes:

- `--orchestrate` affects `/run` and the run attachment commands.
- `/chat`, `/retry`, `/interrupt`, `/steer`, `/inspect <runId>`, `/tools`, and `/delegates` still use the normal `AgentSdk` path.
- The TUI creates a normal `AgentSdk` first and passes its runtime into `createOrchestrationSdk()` so stage runs are visible in the same runtime store.
- After an orchestrated run, the TUI prints the `sessionId`, execution shape, and stage run IDs.

## File Layout

Implemented files:

- `packages/agent-sdk/src/index.ts`
  - exports modality capability types
  - extends `AgentConfigFile`
  - validates `capabilities`
  - exports orchestration API and types
- `packages/agent-sdk/src/orchestration.ts`
  - `OrchestrationSdk`
  - plan types and routing logic
  - input claim detection
  - in-memory session and link stores
  - dependency-based executor
- `packages/agent-sdk/src/orchestration.test.ts`
  - focused orchestration tests
- `packages/agent-sdk/src/adaptive-agent-tui.ts`
  - `--orchestrate`
  - `--catalog`
  - attachment run commands
  - `/inspect-session`

## Implemented Tests

Current focused tests cover:

1. Requested agent supports all detected modalities:
   - one `single` plan node
   - execution shape `single`
2. Requested text-only agent receives image plus audio input:
   - `image_specialist`
   - `audio_specialist`
   - `final_synthesis`
   - execution shape `parallel_fanout_then_synthesis`
3. Orchestration execution with injected fake runners:
   - independent specialist root runs execute before final synthesis
   - session links record upstream run IDs
   - final synthesis receives structured upstream outputs

Verification commands used:

```bash
bunx vitest run packages/agent-sdk/src/orchestration.test.ts packages/agent-sdk/src/index.test.ts
bun run --cwd packages/agent-sdk build
```

## Known Gaps And Follow-Ups

- `agentCatalogDir` is not implemented.
- Session/link stores are in-memory by default; no Postgres-backed orchestration store exists yet.
- `chat` orchestration is not implemented.
- The TUI attachment commands are intentionally minimal and accept only path plus goal.
- `finalizeWithRequestedAgent = false` with multiple specialists currently returns the first specialist as the final node, even though all specialist nodes may run.
- There is no persisted orchestration plan store yet; plans are held in memory for `inspectSession()`.
- Failure policy supports `fail_fast` and `wait_for_all`, but there is no richer join policy yet.

## Key Design Decisions

- `sessionId` identifies one orchestration request, not proof that multiple runs occurred.
- Orchestration is SDK-side and additive.
- Root runs remain root runs.
- Session linkage uses SDK stores plus run metadata/context.
- Routing produces a plan/DAG, not only a selected initial agent.
- Parallelism is achieved by running independent root runs concurrently, not by changing core child-run semantics.
- The requested agent remains the default final synthesis agent when modality specialists are used.

## Implementation Constraints

- Do not change `@adaptive-agent/core` contracts for this orchestration layer.
- Do not reuse core parent/child delegation fields for orchestration sessions.
- Keep the current `AgentSdk` API behavior stable.
- Keep orchestration additive and opt-in.
