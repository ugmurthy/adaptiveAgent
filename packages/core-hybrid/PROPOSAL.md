# Core Hybrid Proposal

## Purpose

Create `packages/core-hybrid` as the next-generation AdaptiveAgent core package. It should combine the durable, resumable, delegation-oriented design of local `@adaptive-agent/core` with the streaming-first, provider-neutral agent architecture from `badlogic/pi-mono/packages/agent` and its lower-level provider package.

The package should preserve the v1.4 boundary that `Tool` is the only first-class executable primitive. Delegation remains modeled as synthetic `delegate.*` tools that spawn normal child runs.

## Goals

- Streaming-first runtime: every model token, tool update, run state transition, and child-run boundary is observable as an async event stream.
- Provider-neutral model layer: host applications can use OpenAI-compatible APIs, Anthropic, Google, Mistral, Ollama, OpenRouter, Mesh, Bedrock, or custom providers without changing the agent loop.
- Delegate-as-tool support: delegate profiles become synthetic tools, child runs inherit bounded context, and parent runs resume from durable child results.
- Durable execution: keep run stores, event stores, snapshots, leases, optimistic versioning, idempotent tool execution, approvals, retries, and recovery semantics from `@adaptive-agent/core`.
- UI-friendly state: expose rich streaming messages, pending tool calls, child-run relationships, usage updates, and tool details without forcing UIs to parse model text.
- Bun + TypeScript package: keep the repo's existing runtime assumption and workspace conventions.

## Non-Goals

- Do not add DAG execution or general workflow scheduling.
- Do not introduce parallel child runs in the first version; keep one active child run per parent run.
- Do not persist chain-of-thought. Reasoning blocks may be streamed only when providers expose safe, non-sensitive summaries or opaque signatures.
- Do not replace the existing `packages/core` immediately. `core-hybrid` should be additive until the API proves stable.

## Source Strengths To Keep

### From Local `packages/core`

- Durable run model: `AgentRun`, `RunStore`, `EventStore`, `SnapshotStore`, `ToolExecutionStore`, leases, heartbeats, optimistic versioning, and recovery-oriented snapshots.
- Delegation semantics: `DelegateDefinition`, `DelegationPolicy`, `DelegationExecutor`, synthetic `delegate.<name>` tools, parent/child run linkage, root run IDs, delegation depth, and `awaiting_subagent` state.
- Operational controls: tool budgets, research policies, capture/redaction policies, approval gates, retry handling, timeout handling, and structured logging.
- Existing adapter baseline: Ollama, OpenRouter, Mistral, Mesh, and an OpenAI-compatible adapter with request gating and retry/cooldown behavior.
- Skill integration: loaded skills can become delegate profiles, and executable skill handlers can be injected as child-run tools.

### From `badlogic/pi-mono/packages/agent` And Provider Layer

- `EventStream<T, R>` primitive: a small push/pull bridge implementing `AsyncIterable<T>` with a final `result()` promise.
- Streaming event protocol: normalized model stream events for start, text deltas, reasoning deltas, tool-call argument deltas, terminal `done`, and terminal `error`.
- Provider registry: register, lazy-load, unregister, and resolve providers by API/provider key instead of hardcoding providers into the agent runtime.
- Rich message model: first-class text, image, thinking, tool-call, and tool-result content blocks rather than string-only messages.
- Agent-message extensibility: allow host apps to carry custom runtime messages and provide `transformContext` and `convertToLlm` boundaries before model calls.
- Agent tool details channel: separate LLM-facing tool result content from UI/log-facing structured `details`.
- Streaming tool updates: tools can push progress events while executing.
- Tool hooks: `beforeToolCall` and `afterToolCall` hooks for authorization, sandbox policy, result rewriting, and audit policy.
- Dynamic API keys: `getApiKey(provider)` before every model call for short-lived credentials and multi-user gateways.
- Stream proxy pattern: compact wire events can omit growing partial messages and reconstruct them client-side.

## Proposed Package Shape

