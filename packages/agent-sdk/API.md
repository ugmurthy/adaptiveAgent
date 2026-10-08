# Agent SDK API reference

`@adaptive-agent/agent-sdk` loads agent profiles, applies local settings, registers
tools and delegates, and runs agents through `@adaptive-agent/core`. This reference
covers the current public exports and configuration formats, verified against
the TypeScript implementation and validators.

## Quick start

```ts
import { createAgentSdk } from '@adaptive-agent/agent-sdk';

const sdk = await createAgentSdk({
  agentConfigPath: './agent.json',
  runtimeMode: 'memory',
  settingsOverrides: {
    interaction: { approvalMode: 'manual', clarificationMode: 'fail' },
  },
});

try {
  const result = await sdk.runRaw('Summarize this repository');
  if (result.status === 'success') console.log(result.output);
  else console.log(result);
} finally {
  await sdk.close();
}
```

Use raw calls in a UI or service so the host can handle approvals and
clarifications. Normal calls can prompt on the terminal. The default approval
policy is `auto`; choose `manual` when tool execution needs host consent.

## Creating and inspecting an SDK

All calls below are imported from `@adaptive-agent/agent-sdk` unless another
entry point is shown. Async calls return promises. `options?` means optional.
Named request and result types are linked through the source references below;
core execution types are defined in [core types](../core/src/types.ts).

| Call | Result and purpose |
| --- | --- |
| `createAgentSdk(options?)` / `AgentSdk.create(options?)` | `AgentSdk`; resolve configuration and initialize tools, model, and runtime. |
| `loadAgentSdkConfig(options?)` | `ResolvedAgentSdkConfig`; resolve settings and profile without starting a runtime. |
| `discoverAgentSdkAgents(options?)` | `AgentSdkAgentDiscovery`; profile descriptors, current agent, and diagnostics, without loading tool or delegate handlers. |
| `inspectAgentSdkResolution(options?)` | `ResolvedAgentSdkModuleInspection`; effective config, selected tools/delegates, and registered tools. Loads modules. |
| `inspectAgentSdkCatalog(options?)` | `AgentSdkCatalogInspection`; profiles, tools, delegates, settings path, and diagnostics. Loads modules. |
| `resolveRuntimeTarget(options?)` | `RuntimeTarget`; resolve only storage settings, without discovering an agent or model. Options: `cwd`, `env`, `settingsPath`. |

### `AgentSdkOptions`

| Fields | Meaning |
| --- | --- |
| `agentConfig`, `agentConfigPath` | Inline `AgentConfigFile`, or profile path/name. Inline config wins. |
| `settingsConfig`, `settingsConfigPath`, `settingsOverrides` | Inline settings or file; overrides are merged into the chosen settings. |
| `cwd`, `env` | Lookup/workspace base and environment supplied to configuration resolution. |
| `model`, `modelAdapter` | Override model fields, or inject a core `ModelAdapter`. A valid resolved profile model is still required. |
| `runtimeMode`, `sqlitePath`, `runtime` | Storage override or injected core runtime stores. |
| `tools`, `delegates` | Custom core tool and delegate definitions. |
| `logger`, `eventListener`, `clock` | Inject logging, receive core events, or control the time used for ground-truth context. |
| `inferenceMode`, `inferenceTier` | `local`, `byok`, or `gateway`; tier is `low`, `medium`, `high`, or `xtra-high`. |
| `serverProfile`, `profileCachePath`, `profileRefs` | Select a server profile, change its cache directory, or supply authorization profile references. |
| `gatewayClient`, `gateway`, `accessToken` | Inject a gateway client or configure connection and authorization. |

See [configuration types](src/config-types.ts) for exact field types. Discovery
descriptors omit credentials and system instructions; resolved configuration
does not, so do not publish it as a safe catalog summary.

## Running, recovering, and observing

These are methods on `sdk`.

