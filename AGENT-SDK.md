# `@adaptive-agent/agent-sdk` Specification

## Purpose

Create `@adaptive-agent/agent-sdk` as the developer-friendly host SDK for `@adaptive-agent/core`.

The SDK should wrap the low-level `AdaptiveAgent` API from [packages/core/src/adaptive-agent.ts](/Users/ugmurthy/riding-amp/AgentSmith/packages/core/src/adaptive-agent.ts) and provide the practical functionality currently assembled by the local CLI in [packages/core-cli/src/cli.ts](/Users/ugmurthy/riding-amp/AgentSmith/packages/core-cli/src/cli.ts):

- config loading
- environment-aware model resolution
- runtime store bootstrapping
- local tool and delegate resolution
- logging setup
- event subscription
- interaction handling for approval and clarification
- ergonomic chat and run helpers
- inspection and recovery helpers

The main product goal is ease of use for an average developer without weakening the existing core architecture boundaries:

- `Tool` remains the only first-class executable primitive.
- plans remain separate artifacts.
- delegation remains modeled as synthetic `delegate.*` tools plus child runs.
- the SDK is a host layer on top of `@adaptive-agent/core`, not a second runtime kernel.

## Naming

Package name:

- `@adaptive-agent/agent-sdk`

Config files:

- `agent.json`: portable agent definition
- `agent.settings.json`: local SDK/runtime settings

The two-file split is intentional:

- `agent.json` answers: "What is this agent?"
- `agent.settings.json` answers: "How should this machine or app run it?"

## Relationship To Existing Packages

The SDK should sit conceptually between `@adaptive-agent/core` and application code.

Existing package boundaries should remain:

- `@adaptive-agent/core`: runtime primitives, stores, adapters, tools, skills
- `@adaptive-agent/agent-sdk`: configuration, bootstrap, ergonomics, host-level defaults

The SDK may initially reuse logic or code patterns from:

- [packages/core-cli/src/config.ts](/Users/ugmurthy/riding-amp/AgentSmith/packages/core-cli/src/config.ts)
- [packages/core-cli/src/agent-loader.ts](/Users/ugmurthy/riding-amp/AgentSmith/packages/core-cli/src/agent-loader.ts)
- [packages/core-cli/src/local-modules.ts](/Users/ugmurthy/riding-amp/AgentSmith/packages/core-cli/src/local-modules.ts)
- [packages/core-cli/src/interactive.ts](/Users/ugmurthy/riding-amp/AgentSmith/packages/core-cli/src/interactive.ts)
- [packages/core/src/logger.ts](/Users/ugmurthy/riding-amp/AgentSmith/packages/core/src/logger.ts)

but should expose a stable SDK-oriented API rather than CLI-oriented functions.

## Design Goals

- Make setup easy for a developer who wants to get a working agent with minimal ceremony.
- Preserve an escape hatch to the raw `AdaptiveAgent` and runtime stores.
- Prefer portable configuration in `agent.json`.
- Prefer machine-local convenience in `agent.settings.json`.
- Default to durable runtime behavior.
- Default to safe logging behavior.
- Support environment-variable-driven model configuration cleanly.
- Produce clear validation errors for config mistakes.
- Keep runtime behavior aligned with core contracts and existing tool semantics.

## Non-Goals

- Do not create a new planning runtime.
- Do not add DAG execution.
- Do not add parallel child runs.
- Do not add child messaging.
- Do not add token streaming as a primary SDK abstraction in the first cut.
- Do not turn the SDK into a gateway replacement.
- Do not require users to understand `RunStore`, `PlanStore`, `ContinuationStore`, or `ToolDefinition` for common usage.

## Default Behavior

Unless explicitly overridden, the SDK should use these defaults:

- `runtime.mode = "postgres"`
- `logging.enabled = false`
- `interaction.approvalMode = "auto"`
- `interaction.clarificationMode = "interactive"`
- `events.subscribe = false`
- `skills.dirs = ["./skills", "~/.adaptiveAgent/skills"]`
- `workspace.root = process.cwd()` if absent

Notes:

- `runtime.mode = "postgres"` means the SDK should prefer durable runtime stores by default. If postgres is selected only by default and `process.env.DATABASE_URL` is absent, the SDK should fall back to `memory`; explicit postgres configuration should fail clearly when `process.env.DATABASE_URL` is absent.
- `approvalMode = "auto"` means approval-gated tool calls should be auto-approved by default in SDK-hosted flows unless a caller overrides behavior.
- `clarificationMode = "interactive"` means the SDK should provide a handler-based clarification loop rather than failing immediately when clarification is requested.
- `logging.enabled = false` means no structured runtime logger is injected unless enabled.

## Configuration Files

### Overview

The SDK should support loading:

- one `agent.json`
- zero or one `agent.settings.json`

Both files should be optional at the API level, but at least one source of agent definition must exist by the time resolution completes.

### `agent.json`

`agent.json` is the portable agent definition.

Proposed TypeScript interface:

```ts
export interface AgentConfigFile {
  $schema?: string;
  version?: 1;

  id: string;
  name: string;
  description?: string;

  invocationModes: Array<'run' | 'chat'>;
  defaultInvocationMode: 'run' | 'chat';

  workspace?: {
    root?: string;
    shellCwd?: string;
  };

  model: {
    provider?: string;
    model?: string;
    apiKeyEnv?: string;
    apiKey?: string;
    baseUrl?: string;
    maxConcurrentRequests?: number;
  };

  systemInstructions?: string;

  tools: string[];
  delegates?: string[];

  defaults?: {
    maxSteps?: number;
    toolTimeoutMs?: number;
    modelTimeoutMs?: number;
    maxRetriesPerStep?: number;
    requireApprovalForWriteTools?: boolean;
    autoApproveAll?: boolean;
    capture?: 'full' | 'summary' | 'none';
    injectToolManifest?: boolean;
    researchPolicy?:
      | 'none'
      | 'light'
      | 'standard'
      | 'deep'
      | {
          mode: 'none' | 'light' | 'standard' | 'deep';
          maxSearches?: number;
          maxPagesRead?: number;
          checkpointAfter?: number;
          requirePurpose?: boolean;
        };
    toolBudgets?: Record<string, {
      maxCalls?: number;
      maxConsecutiveCalls?: number;
      checkpointAfter?: number;
      onExhausted?: 'fail' | 'continue_with_warning' | 'ask_model';
    }>;
  };

  delegation?: {
    maxDepth?: number;
    maxChildrenPerRun?: number;
    allowRecursiveDelegation?: boolean;
    childRunsMayRequestApproval?: boolean;
    childRunsMayRequestClarification?: boolean;
  };

  recovery?: {
    continuation?: {
      enabled?: boolean;
      defaultStrategy?:
        | 'hybrid_snapshot_then_step'
        | 'latest_snapshot'
        | 'last_successful_step'
        | 'failure_boundary'
        | 'manual_checkpoint';
      requireUserApproval?: boolean;
    };
    retryableErrorCodes?: string[];
    fallbackModels?: Array<{
      provider: string;
      model: string;
      whenFailureClass?: string[];
      whenErrorCode?: string[];
    }>;
  };

  metadata?: Record<string, unknown>;
  routing?: Record<string, unknown>;
}
```

Rules:

- `id`, `name`, `invocationModes`, `defaultInvocationMode`, `model`, and `tools` are required.
- `model.provider` and `model.model` should normally be present in `agent.json`; if either is absent, the SDK may use the corresponding fallback from `agent.settings.json` or explicit SDK constructor options. Resolution must fail with a clear validation/configuration error if either value is still missing after fallback resolution.
- `workspace.root` is optional. If absent, it will default to `process.cwd()` during resolution.
- `workspace.shellCwd` is optional. If absent, it will default to resolved `workspace.root`.
- `delegation` and `recovery` should be supported by the SDK even though the current local CLI config parser does not yet accept them.
- `routing` is allowed for portability but may be ignored by purely local SDK operation.

### `agent.settings.json`

`agent.settings.json` is the local runtime and convenience file.

Proposed TypeScript interface:

```ts
export interface AgentSettingsFile {
  $schema?: string;
  version?: 1;

  agent?: {
    configPath?: string;
    id?: string;
  };

  runtime?: {
    mode?: 'memory' | 'postgres';
    autoMigrate?: boolean;
  };

  logging?: {
    enabled?: boolean;
    level?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent';
    destination?: 'console' | 'file' | 'both';
    filePath?: string;
    pretty?: boolean;
  };

  interaction?: {
    autoApprove?: boolean;
    interactive?: boolean;
    approvalMode?: 'manual' | 'auto' | 'reject';
    clarificationMode?: 'interactive' | 'fail';
  };

  events?: {
    printLifecycle?: boolean;
    subscribe?: boolean;
    verbose?: boolean;
  };

  skills?: {
    dirs?: string[];
    allowExampleSkills?: boolean;
  };

  workspace?: {
    overrideRoot?: string;
    overrideShellCwd?: string;
  };

  model?: {
    /** Fallback only. Used only when agent.json omits model.provider. */
    overrideProvider?: string;
    /** Fallback only. Used only when agent.json omits model.model. */
    overrideModel?: string;
    overrideBaseUrl?: string;
    overrideApiKeyEnv?: string;
  };

  defaults?: {
    autoApproveAll?: boolean;
    capture?: 'full' | 'summary' | 'none';
    maxSteps?: number;
    toolTimeoutMs?: number;
    modelTimeoutMs?: number;
  };

  env?: Record<string, string>;
}
```

Rules:

- `agent.settings.json` should never be required when the caller already supplies explicit SDK options.
- `settings.runtime.mode` should default to `postgres`.
- `settings.logging.enabled` should default to `false`.
- `settings.interaction.approvalMode` should default to `auto`.
- `settings.interaction.clarificationMode` should default to `interactive`.
- `settings.events.subscribe` should default to `false`.
- `settings.skills.dirs` should default to `["./skills", "~/.adaptiveAgent/skills"]`.
- `settings.model.overrideProvider` and `settings.model.overrideModel` are fallback values only. They should be used only when `agent.json` omits `model.provider` or `model.model`, preserving `agent.json` as the source of truth for what model the agent is supposed to use.

## JSON Schema Validation

The SDK should use Ajv for JSON Schema validation.

Dependencies:

- `ajv`
- optionally `ajv-formats` if future schemas introduce formal `format` fields

Rationale:

- schemas should be portable and explicit
- config validation should be strict
- the SDK should surface helpful error messages to average developers

Validation requirements:

- validate parsed JSON after environment expansion and path normalization inputs are resolved where applicable
- set `additionalProperties: false` for strict top-level objects and nested configuration objects unless the field is intentionally open-ended
- allow `metadata` and `routing` as open-ended JSON objects
- wrap raw Ajv errors in friendly error types

Suggested error types:

```ts
export class AgentConfigValidationError extends Error {
  readonly issues: string[];
}

export class AgentSettingsValidationError extends Error {
  readonly issues: string[];
}
```

Validation message quality matters. Errors should be reformatted into human-readable strings such as:

- `resolved model.provider and model.model are required`
- `agent.defaultInvocationMode must be one of: run, chat`
- `settings.runtime.mode must be one of: memory, postgres`
- `settings.logging.filePath is required when logging.destination is "file" or "both"`

## Environment Variable Handling

### General Rules

The SDK should support environment variable expansion in string fields for both config files.

Supported syntax:

- `$VAR`
- `${VAR}`

The SDK does not need to support shell expression syntax such as `${VAR:-default}` in the first version.

Expansion should happen before validation for fields whose final resolved value must be a string, but after JSON parsing.

### Secrets Policy

For model credentials:

- prefer `apiKeyEnv`
- permit inline `apiKey` as an escape hatch
- do not require inline `apiKey`

Resolution order for model API key:

1. `settings.model.overrideApiKeyEnv`
2. `agent.model.apiKeyEnv`
3. provider default environment variable:
   - `OPENROUTER_API_KEY`
   - `MISTRAL_API_KEY`
   - `MESH_API_KEY`
4. `agent.model.apiKey`

For Ollama, no API key should be required by default.

### Model Resolution

Model field resolution order for most fields:

1. explicit SDK constructor override
2. `agent.settings.json` overrides
3. `agent.json`
4. env expansion within the winning string value

Exception: `settings.model.overrideProvider` and `settings.model.overrideModel` are fallback values, not overrides. They apply only when `agent.json` omits `model.provider` or `model.model`. This keeps `agent.json` authoritative for what model the agent is intended to use.

The following model fields should support env-driven values:

- `provider`
- `model`
- `baseUrl`
- `apiKeyEnv`

## Config Lookup

### `agent.json` Lookup Order

If the caller does not explicitly provide an agent config object or path, the SDK should resolve `agent.json` in this order:

1. constructor option `agentConfig`
2. `agent.settings.json` field `agent.configPath`
3. environment variable `ADAPTIVE_AGENT_CONFIG`
4. `./agent.json`
5. `~/.adaptiveAgent/agents/default-agent.json`

Note:

- `agent.settings.json.agent.configPath` is a useful place to point at a default shared `agent.json` for a machine, repo family, or host app.

### `agent.settings.json` Lookup Order

If the caller does not explicitly provide a settings object or path, the SDK should resolve `agent.settings.json` in this order:

1. constructor option `settingsConfig`
2. environment variable `ADAPTIVE_AGENT_SETTINGS`
3. `./agent.settings.json`
4. `~/.adaptiveAgent/agent.settings.json`

If `agent.settings.json` is absent, the SDK should continue using defaults.

## Merge And Precedence Rules

Final runtime resolution should use this precedence:

1. explicit SDK constructor overrides
2. `agent.settings.json`
3. `agent.json`
4. environment expansion within resolved string fields
5. built-in defaults

Interpretation notes:

- `agent.json` is the durable portable definition.
- `agent.settings.json` is allowed to override local concerns such as runtime mode, logging, skill directories, and workspace root.
- `agent.settings.json` may provide fallback model provider and model name values, but it must not override `agent.json` model provider or model name when those fields are present.
- explicit constructor overrides are the final authority.

## Resolved Configuration Model

The SDK should normalize raw file inputs into a resolved runtime structure.

Suggested interface:

```ts
export interface ResolvedAgentSdkConfig {
  agent: AgentConfigFile;
  settings: AgentSettingsFile;

  workspaceRoot: string;
  shellCwd: string;

  model: {
    provider: string;
    model: string;
    apiKey?: string;
    baseUrl?: string;
    maxConcurrentRequests?: number;
  };

  runtime: {
    requestedMode: 'memory' | 'postgres';
    mode: 'memory' | 'postgres';
    autoMigrate: boolean;
  };

  logging: {
    enabled: boolean;
    level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent';
    destination: 'console' | 'file' | 'both';
    filePath?: string;
    pretty: boolean;
  };

  interaction: {
    approvalMode: 'manual' | 'auto' | 'reject';
    clarificationMode: 'interactive' | 'fail';
  };

  events: {
    printLifecycle: boolean;
    subscribe: boolean;
    verbose: boolean;
  };

  skills: {
    dirs: string[];
    allowExampleSkills: boolean;
  };
}
```

Normalization rules:

- `workspaceRoot` defaults to `process.cwd()`
- `shellCwd` defaults to resolved `workspaceRoot`
- `runtime.mode` defaults to `postgres`
- `runtime.requestedMode` records the configured or defaulted runtime mode before fallback
- `runtime.mode` records the effective runtime mode after postgres-to-memory fallback, if any
- `runtime.autoMigrate` defaults to `true` in `postgres` mode
- `logging.enabled` defaults to `false`
- when logging is disabled, no logger should be constructed
- `interaction.approvalMode` defaults to `auto`
- `interaction.clarificationMode` defaults to `interactive`
- `events.subscribe` defaults to `false`
- `events.printLifecycle` defaults to `false`
- `skills.dirs` defaults to `["./skills", "~/.adaptiveAgent/skills"]` after path expansion and normalization

## Runtime Behavior

### Runtime Mode

The SDK should support:

- `memory`
- `postgres`

Default:

- `postgres`

For `memory` mode:

- use `createAdaptiveAgentRuntime()` from core with default in-memory stores

For `postgres` mode:

- read `process.env.DATABASE_URL`, matching the local CLI convention
- run core runtime migrations automatically when `autoMigrate` is true
- create durable stores using core Postgres helpers

If `postgres` mode is selected by default and `process.env.DATABASE_URL` is missing, fall back to `memory` mode and expose the effective mode in resolved SDK config and run metadata. If a caller explicitly sets `runtime.mode = "postgres"` and `process.env.DATABASE_URL` is missing, fail with a clear error.

### Logging

Logging should be first-class SDK behavior.