```text
packages/core-hybrid/
|- package.json
|- tsconfig.json
|- README.md
|- PROPOSAL.md
`- src/
   |- index.ts
   |- types.ts
   |- streams/
   |  |- event-stream.ts
   |  `- assistant-message-stream.ts
   |- model/
   |  |- types.ts
   |  |- provider-registry.ts
   |  |- stream.ts
   |  `- providers/
   |     |- openai-compatible.ts
   |     |- ollama.ts
   |     |- openrouter.ts
   |     |- mistral.ts
   |     `- register-builtins.ts
   |- runtime/
   |  |- hybrid-agent.ts
   |  |- agent-loop.ts
   |  |- execution-state.ts
   |  |- run-events.ts
   |  `- recovery.ts
   |- tools/
   |  |- types.ts
   |  |- validation.ts
   |  |- executor.ts
   |  `- delegate-tools.ts
   |- stores/
   |  |- contracts.ts
   |  |- in-memory-run-store.ts
   |  |- in-memory-event-store.ts
   |  |- in-memory-snapshot-store.ts
   |  `- in-memory-tool-execution-store.ts
   |- delegation/
   |  |- delegation-executor.ts
   |  `- child-run-resume.ts
   |- skills/
   `- proxy/
      `- stream-proxy.ts
```

`src/index.ts` should re-export the public runtime, provider registry, stream types, store contracts, in-memory stores, built-in adapters, tools, delegation contracts, skills, and logging helpers.

## Core Architecture

```text
Host app
  |
  | createHybridAgent({ model, tools, delegates, runtime })
  v
HybridAgent class
  |- owns mutable state and subscriber barrier
  |- exposes run(), streamRun(), chat(), resume(), interrupt(), resolveApproval()
  |- persists through RunStore/EventStore/SnapshotStore/ToolExecutionStore
  v
agentLoop / runLoop
  |- transforms AgentMessage[]
  |- calls provider-neutral streamModel()
  |- executes tools and delegate tools
  |- emits HybridAgentEvent stream
  v
ModelProvider registry
  |- OpenAI-compatible providers
  |- Ollama/OpenRouter/Mistral/Mesh built-ins
  |- custom provider plugins
```

The low-level loop should be a pure async function with injected stores, tools, delegation executor, and model stream function. The `HybridAgent` class should wrap it with state management, queued steering/follow-up messages, subscriber barriers, and convenience methods.

## Public API Sketch

```ts
export interface CreateHybridAgentOptions {
  model: ModelDescriptor | ModelAdapter | ModelProviderConfig;
  tools: HybridTool[];
  delegates?: DelegateDefinition[];
  delegation?: DelegationPolicy;
  runtime?: HybridRuntimeOptions;
  defaults?: HybridAgentDefaults;
  systemInstructions?: string;
  transformContext?: TransformContext;
  convertToLlm?: ConvertToLlm;
  beforeToolCall?: BeforeToolCallHook;
  afterToolCall?: AfterToolCallHook;
  getApiKey?: (provider: string) => string | undefined | Promise<string | undefined>;
}

export interface HybridAgent {
  run(request: RunRequest): Promise<RunResult>;
  streamRun(request: RunRequest): AgentEventStream;
  chat(request: ChatRequest): Promise<ChatResult>;
  streamChat(request: ChatRequest): AgentEventStream;
  resume(runId: UUID, options?: ResumeOptions): Promise<RunResult>;
  streamResume(runId: UUID, options?: ResumeOptions): AgentEventStream;
  interrupt(runId: UUID): Promise<void>;
  resolveApproval(runId: UUID, approved: boolean): Promise<RunResult>;
  subscribe(listener: AgentEventListener): () => void;
}
```

Promise-returning methods should consume the stream internally and resolve from the terminal result. Stream-returning methods should return immediately with `EventStream<HybridAgentEvent, RunResult>`.

## Streaming Design

### Event Stream Primitive

Adopt the `EventStream<T, R>` pattern as a core utility:

```ts
export class EventStream<T, R = T> implements AsyncIterable<T> {
  push(event: T): void;
  end(result?: R): void;
  result(): Promise<R>;
  [Symbol.asyncIterator](): AsyncIterator<T>;
}
```

The model layer should never throw after a stream is returned. Provider errors, aborts, and parsing failures become terminal `error` events. Pre-stream configuration errors may still throw synchronously.

### Model Stream Events

Use a normalized assistant-message stream similar to `pi-mono`:

```ts
export type AssistantMessageEvent =
  | { type: 'start'; partial: AssistantMessage }
  | { type: 'text_start'; contentIndex: number; partial: AssistantMessage }
  | { type: 'text_delta'; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: 'text_end'; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: 'reasoning_start'; contentIndex: number; partial: AssistantMessage }
  | { type: 'reasoning_delta'; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: 'reasoning_end'; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: 'toolcall_start'; contentIndex: number; partial: AssistantMessage }
  | { type: 'toolcall_delta'; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: 'toolcall_end'; contentIndex: number; toolCall: ModelToolCall; partial: AssistantMessage }
  | { type: 'done'; reason: 'stop' | 'length' | 'toolUse'; message: AssistantMessage }
  | { type: 'error'; reason: 'aborted' | 'error'; error: AssistantMessage };
```

`ModelAdapter.generate()` can remain as a convenience wrapper over streaming, but the loop should call `stream()` when the provider supports it.

### Agent Stream Events

Keep the durable v1.4 event types, then add streaming-specific event names. Suggested additions:

```ts
export type HybridAgentEventType =
  | EventType
  | 'model.message_start'
  | 'model.message_delta'
  | 'model.message_end'
  | 'model.tool_call_delta'
  | 'tool.update'
  | 'child.event';
```

Rules:

- Persist state-changing events such as `run.created`, `step.started`, `tool.started`, `delegate.spawned`, `tool.completed`, `run.completed`, and `snapshot.created`.
- Emit high-volume token deltas as live events by default, with optional persistence controlled by capture policy.
- Include `partial` messages in in-process streams; allow proxy transports to strip `partial` and reconstruct it client-side.
- Include `rootRunId`, `parentRunId`, `delegateName`, `delegationDepth`, `stepId`, and `toolCallId` when known.

## Provider-Neutral Model Layer

### Model Descriptor

```ts
export interface ModelDescriptor<TApi extends string = string> {
  id: string;
  provider: string;
  api: TApi;
  model: string;
  baseUrl?: string;
  capabilities: ModelCapabilities;
  contextWindow?: number;
  maxOutputTokens?: number;
  cost?: ModelCost;
  compat?: Record<string, JsonValue>;
}
```

### Provider Contract

```ts
export interface ModelProvider<TOptions = unknown> {
  provider: string;
  api: string;
  stream(
    model: ModelDescriptor,
    request: ModelRequest,
    options?: TOptions,
  ): AssistantMessageEventStream;
}
```

### Registry Contract

```ts
export function registerModelProvider(provider: ModelProvider, sourceId?: string): void;
export function getModelProvider(api: string): ModelProvider;
export function unregisterModelProviders(sourceId: string): void;
export function clearModelProviders(): void;
```

This lets `core-hybrid` support any provider by registering an adapter rather than editing the runtime. Built-ins should include an OpenAI-compatible provider first because it covers OpenRouter, Mesh, many local gateways, and many hosted APIs. Anthropic/Google/Bedrock can be added behind the same registry without runtime changes.

## Message Model

Replace string-only `ModelMessage.content` with content blocks while keeping a compatibility converter for existing adapters:

```ts
export type MessageContent =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string | Uint8Array }
  | { type: 'reasoning'; text: string; signature?: string; redacted?: boolean }
  | { type: 'tool_call'; id: string; name: string; input: JsonValue }
  | { type: 'tool_result'; toolCallId: string; toolName: string; content: MessageContent[]; isError?: boolean };

export interface AssistantMessage {
  role: 'assistant';
  content: MessageContent[];
  provider: string;
  model: string;
  usage?: UsageSummary;
  finishReason?: ModelFinishReason;
  timestamp: number;
}
```