| Call | Return / behavior |
| --- | --- |
| `run(goal, options?)` | `RunResult`; execute a top-level objective and handle interactions according to settings. |
| `runRaw(goal, options?)` | `RunResult`; same preparation, but return approval/clarification states to the host. |
| `chat(messageOrMessages, options?)` | `ChatResult`; accept a string or `ChatMessage[]`, then handle interactions. |
| `chatRaw(messageOrMessages, options?)` | `ChatResult`; return interactions without prompting. |
| `resume(runId)` / `resumeRaw(runId)` | `RunResult`; resume an existing run. |
| `retry(runId)` / `retryRaw(runId)` | `RunResult`; retry through core recovery semantics. |
| `getRecoveryOptions(runId)` | `RunRecoveryOptions`; available recovery choices. |
| `getRecoveryPlan(runId)` | `RunRecoveryPlan`; recommended recovery action and constraints. |
| `recover({ runId, ... })` / `recoverRaw({ runId, ... })` | `RecoverRunResult`; apply a run recovery strategy. Options: `strategy?`, `requireApproval?`, `metadata?`. Use `getRecoveryPlan` for a run preview. |
| `recover({ sessionId, ... })` / `recoverRaw({ sessionId, ... })` | `RecoverSessionResult`; automatically recover an ordinary run, swarm, or catalog orchestration. Options: `executionId?`, `coordinatorRunId?`, `dryRun?`, `requireApproval?`. |
| `createContinuationRun(options)` | `ContinueRunResult`; create a continuation without executing it. |
| `continueRun(options)` / `continueRunRaw(options)` | `RunResult`; create and execute a continuation. |
| `interrupt(runId)` | `void`; request interruption. |
| `steer(runId, message)` | `void`; steer an active run with a string or core `SteerInput`. |
| `inspect(runId)` | `{ run, events }`; stored run, if present, and its event history. |
| `subscribe(listener)` | Unsubscribe function; receive live core events. No-op if the store lacks subscription support. |
| `close()` | `void`; unsubscribe and close SDK-owned runtime/gateway resources. |

The non-raw run recovery methods also apply interaction handling. Session
recovery never prompts or automatically resolves approvals/clarifications; it
returns `blocked` so the host can handle them explicitly. `chat` does not
retain a transcript: pass the complete `ChatMessage[]` for multi-turn chat.
Messages have `role: "system" | "user" | "assistant"`, `content`, and optional
`images`. There is no separate `ask()` or `createChat()` helper.

### Unified session recovery

```ts
const preview = await sdk.recover({ sessionId, dryRun: true });
const recovery = await sdk.recover({ sessionId });

if (recovery.outcome === 'completed') console.log(recovery.result);
else console.log(recovery.outcome, recovery.reason, recovery.plans);
```

`recover` is the decision-making entry point, not a fourth execution strategy.
Core chooses resume of persisted non-terminal work, same-run retry when eligible,
or a linked continuation when safe. The session facade routes the logical work
to its owning runtime/coordinator; it does not recover every historical run ID.

- Ordinary work follows continuation lineage and excludes delegate child runs.
- Swarms preserve successful workers, recover unfinished roles, start missing
  workers from the saved descriptor, and regenerate finalizers when inputs change.
- Catalog orchestration reuses the saved plan, preserves independent successful
  stages, and persists continuation run IDs and updated downstream inputs.
- Repeated recovery of completed work does not start another execution. Previously
  persisted continuations are reused instead of creating another branch.
- `dryRun` reads and plans without invoking models or changing durable execution
  state. Profile/tool initialization can still occur to reconstruct owners.
- Missing profiles, incompatible configuration/catalogs, cancellation, pending
  user action, exhausted budgets, and uncertain tool effects block automatic work.
  `requireApproval: true` grants continuation consent, not pending tool approval.

`RecoverSessionResult` includes `sessionId`, `outcome`, `target`, `plans`,
`actions`, and optional `result`, `reason`, `candidates`, and `startedRunIds`.
Outcomes are `planned`, `completed`, `failed`, `blocked`, `busy`, `ambiguous`,
or `not_found`. `completed` describes the owning execution's completion policy;
inspect its result for partial worker/stage failures allowed by that policy.

A session may contain several independent objectives. If more than one needs
recovery, or a continuation history branches, the API returns `ambiguous` rather
than choosing by recency. Select an ordinary `runId` instead of `sessionId`, or
provide `executionId` or `coordinatorRunId` alongside `sessionId`. Selectors must
belong to the session; the two session selectors are mutually exclusive.
Recover only against the original runtime stores; use SQLite or Postgres to
recover after process restarts. Referenced profiles must remain available through
their saved paths or the configured catalog.

### Execution options and results

`AgentSdkRunOptions` supports `runId`, `sessionId`, `input`, `images`,
`contentParts`, `contextRefs`, `context`, `executionContext`, `allowedTools`,
`forbiddenTools`, `outputSchema`, `metadata`, and `inferenceTier`.
`AgentSdkChatOptions` supports the same shared context/identity/schema fields,
but not `input`, run-level attachments, or tool filters; attachments belong in
the chat messages. Per-call `inferenceTier` is supported only in gateway mode.

`context` is model-visible information. `executionContext` is host-owned runtime
policy and is not added to model context. The SDK sets workspace file-access
authority and protects gateway authorization fields itself.