Use `createAdaptiveAgentLogger(...)` from [packages/core/src/logger.ts](/Users/ugmurthy/riding-amp/AgentSmith/packages/core/src/logger.ts).

When `logging.enabled = true`, the SDK should map settings to logger construction:

```ts
createAdaptiveAgentLogger({
  level,
  destination,
  filePath,
  pretty,
  name: 'adaptive-agent'
});
```

Defaults when enabled:

- `level = "info"`
- `destination = "console"`
- `pretty = true`

If destination is `file` or `both`, `filePath` must be present after resolution.

When `logging.enabled = false`, do not inject a runtime logger.

### Tool Resolution

The SDK should resolve builtin local tools by name, matching the local CLI behavior.

Builtin tool names:

- `read_file`
- `list_directory`
- `write_file`
- `shell_exec`
- `web_search`
- `read_web_page`

Resolution behavior:

- file tools use resolved `workspaceRoot` as `allowedRoot`
- `shell_exec` uses resolved `shellCwd`
- `web_search` should follow the same local provider conventions as current CLI logic
- `read_web_page` should be enabled without special config beyond timeout env if needed

If an agent references an unknown tool, fail during SDK creation with a clear error listing the missing and available tool names.

### Delegate Resolution

Delegates should be resolved from skill directories by name.

Default skill directories:

- `./skills`
- `~/.adaptiveAgent/skills`

Additional directories may come from:

- constructor overrides
- `agent.settings.json`
- `ADAPTIVE_AGENT_SKILLS_DIR`

If a referenced delegate cannot be loaded, fail during SDK creation.

If a delegate requires root tools that are not available to the agent, fail during SDK creation.

### Interaction Handling

The SDK should formalize approval and clarification handling.

Supported approval modes:

- `auto`
- `manual`
- `reject`

Supported clarification modes:

- `interactive`
- `fail`

Default modes:

- `approvalMode = "auto"`
- `clarificationMode = "interactive"`

Behavior:

- `auto`: if core returns `approval_requested`, the SDK should automatically call `resolveApproval(runId, true)` and continue the run
- `manual`: the SDK should surface the interactive state to the caller unless an approval handler is supplied
- `reject`: the SDK should automatically call `resolveApproval(runId, false)` and return the resulting terminal outcome
- `interactive`: if core returns `clarification_requested`, the SDK should invoke a configured clarification handler; if none exists, surface the state to the caller
- `fail`: if core returns `clarification_requested`, fail with a descriptive SDK error rather than trying to continue

## SDK API Surface

### Top-Level Exports

The package should export:

```ts
export function createAgentSdk(options?: CreateAgentSdkOptions): Promise<AgentSdk>;
export function loadAgentConfig(input?: string | AgentConfigFile, options?: LoadConfigOptions): Promise<AgentConfigFile>;
export function loadAgentSettings(input?: string | AgentSettingsFile, options?: LoadConfigOptions): Promise<AgentSettingsFile>;
export function resolveAgentSdkConfig(options?: CreateAgentSdkOptions): Promise<ResolvedAgentSdkConfig>;
```

### Core SDK Interfaces

```ts
export interface CreateAgentSdkOptions {
  agentConfig?: string | AgentConfigFile;
  settingsConfig?: string | AgentSettingsFile;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  overrides?: Partial<ResolvedAgentSdkConfig>;
  onApproval?: ApprovalHandler;
  onClarification?: ClarificationHandler;
}

export interface AgentSdk {
  readonly agent: AdaptiveAgent;
  readonly runtime: AdaptiveAgentRuntime;
  readonly config: ResolvedAgentSdkConfig;
  readonly tools: ToolDefinition[];
  readonly delegates: DelegateDefinition[];

  run(goal: string, options?: SdkRunOptions): Promise<RunResult>;
  ask(message: string, options?: SdkAskOptions): Promise<RunResult>;
  chat(messages: ChatMessage[], options?: SdkChatOptions): Promise<RunResult>;
  createChat(options?: ChatSessionOptions): Promise<ChatSession>;

  runs: {
    resume(runId: string): Promise<RunResult>;
    retry(runId: string): Promise<RunResult>;
    continue(runId: string, options?: ContinueRunOptions): Promise<RunResult>;
    createContinuation(runId: string, options?: ContinueRunOptions): Promise<ContinueRunResult>;
    interrupt(runId: string): Promise<void>;
    steer(runId: string, message: string): Promise<void>;
    getRecoveryOptions(runId: string): Promise<RunRecoveryOptions>;
    inspect(runId: string, options?: InspectRunOptions): Promise<RunInspection>;
  };

  respond: {
    approval(runId: string, approved: boolean): Promise<RunResult | void>;
    clarification(runId: string, message: string): Promise<RunResult>;
  };

  on(event: 'event', listener: (event: AgentEvent) => void, options?: SubscribeEventsOptions): () => void;
  close(): Promise<void>;
}
```