Add `CustomAgentMessages` declaration merging so host apps can keep UI artifacts, summaries, notifications, or domain-specific records in agent memory without sending them directly to the LLM:

```ts
export interface CustomAgentMessages {}
export type AgentMessage = ModelMessage | CustomAgentMessages[keyof CustomAgentMessages];
```

The loop should call:

1. `transformContext(messages, runContext)` for pruning, compaction, and memory injection.
2. `convertToLlm(messages, model)` for final provider-compatible message conversion.

## Tool Model

Merge local tool durability with `pi-mono` tool ergonomics:

```ts
export interface HybridTool<I extends JsonValue = JsonValue, O extends JsonValue = JsonValue, D = JsonValue> {
  name: string;
  label?: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  timeoutMs?: number;
  requiresApproval?: boolean;
  capture?: CaptureMode;
  redact?: ToolRedactionPolicy;
  retryPolicy?: ToolRetryPolicy;
  budgetGroup?: string;
  executionMode?: 'sequential' | 'parallel';
  prepareArguments?: (args: unknown) => I;
  summarizeResult?: (output: O) => JsonValue;
  recoverError?: (error: unknown, input: I) => O | undefined;
  execute(input: I, context: HybridToolContext<D>): Promise<HybridToolResult<O, D>>;
}

export interface HybridToolContext<D = JsonValue> extends ToolContext {
  update(details: D): Promise<void>;
}

export interface HybridToolResult<O extends JsonValue = JsonValue, D = JsonValue> {
  output: O;
  content?: MessageContent[];
  details?: D;
  terminate?: boolean;
}
```

In v1, default tool execution should stay sequential for resumability and easier persistence. Parallel tool execution can be enabled only for tools that are idempotent and do not spawn child runs. Any batch containing a `delegate.*` tool should execute sequentially.

## Delegate-As-Tool Design

Reuse the local delegation model with a streaming surface:

- `DelegateDefinition` remains the stable profile: `name`, `description`, `instructions`, `allowedTools`, optional `model`, optional `defaults`, optional `handlerTools`.
- `DelegationExecutor.createDelegateTools()` produces synthetic tools named `delegate.<name>`.
- A delegate tool input remains `{ goal, input, context, outputSchema, metadata }`.
- The parent emits and persists `delegate.spawned` with child run linkage.
- The child run is a normal run with `rootRunId`, `parentRunId`, `parentStepId`, `delegateName`, and `delegationDepth`.
- The parent moves to `awaiting_subagent` while the child is active.
- When the child completes, the parent receives the child output as the synthetic tool result and resumes.
- Live streams can include `child.event` mirrors so UIs can render a tree without separately subscribing to every child run.

The first version should keep bounded, serial delegation:

```ts
export interface DelegationPolicy {
  maxDepth?: number;
  maxChildrenPerRun?: number;
  allowRecursiveDelegation?: boolean;
  childRunsMayRequestApproval?: boolean;
  childRunsMayRequestClarification?: boolean;
  maxDelegateRetries?: number;
  retryableChildErrorCodes?: string[];
}
```

## Runtime And Persistence

The runtime should keep the existing store contracts and add stream-aware convenience methods.

### Required Stores

- `RunStore`: durable run lifecycle, hierarchy fields, leases, version checks.
- `EventStore`: append-only events plus optional live subscription.
- `SnapshotStore`: resumable execution state snapshots.
- `ToolExecutionStore`: idempotent tool-call records, child-run linkage, retry-safe completion.

### Execution State

Execution snapshots should include:

- `messages: AgentMessage[]`
- `stepsUsed: number`
- `pendingToolCalls: PendingToolCallState[]`
- `approvedToolCallIds: string[]`
- `waitingOnChildRunId?: UUID`
- `toolBudgetUsage`
- `pendingRuntimeMessages`
- `streamCursor?: { eventSeq: number; modelContentIndex?: number }`