Continuation options use `fromRunId`, with optional `continuationRunId`,
`strategy`, `provider`, `model`, `metadata`, and `requireApproval`. Consult core
recovery types and `getRecoveryPlan()` before choosing a strategy.

Every `RunResult` / `ChatResult` has a `runId` and one of these statuses:

| Status | Relevant fields |
| --- | --- |
| `success` | `output`, `stepsUsed`, `usage`, optional `planId`. |
| `failure` | `code`, `error`, `stepsUsed`, `usage`. |
| `approval_requested` | `approvalId`, `toolName`, `message`, `rootRunId`, optional `parentRunId`. |
| `clarification_requested` | `message`, optional `suggestedQuestions`. |

Handle raw interactions through the underlying core agent:

```ts
let result = await sdk.runRaw('Summarize this repository');
if (result.status === 'approval_requested') {
  await sdk.agent.resolveApproval(result.runId, result.approvalId, true);
  result = await sdk.resumeRaw(result.runId);
} else if (result.status === 'clarification_requested') {
  result = await sdk.agent.resolveClarification(result.runId, 'Use the src directory');
}
```

`sdk.agent` exposes core APIs; `sdk.created` exposes the created agent/runtime
bundle. Other public properties are `config`, `agentPath`, `metadata`, and
`registeredToolNames`. Core APIs are outside this SDK call inventory.

## Multi-agent execution

### Swarm SDK

A swarm uses coordinator, worker, quality, and synthesizer profiles. Profiles
remain the source of model, instructions, and tools; requests carry objectives
and inputs, not duplicate agent definitions.

| Call | Purpose |
| --- | --- |
| `createSwarmSdk(options)` / `SwarmSdk.create(options)` | Create a swarm host. |
| `SwarmSdk.resolveConfig(options)` | Resolve role profiles without executing the swarm. |
| `swarm.run(request)` | Decompose `topLevelObjective`, execute worker runs, evaluate quality, and synthesize. Returns `SwarmSdkRunResult`. |
| `swarm.executeDecomposition(request)` | Execute prepared decomposition using `sessionId`, `coordinatorRunId`, `topLevelObjective`, and `decompositionOutput`. |
| `swarm.inspectSession(sessionId)` | Session state, phase, runs, result, and retryability. |
| `swarm.retrySession(sessionId, options?)` | Retry eligible session work; options: `dryRun`, `maxWorkers`, `allowPartial`. |
| `swarm.recover({ sessionId, ... })` | General swarm recovery; returns `SwarmRecoveryResult`. Options: `coordinatorRunId?`, `dryRun?`, `requireApproval?`. |
| `swarm.recoverSession(sessionId, now?)` | Legacy stale active-run recovery and refreshed session inspection; retained unchanged. Use `recover` for logical swarm completion. |
| `swarm.close()` | Release owned resources. |

`SwarmSdkOptions` extends SDK options with `coordinatorSdk`, role-specific
resolved configs or config paths (`coordinatorConfig`, `workerConfigs`,
`qualityConfig`, `synthesizerConfig` and their path variants), `maxWorkers`,
`lifecycleListener`, and `idFactory`. If quality/synthesizer profiles are omitted,
the coordinator config is reused with role instructions. Public properties:
`coordinatorSdk`, `config`.

`SwarmRunRequest` requires `topLevelObjective`; optionally supply `sessionId`,
`input`, `contentParts`, `executionContext`, `inferenceTier`, and `maxWorkers`.
The result contains session/coordinator IDs, decomposition, subtasks, worker
IDs, and defaults used. Its `state` is `completed`, `waiting`, or `failed`;
`executionResult` is present only when completed. See [swarm types](src/swarm-sdk.ts).

### Orchestration SDK

Orchestration routes inputs to capable profiles, runs stages, and optionally
performs final synthesis. See [orchestration types](src/orchestration.ts).

| Call | Purpose |
| --- | --- |
| `createOrchestrationSdk(options?)` / `OrchestrationSdk.create(options?)` | Build an orchestration host and catalog. |
| `orchestration.run(goal, options?)` / `runRaw(goal, options?)` | Execute stages; currently both calls use the same raw execution path. |
| `orchestration.inspectSession(sessionId)` | Session, run links, and plan. |
| `orchestration.inspectExecution(executionId)` | Durable execution, stages, and optional plan. |
| `orchestration.interruptExecution(executionId)` | Interrupt active stage runs. |
| `orchestration.resumeExecution(executionId)` | Resume paused execution. |
| `orchestration.recoverExecution(executionId, options?)` | Recover the saved execution using core run recovery; returns `OrchestrationRecoveryResult`. Options: `dryRun`, `requireApproval`. |
| `orchestration.close()` | Close cached agent runners. |