### Chat Session API

The SDK should provide a stateful chat helper because raw `agent.chat()` requires callers to manage the full message transcript.

```ts
export interface ChatSession {
  send(message: string, options?: SdkAskOptions): Promise<RunResult>;
  sendMany(messages: ChatMessage[], options?: SdkChatOptions): Promise<RunResult>;
  history(): ChatMessage[];
  reset(): void;
}
```

### Inspection API

The SDK should provide a host-level inspection helper.

```ts
export interface RunInspection {
  run: AgentRun;
  events?: AgentEvent[];
  latestSnapshot?: RunSnapshot | null;
  recoveryOptions?: RunRecoveryOptions;
}

export interface InspectRunOptions {
  includeEvents?: boolean;
  includeSnapshot?: boolean;
  includeRecoveryOptions?: boolean;
}

export interface SubscribeEventsOptions {
  runId?: string;
}
```

This should be implemented by reading runtime stores, not by expanding `AdaptiveAgent` itself.

## SDK Method Behavior

### `run(goal, options?)`

This should call core `agent.run(...)` with merged metadata and then resolve interactive states according to SDK interaction policy.

### `ask(message, options?)`

This should be a convenience wrapper for a single-turn chat request:

```ts
agent.chat({
  messages: [{ role: 'user', content: message }],
  ...
})
```

### `chat(messages, options?)`

This should call core `agent.chat(...)` directly and then resolve interactive states according to SDK interaction policy.

### `createChat()`

This should return a stateful chat session object that accumulates user and assistant messages locally.

On successful assistant replies, the session should append the assistant output into the local chat history in serialized form similar to the current CLI interactive loop.

### `runs.resume(runId)`

Call core `agent.resume(runId)` and apply the SDK's interaction handling loop.

### `runs.retry(runId)`

Call core `agent.retry(runId)` and apply the SDK's interaction handling loop.

### `runs.continue(runId, options?)`

Call core `agent.continueRun(...)` and apply the SDK's interaction handling loop.

### `runs.createContinuation(runId, options?)`

Call core `agent.createContinuationRun(...)` and return the raw continuation result.

### `runs.interrupt(runId)`

Call core `agent.interrupt(runId)`.

### `runs.steer(runId, message)`

Call core `agent.steer(runId, { message })`.

### `runs.getRecoveryOptions(runId)`

Call core `agent.getRecoveryOptions(runId)`.

### `runs.inspect(runId, options?)`

Read `runStore.getRun(runId)` and return the run with optional related inspection data.

Default behavior should include events because they are the most useful inspection artifact:

```ts
{
  includeEvents: true,
  includeSnapshot: false,
  includeRecoveryOptions: false
}
```

When requested:

- `includeEvents` reads `eventStore.listByRun(runId)`
- `includeSnapshot` reads `snapshotStore.getLatest(runId)`
- `includeRecoveryOptions` calls `agent.getRecoveryOptions(runId)`

If the runtime lacks the needed stores, throw a clear error.

## Event Subscription

The SDK should expose event subscription even when `events.subscribe = false`.

Meaning of the setting:

- `events.subscribe = false` means the SDK does not auto-subscribe and auto-print lifecycle events
- callers may still explicitly call `sdk.on('event', listener)`

Behavior:

- if the underlying `eventStore` supports `subscribe`, wire SDK listeners to it
- if `options.runId` is provided, invoke the listener only for events belonging to that run
- return an unsubscribe function
- if the runtime store does not support live subscription, either no-op with a warning or throw a clear unsupported error; choose one behavior and document it consistently

Recommended behavior:

- throw a clear unsupported error when explicit subscription is requested against a runtime that lacks `eventStore.subscribe`