`streamCursor` is optional and should be used only to support replay/resume of live transports. Durable correctness should still come from run state, tool execution records, and snapshots.

## API Compatibility Strategy

`core-hybrid` should not be source-compatible with every `packages/core` type on day one, but it should provide migration adapters:

- `fromCoreTool(tool: ToolDefinition): HybridTool`
- `toCoreTool(tool: HybridTool): ToolDefinition` when no streaming details are used
- `fromCoreModelAdapter(adapter: ModelAdapter): ModelProvider` by wrapping `generate()` as a synthetic non-streaming stream
- `fromCoreStores(runtime: RuntimeStores): HybridRuntimeOptions`

This lets existing examples and tests migrate incrementally while the new stream protocol is developed.

## Implementation Plan

1. Scaffold `packages/core-hybrid` with `package.json`, `tsconfig.json`, `src/index.ts`, and type-only exports.
2. Implement `EventStream<T, R>` and `AssistantMessageEventStream` with unit tests.
3. Define content-block messages, `AgentMessage`, `HybridTool`, `ModelProvider`, provider registry, and stream event contracts.
4. Port in-memory stores from `packages/core`, preserving run hierarchy, events, snapshots, leases, and tool execution records.
5. Add an OpenAI-compatible streaming provider and wrap existing local adapters as non-streaming providers.
6. Implement `agentLoop` against streams, initially supporting model text deltas, complete tool calls, sequential tool execution, and terminal run results.
7. Port `DelegationExecutor` and expose `delegate.*` tools with streamed `delegate.spawned` and optional `child.event` mirroring.
8. Add `HybridAgent` class with `run`, `streamRun`, `chat`, `streamChat`, `resume`, `streamResume`, `interrupt`, `resolveApproval`, and `subscribe`.
9. Add migration adapters for existing `packages/core` tools, model adapters, and runtime stores.
10. Add focused Vitest coverage for stream termination, provider registry, tool updates, delegate child-run linkage, interrupt/resume, and non-streaming adapter compatibility.

## Initial Test Matrix

- Event stream delivers pushed events to early and late consumers and resolves `result()` exactly once.
- Provider stream normalizes text deltas, tool-call deltas, usage, terminal `done`, and terminal `error`.
- Non-streaming model adapter wrapper emits `start`, one or more synthesized deltas, and `done`.
- `streamRun()` emits `run.created`, `model.message_*`, `tool.started`, `tool.update`, `tool.completed`, `run.completed` in order for a simple tool flow.
- A `delegate.researcher` tool creates a child run, persists `delegate.spawned`, moves parent to `awaiting_subagent`, and resumes parent from child output.
- Interrupting a parent interrupts the active child run.
- Resume from snapshot does not re-run a completed idempotent tool call.
- Capture policy can keep token deltas live-only while persisting durable lifecycle events.

## Open Questions

- Should token deltas ever be persisted by default, or only when capture mode is `full`?
- Should `HybridAgent.chat()` keep the current one-shot chat shape, or should chat become a durable conversation object with incremental user messages?
- Should provider packages live inside `core-hybrid` initially, or should they split later into `@adaptive-agent/provider-*` packages?
- Should TypeBox become the preferred schema library for new tools, or should `JsonSchema` remain dependency-free with optional validator plugins?
- Should `child.event` be a live-only stream event, a persisted mirror event, or configurable per event type?

## Recommended First Milestone

Build a thin but working vertical slice:

- `createHybridAgent()` with OpenAI-compatible streaming.
- One built-in `read_file` tool adapted from `packages/core`.
- One delegate profile exposed as `delegate.researcher`.
- `streamRun()` demonstrating model text deltas, tool progress, delegate child-run events, and final durable run result.

This proves the three requested capabilities together: streaming, any-provider extensibility, and delegate-as-tool agents.