Creation options extend SDK options with `requestedAgentConfig` or
`requestedAgentConfigPath`, `agentCatalog` or `agentCatalogPaths`,
`includeDiscoveredAgents`, store injections (`sessionStore`,
`sessionRunLinkStore`, `orchestrationStore`), `catalogFingerprint`,
`sessionIdFactory`, `now`, `concurrency`, `agentRunnerFactory`, and
`orchestrationListener`. `recoveryStaleAfterMs` defaults to 60000; recent scheduler
activity and live leases return `busy`. Custom runners must expose
`getRecoveryPlan` and `recoverRaw` to recover existing stage runs. Concurrency has
`maxConcurrentRunsPerSession` and
`failurePolicy`; built-in orchestration stores default to in-memory.

Run options extend normal run options with `executionId`, `requestedAgentId`,
`sessionId`, `catalogFingerprint`, `routingDecision`,
`finalizeWithRequestedAgent`, and `orchestrationMetadata`. The result includes
the plan, stage results, detected modalities/subjects, execution shape, and
`finalResult`.

## Preparation, selection, and routing helpers

These are explicit building blocks. Calling `sdk.run()` alone does not
automatically invoke task preparation or automatic profile selection.
Attachment summaries use `{ images: string[], files: string[], audio: string[] }`.

| Call | Purpose |
| --- | --- |
| `prepareTask(runner, request)` | Return a validated `TaskPreparationResult`: title, name, decision, prepared objective, assumptions, questions, reason, and preparer IDs. |
| `restoreTaskPreparation(run, expected)` | Restore a successful persisted preparation after checking target, workspace, and attachments. |
| `validateTaskPreparationOutput(output, request)` | Validate the model's preparation output for the mode/objective. |
| `selectAgentProfile(runner, request)` | Select one eligible profile using an agent. |
| `eligibleAgentSelectionCandidates(request, excludedAgentId?)` | Filter profiles by validity, archive state, run support, and attachment modalities. |
| `safeCandidateSummary(candidate)` | Model-safe profile summary without credentials or system instructions. |
| `attachmentModalities(attachments)` | List modalities present in attachments. |
| `createTypeSafeAgentSelectionClient(options)` | Create a client with `apiKey`, optional `baseUrl` and `timeoutMs`; exposes `evaluate(request)`. |
| `loadTypeSafeAgentSelectionPolicy(cwd, policyPath, inline, env?)` | Load/normalize a file, inline policy, or defaults. |
| `typeSafePolicyHash(policy)` | Stable policy fingerprint. |
| `selectAgentProfileWithTypeSafe(client, request, model, policy?)` | Select one profile with relevance/confidence information. |
| `selectExecutionRoutingWithAgent(runner, request, minimumConfidence?)` | Choose direct or orchestration execution with an agent. |
| `selectExecutionRoutingWithTypeSafe(client, request, model, policy?, branch?)` | Combined TypeSafe routing; optional branch is `"orchestration"`. |
| `selectStagedExecutionRoutingWithTypeSafe(client, request, model, policy?)` | Mode-first TypeSafe routing, including per-stage confidence. |
| `directRoutingFallback(candidate, attachments, confidence)` | Build a fallback decision only if the profile supports every input modality. |
| `buildDeterministicExecutionRoutingDecision(params)` | Route using requested agent, detected modalities, catalog, and orchestration/synthesis flags. |
| `validateExecutionRoutingDecision(decision, modalities, catalog, limits?)` | Check selected profiles, coverage, and optional `maxSpecialists`. |
| `supportedModalities(config)` | Profile modalities; defaults to text. |
| `decideAutomaticRun(request)` | Apply configured selection/routing policy; return a selection or routing decision, not an executed target run. |
| `agentSelectionMetadata(selection)` | Serialize selection provenance for metadata. |
| `executionRoutingMetadata(routing)` | Serialize routing provenance for metadata. |

`PrepareTaskRequest` requires `mode: "auto" | "always"`, `originalObjective`,
`targetAgent`, `workspaceRoot`, and `attachments`; optional `sessionId` and
`clarificationAnswers`. `SelectAgentRequest` requires `originalObjective`,
`candidates`, `workspaceRoot`, `attachments`, and `sessionId`; adaptive routing
adds `maxSpecialists`. `AutomaticRunDecisionRequest` takes `fallbackSdk`,
`sdkOptions`, `cwd`, objective, attachments, session ID, and optional
`executionRoutingMode: "single"` / `selectorEventListener`.