## Error Model

The SDK should define host-level error classes for common failures.

Suggested classes:

```ts
export class AgentSdkError extends Error {}
export class AgentConfigValidationError extends AgentSdkError {
  readonly issues: string[];
}
export class AgentSettingsValidationError extends AgentSdkError {
  readonly issues: string[];
}
export class AgentConfigLookupError extends AgentSdkError {
  readonly candidates: string[];
}
export class AgentRuntimeConfigurationError extends AgentSdkError {}
export class AgentInteractionError extends AgentSdkError {}
```

Examples:

- missing `DATABASE_URL` in `postgres` mode
- unresolved `model.apiKeyEnv`
- referenced delegate missing from configured skill dirs
- `logging.destination = "file"` with no resolved `filePath`
- clarification requested while `clarificationMode = "fail"`

## Recommended Implementation Structure

Suggested package layout:

```text
packages/agent-sdk/
|- package.json
|- tsconfig.json
|- README.md
`- src/
   |- index.ts
   |- create-agent-sdk.ts
   |- types.ts
   |- errors.ts
   |- config/
   |  |- agent-config.ts
   |  |- settings-config.ts
   |  |- resolve-config.ts
   |  |- env.ts
   |  |- schemas/
   |  |  |- agent.schema.json
   |  |  `- agent.settings.schema.json
   |- runtime/
   |  |- runtime-loader.ts
   |  |- logger-loader.ts
   |  |- tool-loader.ts
   |  `- delegate-loader.ts
   |- interaction/
   |  |- resolve-interactive-result.ts
   |  `- handlers.ts
   `- chat/
      `- chat-session.ts
```

## Implementation Notes

### Reuse Over Reinvention

Prefer to reuse or adapt existing logic from:

- core CLI config parsing and env expansion
- core CLI local tool resolution
- core CLI delegate lookup rules
- core logger creation helper
- existing core model adapter resolution path through `createAdaptiveAgent(...)`

### Path Resolution

All config file paths and workspace paths should be normalized to absolute paths during resolution.

### Metadata

The SDK should attach useful run metadata automatically when available, for example:

- `agentId`
- `agentName`
- selected runtime mode

but should avoid overloading metadata with host-only details unless clearly useful.

### Approval Defaults

The agreed SDK default is permissive:

- `interaction.approvalMode = "auto"`

Implementation should make that explicit and avoid surprising hidden behavior.

This is intentionally different from the more conservative CLI default.

## Compatibility Notes

This spec intentionally goes beyond the current local CLI `agent.json` parser by supporting:

- nested `workspace`
- top-level `delegation`
- top-level `recovery`
- separate `agent.settings.json`
- SDK-specific logging and interaction settings

Implementers should treat these as additive SDK capabilities rather than as a rewrite of the current CLI contract.

If later desired, the CLI may converge toward the SDK config model, but the SDK should not wait for CLI parity before shipping.

## Example Minimal Files

### Minimal `agent.json`

```json
{
  "id": "local-agent",
  "name": "Local Agent",
  "invocationModes": ["run", "chat"],
  "defaultInvocationMode": "chat",
  "model": {
    "provider": "ollama",
    "model": "qwen3.5"
  },
  "tools": ["read_file", "list_directory", "write_file", "shell_exec"]
}
```

### Minimal `agent.settings.json`

```json
{
  "runtime": {
    "mode": "postgres"
  }
}
```

## Example Fully Loaded Files

### Full `agent.json`