Exact signatures: [preparation](src/task-preparation.ts),
[selection](src/agent-selection.ts), [TypeSafe](src/typesafe-agent-selection.ts),
[deterministic routing](src/execution-routing.ts),
[adaptive routing](src/adaptive-execution-routing.ts), [decision](src/run-decision.ts).
`TASK_PREPARATION_OUTPUT_SCHEMA` is also exported for schema reuse.

## Context, gateway, and background helpers

| Call | Purpose |
| --- | --- |
| `projectContextBundleDirectory(cwd?)` | Locate `.adaptiveAgent/context-bundles`. |
| `createProjectContextBundle(options)` | Save `{ name, description?, refs }`; options also include `cwd`, `force`, `dryRun`. |
| `getProjectContextBundle(name, cwd?)` | Read a bundle with its path and digest. |
| `listProjectContextBundles(cwd?)` | List project bundles. |
| `deleteProjectContextBundle(options)` | Delete by `name`; optional `cwd`, `dryRun`. |
| `expandContextBundleInputs(inputs, cwd?)` | Expand `{ kind: "ref", ref }` and `{ kind: "bundle", name }` inputs into refs and audit records. |
| `mergeContextBundleMetadata(metadata, bundles)` | Add reserved `contextBundles` audit metadata. |
| `parseContextRefFlag(value, flag)` | Parse `run:<uuid>` or `session:<id>`; `flag` labels errors. |
| `parseContextRef(value, label)` | Validate a structured core `ContextRef`. |
| `parseContextBundle(value, label?)` | Validate bundle JSON. |
| `validateContextBundleName(value)` | Validate a file-safe bundle name. |
| `buildGroundTruthContext(options?)` | Build current date/time and calendar facts; accepts ground-truth settings and `now`. |
| `mergeGroundTruthContext(context, settings, options?)` | Merge facts under `groundTruth`; disable with `enabled: false`. |
| `expandEnvironmentVariables(value, env?)` | Expand `$VAR`, `${VAR}`, and leading `~`; unresolved variables remain unchanged. |
| `agentConfigurationFingerprint(config)` | Fingerprint effective agent execution configuration. |
| `defaultProfileCachePath(env?)` | Locate the server-profile cache. |
| `resolveServerProfile(selection, options?)` | Resolve `server:<id>` or an exact `ProfileRef`; returns ref, bundle, agent config, and delegates. Options: `client`, `cachePath`, `env`, `executableTools`. |
| `resolveProfileNamespace(selection, localMatch, serverMatch)` | Resolve local/server qualification; reject ambiguous unqualified names. |
| `createGatewayProxyTool({ client, toolName })` | Core-compatible gateway tool for `web_search` or `read_web_page`. |
| `prepareSkillHandlerModule(request, options?)` | Prepare a handler module from core `SkillHandlerModuleRequest`; return module path, fingerprint, mode, and cache status. |
| `prepareSkillDirectory(directory, options?)` | Load a handler-backed skill and prepare its module. Both preparation calls accept `cacheRoot`, `env`, `force`. |
| `loadAmbientConfig(configPath, cwd?)` | Load filesystem/cron trigger configuration. |
| `buildAmbientSdkOptions(config, options?)` | Translate ambient configuration and start overrides into SDK options. |
| `runAmbientStart(options)` | Start trigger processing. Requires `configPath`; supports `dryRun`, `runOnce`, `signal`, model/runtime/interaction overrides, and injected `createSdk`, `clock`, `logger`. |

## Profile editing and CLI entry points

Import editing calls from `@adaptive-agent/agent-sdk/agent-create`.

| Call | Purpose |
| --- | --- |
| `prepareAgentCreate(options)` | Generate and validate a profile preview; requires `brief`. May call a model even without saving. |
| `runAgentCreate(options)` | Generate, confirm, and save; options include `generatorAgent`, `id`, `provider`, `model`, `runtimeMode`, `dryRun`, `yes`, `force`, `generateDraft`, `confirm`. |
| `prepareAgentConfigSave(options)` | Validate `agent` JSON and preview its target path, duplicates, and fingerprint. |
| `saveAgentConfig(options)` | Save only with matching `expectedPath` and `expectedTargetFingerprint` from preview; existing targets require `overwrite: true`. |
| `readAgentProfile(options)` | Read exact profile content by `agentId` and `configPath`. |
| `archiveAgentProfile(options)` | Move the exact profile into the archive. |
| `restoreAgentProfile(options)` | Restore an archived profile. |
| `renderAgentCreateReport(report, output?)` | Render `pretty`, `json`, or `jsonl`. |
| `renderAgentCreatePreview(prepared)` | Render a human-readable preview. |
| `confirmAgentCreateInTerminal(prepared)` | Prompt for confirmation and return a boolean. |