```json
{
  "$schema": "./schemas/agent.schema.json",
  "version": 1,
  "id": "repo-assistant",
  "name": "Repository Assistant",
  "description": "A local coding and repo analysis agent.",
  "invocationModes": ["run", "chat"],
  "defaultInvocationMode": "chat",
  "workspace": {
    "root": "$HOME/projects/my-repo",
    "shellCwd": "$HOME/projects/my-repo"
  },
  "model": {
    "provider": "${AA_MODEL_PROVIDER}",
    "model": "${AA_MODEL_NAME}",
    "apiKeyEnv": "AA_MODEL_API_KEY",
    "baseUrl": "${AA_MODEL_BASE_URL}",
    "maxConcurrentRequests": 4
  },
  "systemInstructions": "Be concise, careful with file edits, and explain tradeoffs clearly.",
  "tools": [
    "read_file",
    "list_directory",
    "write_file",
    "shell_exec",
    "web_search",
    "read_web_page"
  ],
  "delegates": ["researcher", "docs-writer", "test-runner"],
  "defaults": {
    "maxSteps": 40,
    "toolTimeoutMs": 120000,
    "modelTimeoutMs": 180000,
    "maxRetriesPerStep": 1,
    "requireApprovalForWriteTools": true,
    "autoApproveAll": false,
    "capture": "summary",
    "injectToolManifest": true,
    "researchPolicy": {
      "mode": "standard",
      "maxSearches": 6,
      "maxPagesRead": 12,
      "checkpointAfter": 3,
      "requirePurpose": true
    },
    "toolBudgets": {
      "filesystem": {
        "maxCalls": 20,
        "maxConsecutiveCalls": 8,
        "checkpointAfter": 5,
        "onExhausted": "ask_model"
      },
      "research": {
        "maxCalls": 8,
        "maxConsecutiveCalls": 3,
        "checkpointAfter": 2,
        "onExhausted": "fail"
      }
    }
  },
  "delegation": {
    "maxDepth": 2,
    "maxChildrenPerRun": 4,
    "allowRecursiveDelegation": false,
    "childRunsMayRequestApproval": false,
    "childRunsMayRequestClarification": false
  },
  "recovery": {
    "continuation": {
      "enabled": true,
      "defaultStrategy": "hybrid_snapshot_then_step",
      "requireUserApproval": true
    },
    "retryableErrorCodes": ["MODEL_ERROR", "TOOL_ERROR"],
    "fallbackModels": [
      {
        "provider": "openrouter",
        "model": "openai/gpt-5-mini",
        "whenFailureClass": ["provider_transient"]
      }
    ]
  },
  "metadata": {
    "team": "platform",
    "environment": "development"
  },
  "routing": {
    "audience": "internal"
  }
}
```

### Full `agent.settings.json`

```json
{
  "$schema": "./schemas/agent.settings.schema.json",
  "version": 1,
  "agent": {
    "configPath": "./agent.json"
  },
  "runtime": {
    "mode": "postgres",
    "autoMigrate": true
  },
  "logging": {
    "enabled": false,
    "level": "info",
    "destination": "console",
    "pretty": true
  },
  "interaction": {
    "approvalMode": "auto",
    "clarificationMode": "interactive"
  },
  "events": {
    "printLifecycle": false,
    "subscribe": false,
    "verbose": false
  },
  "skills": {
    "dirs": ["./skills", "$HOME/.adaptiveAgent/skills"],
    "allowExampleSkills": false
  },
  "workspace": {
    "overrideRoot": "$HOME/projects/my-repo",
    "overrideShellCwd": "$HOME/projects/my-repo"
  },
  "model": {
    "overrideBaseUrl": "${AA_MODEL_BASE_URL}",
    "overrideApiKeyEnv": "AA_MODEL_API_KEY"
  },
  "defaults": {
    "capture": "summary",
    "maxSteps": 50,
    "toolTimeoutMs": 120000,
    "modelTimeoutMs": 180000
  },
  "env": {
    "WEB_SEARCH_PROVIDER": "brave",
    "WEB_TOOL_TIMEOUT_MS": "15000"
  }
}
```

## Acceptance Criteria

- An implementer can create `@adaptive-agent/agent-sdk` without guessing missing semantics.
- The SDK can construct an `AdaptiveAgent` from `agent.json` and optional `agent.settings.json`.
- Postgres runtime is the default when no runtime mode is provided; defaulted postgres falls back to memory when `process.env.DATABASE_URL` is missing, while explicitly configured postgres fails clearly when `process.env.DATABASE_URL` is missing.
- Logging is optional and disabled by default.
- Approval requests auto-resolve by default.
- Clarification requests can be handled interactively through SDK hooks by default.
- Ajv-based validation exists for both config files.
- The SDK exposes a high-level API for `run`, `ask`, `chat`, `createChat`, run recovery helpers, and inspection with optional events, latest snapshot, and recovery options.
- The SDK exposes explicit event subscription with optional `runId` filtering.
- The SDK preserves escape hatches to `agent`, `runtime`, `tools`, and `delegates`.