Editing options also support `cwd`, `env`, `settingsConfigPath`, and
`generatorAgent`; save options include `targetPath`. See [editing types](src/agent-create.ts).

Import `main(argv?)` and `parseCliArgs(argv)` from
`@adaptive-agent/agent-sdk/cli`. `main` executes CLI arguments and returns an
exit code; parsing returns `ManualTestCliOptions`. That entry point also exports
`ADAPTIVE_AGENT_CLI_COMMANDS`, `ADAPTIVE_AGENT_CLI_SUBCOMMANDS`, and
`ADAPTIVE_AGENT_POSITIONAL_COMMANDS`. The `/runtime-settings` entry point exports
the same `resolveRuntimeTarget` helper available at the package root.
For shell commands, see [the CLI guide](../../AGENT-SDK-CLI.md).

## Profile and settings files

### `agent.json`: the portable agent profile

Defines who the agent is, its model, instructions, tools, and execution policy.
Required fields are `id`, `name`, `invocationModes`, `defaultInvocationMode`,
`model`, and `tools`. The default invocation mode must be in the allowed list.

```json
{
  "version": 1,
  "id": "repo-reader",
  "name": "Repository Reader",
  "invocationModes": ["run", "chat"],
  "defaultInvocationMode": "run",
  "model": { "provider": "ollama", "model": "qwen3.5" },
  "systemInstructions": "Explain the repository clearly. Do not edit files.",
  "tools": ["read_file", "list_directory", "search_files"],
  "defaults": { "maxSteps": 20 },
  "capabilities": { "modalitiesSupported": ["text"] }
}
```

| Field / group | Structure and meaning |
| --- | --- |
| `$schema`, `version`, `description` | Optional schema URI, version `1`, and human-readable summary. |
| `workspace` | `{ root?, shellCwd? }`; file-tool root and shell directory. `workspaceRoot` is a legacy root alternative. |
| `model` | `provider`, `model`, optional `apiKeyEnv`, `apiKey`, `baseUrl`, `maxConcurrentRequests`, `structuredOutputMode: "prompted" | "strict"`. Provider/model must resolve before use. |
| `model.reasoning` | Mesh-only `{ enabled?, maxTokens?, retryWithoutReasoningAfterMs? }`; reasoning token range is 1024-128000. |
| `systemInstructions` | Agent's system prompt. |
| `tools`, `delegates` | Tool-name list and optional delegate skill-name list. Missing registrations fail initialization. |
| `defaults` | Execution limits and policies; shared structure below. |
| `delegation` | `maxDepth`, `maxChildrenPerRun`, `allowRecursiveDelegation`, `childRunsMayRequestApproval`, `childRunsMayRequestClarification`. |
| `recovery` | `continuation: { enabled?, defaultStrategy?, requireUserApproval? }`, `retryableErrorCodes`, and `fallbackModels: [{ provider, model, whenFailureClass?, whenErrorCode? }]`. |
| `capabilities` | `modalitiesSupported` / `modalitiesPreferred`: text, image, file, audio; `modalityRoles`: ingest/analyze/summarize/synthesize by modality; `subjectsPreferred`: string list. |
| `routing`, `metadata` | JSON objects for routing hints (including `keywords`) and custom metadata. |

Built-in tools: `read_file`, `list_directory`, `search_files`, `write_file`,
`edit_file`, `shell_exec`, `web_search`, `read_web_page`. File tools use the
workspace root; shell commands use `shellCwd`.

### `agent.settings.json`: local host settings

Optional machine/project preferences, separate from the portable profile.
Every group is optional; `{}` uses defaults.

```json
{
  "version": 1,
  "agent": { "configPath": "./agent.json" },
  "runtime": { "mode": "sqlite", "sqlitePath": "./var/runtime.sqlite" },
  "interaction": { "approvalMode": "manual", "clarificationMode": "fail" },
  "agents": { "dirs": ["./agents", "~/.adaptiveAgent/agents"] },
  "skills": { "dirs": ["./skills", "~/.adaptiveAgent/skills"] },
  "groundTruth": { "timezone": "America/Los_Angeles" }
}
```

| Group | Fields and behavior |
| --- | --- |
| `$schema`, `version` | Optional schema URI and version `1`. |
| `agent` | `configPath`, expected `id`, `mode: "fixed" | "auto"`. Auto selection needs the selection helpers/CLI workflow. |
| `agents`, `skills` | `dirs: string[]`; skills also has `allowExampleSkills` (default false). |
| `runtime` | `mode: "memory" | "sqlite" | "postgres"`, `autoMigrate` (default true), `sqlitePath`. |
| `logging` | `enabled` (default false), `level`, `destination: "console" | "file" | "both"`, `filePath`, `pretty`. File destinations require a path; defaults are info/console/pretty. |
| `interaction` | `approvalMode: "auto" | "manual" | "reject"` (default auto); `clarificationMode: "interactive" | "fail"` (default interactive). Legacy aliases: `autoApprove`, `interactive`. |
| `events` | `subscribe`, `printLifecycle`, `verbose` (default false). CLI printing preferences do not replace explicit subscriptions. |
| `workspace` | `overrideRoot`, `overrideShellCwd`. |
| `model` | `overrideProvider`, `overrideModel` are fallbacks; `overrideBaseUrl`, `overrideApiKeyEnv`, `overrideStructuredOutputMode` override profile values. |
| `inference` | `mode: "local" | "byok" | "gateway"`; defaults to local for Ollama, otherwise byok. `tier` defaults to medium. |
| `gateway` | `url`, `clientName`, `clientVersion`, `accessTokenEnv` (default `ADAPTIVE_AGENT_ACCESS_TOKEN`), `requireRunPermit`, connection/request timeouts, `reconnectAttempts`, `remoteTools` (web search/page reading only). |
| `taskPreparation` | `mode: "never" | "auto" | "always"`, `agent`, `showPreparedTask`. Enabled preparation requires an agent. |
| `agentSelection` | `engine: "agent" | "typesafe"`, selector `agent`, `lowConfidenceFallback: "error" | "agent"`, and TypeSafe settings below. |
| `executionRouting` | `mode: "single" | "adaptive"`, `maxSpecialists` (1-16), legacy `lowConfidenceFallback: "direct" | "error"`. Direct fallback is not supported with TypeSafe. |
| `defaults` | Override profile execution defaults. |
| `env` | String-to-string map for local environment values used during resolution/tool setup. Prefer environment references over committed secrets. |
| `groundTruth` | `enabled` (default true), `timezone`, `locale`, `weekStartsOn`, `businessDays`, `fiscalYearStartMonth` (1-12), `fiscalQuarterNaming: "startYear" | "endYear"`. Weekday values are lowercase full names. |
| `tui.messages` | Styles by user/assistant/progress/run/system/event: `{ showPrefix?, prefix?, body? }`; styles are names or arrays of names (for example bold, dim, cyan). |

### Shared `defaults` structure

Both files accept core `AgentDefaults`: `maxSteps`, `toolTimeoutMs`,
`modelTimeoutMs`, `modelInactivityTimeoutMs`, `maxOutputTokens`,
`maxRetriesPerStep`, `requireApprovalForWriteTools`, `autoApproveAll`,
`capture: "full" | "summary" | "none"`, `injectToolManifest`, and
`fileInputPolicy: "provider_native" | "read_file" | "auto"`.
Nested policies are:

- `modelRetryPolicy`: `maxRetries`, `retryOn`, `baseDelayMs`, `maxDelayMs`, `jitter`.
- `toolBudgets`: map of budget names to `maxCalls`, `maxConsecutiveCalls`,
  `checkpointAfter`, `onExhausted`.
- `researchPolicy`: a core policy name or `{ mode, maxSearches?, maxPagesRead?,
  checkpointAfter?, requirePurpose? }`.

Timeout/delay values are milliseconds. Limits and policy enums follow
[core types](../core/src/types.ts). Settings defaults override profile defaults;
approval mode `auto` also enables `autoApproveAll` when creating the agent.

### Lookup, precedence, and storage

- Settings: inline `settingsConfig`, explicit `settingsConfigPath`,
  `ADAPTIVE_AGENT_SETTINGS`, `./agent.settings.json`, then the user-home file.
  Missing optional settings use defaults; missing explicitly selected files fail.
- Profile: inline `agentConfig`, explicit `agentConfigPath`, settings
  `agent.configPath`, `ADAPTIVE_AGENT_CONFIG`, `./agent.json`, then
  `~/.adaptiveAgent/agents/default-agent.json`. Names are also searched in agent dirs.
- Explicit SDK options take precedence. `settingsOverrides` merges into selected
  settings. Provider/model precedence is SDK `model`, profile, then settings
  fallback; base URL and key-env settings override profile values.
- `$VAR`, `${VAR}`, and leading `~` are supported; shell expressions such as
  `${VAR:-default}` are not. Relative workspace roots use `cwd`; relative
  shell directories use the resolved workspace root.
- Agent dirs default to `./agents` and `~/.adaptiveAgent/agents`; skill dirs to
  `./skills` and `~/.adaptiveAgent/skills`. `ADAPTIVE_AGENT_AGENTS_DIR` and
  `ADAPTIVE_AGENT_SKILLS_DIR` supply path-delimited alternatives.
- Runtime defaults to Postgres, falling back to memory if `DATABASE_URL` is
  missing. Explicit Postgres selection fails without it unless stores are
  injected. The storage-only `resolveRuntimeTarget()` helper instead returns
  memory when the URL is absent, even for explicit Postgres settings.
- SQLite uses `sqlitePath`, then `ADAPTIVE_AGENT_SQLITE_PATH`, then
  `~/.adaptiveAgent/runtime.sqlite`. `ADAPTIVE_AGENT_HOME` changes SDK home paths.
- API-key environment names come from SDK `model.apiKeyEnv`, settings,
  profile, then provider defaults (`OPENROUTER_API_KEY`, `MISTRAL_API_KEY`,
  `MESH_API_KEY`). Inline `model.apiKey` is used only when no key-env name is
  selected. Ollama does not require a key by default.

### Other files used by the API

| File | Structure and role |
| --- | --- |
| TypeSafe policy JSON | Referenced by `agentSelection.typesafe.policyPath`, or supplied inline as `policy` (not both). Fields: `relevance: { instructions?, criteria?: { true?, false? } }`, `selection: { instructions?, candidateCriteria? }`, `routing: { modeInstructions?, primaryInstructions?, assignmentInstructions? }`, `minimumRelevance`, `minimumConfidence` (0-1). Instructions/criteria accept JSON values. |
| TypeSafe connection settings | `agentSelection.typesafe` also accepts `model`, `apiKeyEnv`, `baseUrl`, `timeoutMs`, and `routingStrategy: "combined" | "staged"`. Staged applies to adaptive routing. |
| Delegate `SKILL.md` | Markdown instructions with YAML frontmatter such as `name`, `description`, `allowedTools`, and dotted `defaults.*` fields. Loaded from skill dirs when referenced by `delegates`. Delegate tools must be available to the parent. |
| Skill `package.json` | Optional `adaptiveAgent: { handlerMode: "bundle" | "package" }`. Bundle is the default and prepares cached JavaScript; package leaves dependencies external. Relevant only to executable handler-backed skills. |
| Context bundle JSON | `.adaptiveAgent/context-bundles/<name>.json`: `{ schemaVersion: 1, name, description?, refs: ContextRef[] }`. Run refs use `{ kind: "run", id, view?: "result" }`; session refs use `{ kind: "session", id, view?: "run_summaries" }` plus selection/size/status controls. Stores references, not copied outputs. |
| Server profile cache | Default `~/.adaptiveAgent/profiles`; managed by the SDK, not a settings file to edit. Bundles contain `ref`, `schemaVersion`, `name`, `instructions`, optional `tools`, `allowedTools`, `defaults`, `limits`, `recoveryPolicy`, `routingMetadata`, `capabilities`, and recursive `delegates`. |
| Ambient config JSON | `{ version?: 1, agent?, settings?, runtime?, workspaceRoot?, artifactsRoot?, interaction?, defaults?, triggers }`. Agent/settings can be a path string or `{ configPath }`; paths resolve from the config location. Filesystem triggers have `id`, `type: "filesystem"`, `path`/`inboxDir`, `pattern`, polling/stability delays. Cron triggers have `id`, `type: "cron"`, `schedule`, optional `timezone`, `goal`/`goalFile`, `artifactPath`, `pollIntervalMs`, `concurrency`, `misfirePolicy: "skip"`. |

Server references are `{ source: "server", id, version, contentHash }`. A named
`server:<id>` selection requires a supplied gateway client; an exact cached ref
can resolve offline. Server selection forces gateway inference and verifies
the bundle identity/hash. Remote profiles are declarative, not downloaded code.
See [server profiles](src/server-profiles.ts) and
[gateway bundle types](../gateway-protocol/src/index.ts).

## Errors

Configuration and lookup failures reject with `AgentConfigValidationError` or
`AgentSettingsValidationError` (`sourcePath`, `issues`), or `AgentSdkLookupError`
(`candidates`). TypeSafe thresholds can raise `AgentSelectionConfidenceError`
or `ExecutionRoutingConfidenceError`. Other setup/interaction failures may be
ordinary errors. Execution failures generally return `status: "failure"`;
check the result status as well as catching exceptions.
