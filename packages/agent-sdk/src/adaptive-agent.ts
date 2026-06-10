#!/usr/bin/env bun

import { access, appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';

import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import type {
  AgentEvent,
  ChatMessage,
  ChatResult,
  ImageInput,
  JsonObject,
  JsonSchema,
  JsonValue,
  ModelContentPart,
  RunResult,
  SwarmRetryResult,
  SwarmRunResult,
  SwarmSubtask,
} from '@adaptive-agent/core';
import { SwarmCoordinator, createSwarmDecompositionOutputSchema } from '@adaptive-agent/core';

import {
  createAgentSdk,
  createOrchestrationSdk,
  inspectAgentSdkResolution,
  loadAgentSdkConfig,
  type AgentConfigFile,
  type AgentSdkOptions,
  type AgentSdkChatOptions,
  type AgentSdkRunOptions,
  type OrchestratedRunResult,
  type OrchestrationLifecycleEvent,
  type OrchestrationSdk,
  type ApprovalMode,
  type ClarificationMode,
  type RuntimeMode,
  type TuiMessageType,
  type TuiSettingsConfig,
  type TuiTextStyleName,
} from './index.js';
import { doctorExitCode, renderDoctorReport, runDoctor } from './install/doctor.js';
import { renderInitReport, runInit, type InitProfile } from './install/init.js';
import { renderUpdateReport, runUpdate, updateExitCode } from './install/update.js';
import { getVersionInfo, renderVersion } from './install/version.js';
import { applyNamedStyle, formatStyledMessageBlock } from './tui/message-styles.js';

marked.use(markedTerminal() as never);

export interface ManualTestCliOptions {
  command: 'run' | 'chat' | 'spec' | 'config' | 'eval' | 'swarm-run' | 'retry' | 'init' | 'doctor' | 'update' | 'version';
  specPath: string;
  goalArgs: string[];
  runId?: string;
  promptFilePath?: string;
  inputJson?: JsonValue;
  imagePaths: string[];
  audioPaths: string[];
  fileAttachmentPaths: string[];
  orchestrate: boolean;
  agentCatalogPaths: string[];
  workerCatalogPaths: string[];
  qualityAgentPath?: string;
  synthesizerAgentPath?: string;
  maxWorkers?: number;
  sessionId?: string;
  evalDataset?: 'cases' | 'gaia';
  evalInputPath?: string;
  evalFilesDir?: string;
  evalOutputPath?: string;
  evalArtifactsDir?: string;
  evalResume: boolean;
  evalFailFast: boolean;
  evalSwarm: number;
  evalLimit?: number;
  evalOffset: number;
  evalIds?: string[];
  evalLevel?: string;
  evalSplit?: string;
  evalType?: BenchmarkAttachmentType;
  mode?: 'chat' | 'run';
  cwd?: string;
  agentConfigPath?: string;
  settingsConfigPath?: string;
  runtimeMode?: RuntimeMode;
  provider?: 'openrouter' | 'ollama' | 'mistral' | 'mesh';
  model?: string;
  apiKeyEnv?: string;
  profile?: InitProfile;
  approvalMode?: ApprovalMode;
  clarificationMode?: ClarificationMode;
  yes: boolean;
  force: boolean;
  network: boolean;
  providerCheck: boolean;
  strict: boolean;
  updateCheck: boolean;
  updateVersion?: string;
  updateChannel: 'stable' | 'preview';
  updateRepo?: string;
  updateBaseUrl?: string;
  progress: boolean;
  events: boolean;
  inspect: boolean;
  showLines: number;
  wrapWidth?: number;
  dryRun: boolean;
  output: 'pretty' | 'json' | 'jsonl';
  help: boolean;
}

export interface ManualChatSpec {
  mode: 'chat';
  messages: ChatMessage[];
  context?: Record<string, JsonValue>;
  outputSchema?: JsonSchema;
  metadata?: Record<string, JsonValue>;
}

export interface ManualRunSpec {
  mode: 'run';
  goal: string;
  input?: JsonValue;
  images?: ImageInput[];
  contentParts?: ModelContentPart[];
  context?: Record<string, JsonValue>;
  outputSchema?: JsonSchema;
  metadata?: Record<string, JsonValue>;
}

export type ManualTestSpec = ManualChatSpec | ManualRunSpec;

interface ManualTestSummary {
  textParts: number;
  imageParts: number;
  fileParts: number;
  audioParts: number;
  legacyImages: number;
  messageCount: number;
}

interface InspectionSummary {
  run: Awaited<ReturnType<Awaited<ReturnType<typeof createAgentSdk>>['created']['runtime']['runStore']['getRun']>>;
  eventCount: number;
  eventTypes: Record<string, number>;
}

interface ManualTestJsonOutput {
  cli: Record<string, JsonValue>;
  resolvedConfig: Record<string, JsonValue>;
  request: JsonValue;
  warnings: string[];
  result: JsonValue;
  inspection?: JsonValue;
  orchestration?: JsonValue;
}

export interface BenchmarkCase {
  id: string;
  dataset?: string;
  split?: string;
  level?: string;
  question: string;
  input?: JsonValue;
  images?: ImageInput[];
  contentParts?: ModelContentPart[];
  expectedAnswer?: string;
  metadata?: Record<string, JsonValue>;
}

export interface BenchmarkResultRecord {
  schemaVersion: 1;
  dataset: string;
  taskId: string;
  level?: string;
  status: 'completed' | 'failed' | 'skipped';
  runId?: string;
  question: string;
  prediction?: JsonValue;
  predictionText?: string;
  expectedAnswer?: string;
  usage?: JsonValue;
  timings: { startedAt: string; finishedAt: string; durationMs: number };
  model: { provider: string; model: string };
  runtime: { mode: RuntimeMode };
  artifacts?: { eventLog?: string; inspection?: string; input?: string; output?: string; answer?: string };
  error?: { message: string; code?: string };
  metadata: Record<string, JsonValue>;
}

type GaiaAttachment =
  | { kind: 'image'; path: string }
  | { kind: 'audio'; path: string; format: Extract<ModelContentPart, { type: 'audio' }>['audio']['format'] }
  | { kind: 'file'; path: string };

export type BenchmarkAttachmentType = 'audio' | 'image' | 'video' | 'other';
export type BenchmarkDryRunAttachmentType = BenchmarkAttachmentType | 'none';

export interface GaiaDryRunTaskSummary {
  taskId: string;
  attachmentType: BenchmarkDryRunAttachmentType;
  fileName?: string;
  path?: string;
  level?: string;
  split?: string;
}

const BENCHMARK_ATTACHMENT_TYPES = ['audio', 'image', 'video', 'other'] as const;
const RUN_COLOR_STYLES = ['cyan', 'magenta', 'yellow', 'blue', 'green'] as const satisfies readonly TuiTextStyleName[];
const IMAGE_FILE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff']);
const AUDIO_FILE_EXTENSIONS = new Set(['.wav', '.mp3', '.flac', '.m4a', '.ogg', '.aac', '.aiff', '.aif', '.opus', '.oga', '.weba']);
const VIDEO_FILE_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.mpeg', '.mpg', '.ogv', '.wmv', '.flv', '.3gp', '.ts', '.mts', '.m2ts']);

const HELP_TEXT = `adaptive-agent

Agent SDK CLI

Usage:
  adaptive-agent run [options] <goal...>
  adaptive-agent swarm-run --agent <path-or-name> --worker-catalog <paths-or-names> [options] <task...>
  adaptive-agent retry --run-id <runId> [options]
  adaptive-agent retry --agent <path-or-name> --worker-catalog <paths-or-names> [options] <sessionId>
  adaptive-agent chat [options] [message...]
  adaptive-agent init [options]
  adaptive-agent doctor [options]
  adaptive-agent update [options]
  adaptive-agent spec <path> [options]
  adaptive-agent config [options]
  adaptive-agent --version
  adaptive-agent --spec <path> [options]
  bun run ./packages/agent-sdk/dist/adaptive-agent.js --spec <path> [options]

Eval usage:
  adaptive-agent eval cases --input <path> --out <path> [options]
  adaptive-agent eval gaia --input <path> --out <path> [options]

Commands:
  run                   Run a one-shot goal.
  swarm-run             Decompose one task into bounded worker runs and synthesize a final result.
  retry                 Retry one failed run, or retry a swarm session by session id.
  chat                  Send one chat turn. Reads stdin when no message is given.
  init                  Create first-run configuration under ~/.adaptiveAgent.
  doctor                Check CLI installation and local configuration.
  update                Check for or apply GitHub Release updates.
  spec                  Run the existing JSON spec format.
  config                Print resolved SDK configuration.

Eval commands:
  eval cases            Run generic benchmark cases from JSON/JSONL.
  eval gaia             Run GAIA benchmark rows from JSON/JSONL.

Global options:
  --cwd <path>            Working directory used for SDK config lookup.
  --output <format>       Output format: pretty, json, or jsonl. Default: pretty.
  --version               Print adaptive-agent version.
  --help                  Show this help text.

Agent/config options (run, chat, spec, config, eval, swarm-run, retry):
  --agent <path-or-name>  Explicit path to agent.json, or filename from agents.dirs.
  --settings <path>       Explicit path to agent.settings.json.
  --runtime <mode>        Runtime mode: memory or postgres.
  --provider <name>       Override provider: openrouter, ollama, mistral, mesh.
  --model <name>          Override model name.
  --approval <mode>       Approval mode: auto, manual, reject.
  --clarification <mode>  Clarification mode: interactive or fail.

Run options:
  --file <path>           Read run prompt from a file.
  --input-json <json>     JSON input passed to run requests.
  --image <path>          Add an image attachment to a run request. Repeatable.
  --audio <path>          Add an audio attachment to a run request. Repeatable.
  --file-attachment <path>
                          Add a file attachment to a run request. Repeatable.
  --orchestrate           Route run requests through the orchestration SDK.
  --catalog <path>        Agent config path to add to orchestration catalog. Repeatable.

Chat options:
  --file <path>           Read chat message from a file.

Spec options:
  --spec <path>           Path to the JSON spec file.
  --mode <chat|run>       Override the spec mode.
  --orchestrate           Route run-mode specs through the orchestration SDK.
  --catalog <path>        Agent config path to add to orchestration catalog. Repeatable.

Swarm-run options:
  --file <path>           Read swarm task from a file.
  --input-json <json>     JSON input passed to swarm runs.
  --image <path>          Add an image attachment to the coordinator request. Repeatable.
  --audio <path>          Add an audio attachment to the coordinator request. Repeatable.
  --file-attachment <path>
                          Add a file attachment to the coordinator request. Repeatable.
  --worker-catalog <paths>
                          Comma-separated worker agent JSON paths or filenames.
  --quality-agent <path-or-name>
                          Optional quality agent JSON path or filename.
  --synthesizer-agent <path-or-name>
                          Optional synthesizer agent JSON path or filename.
  --max-workers <n>       Maximum concurrent swarm workers.
  --session-id <id>       Session id for run grouping.

Retry options:
  --run-id <id>           Retry this single failed run instead of a swarm session.
  --worker-catalog <paths>
                          Comma-separated worker agent JSON paths or filenames for session retry.
  --quality-agent <path-or-name>
                          Optional quality agent JSON path or filename for session retry.
  --synthesizer-agent <path-or-name>
                          Optional synthesizer agent JSON path or filename for session retry.
  --max-workers <n>       Maximum concurrent swarm workers for session retry.

Init options:
  --provider <name>       Provider to write: openrouter, ollama, mistral, mesh.
  --model <name>          Model name to write.
  --api-key-env <name>    Environment variable containing provider API key.
  --profile <name>        Init profile: safe or coding.
  --yes                   Accept command defaults for non-interactive setup.
  --force                 Overwrite files when supported.
  --dry-run               Show what init would create without writing files.

Doctor options:
  --agent <path-or-name>  Explicit path to agent.json, or filename from agents.dirs.
  --settings <path>       Explicit path to agent.settings.json.
  --runtime <mode>        Runtime store mode to validate: memory or postgres.
  --provider <name>       Provider override to validate: openrouter, ollama, mistral, mesh.
  --model <name>          Model override to validate.
  --network               Allow doctor network checks against GitHub.
  --provider-check        Allow doctor provider reachability checks.
  --strict                Treat doctor warnings as failures.

Update options:
  --check                 Check for updates without installing.
  --version <version>     Install or check a specific release version.
  --channel <name>        Update channel: stable or preview. Default: stable.
  --force                 Reinstall even when already up to date.
  --yes                   Accept update prompts when supported.
  --repo <owner/repo>     GitHub release repo for update checks.
  --base-url <url>        Release asset base URL for update downloads.

Run output/debug options (run, chat, spec, eval, swarm-run, retry):
  --progress              Print assistant progress updates as they arrive.
  --events                Print lifecycle events as they arrive.
  --show-lines <n>        Maximum pretty-rendered progress lines to show. Default: 3.
  --wrap-width <n>        Fold progress/event text after this many columns. Default: terminal width or 100.
  --dry-run               Resolve config, request, tools, and delegates without running.

Inspection options (run, chat, spec):
  --inspect               Print a compact inspection summary after completion.

Eval options:
  --input <path>          Benchmark input JSONL for eval cases.
  --files-dir <path>      Directory for benchmark attachments.
  --out <path>            Benchmark result JSONL path. Required unless --dry-run
                          is used without --resume.
  --artifacts <dir>       Benchmark artifact directory.
  --resume                Skip benchmark cases already present in --out.
  --fail-fast             Stop eval after the first failed case.
  --swarm <n>             Run eval cases in batches of up to n concurrent runs.
  --limit <n>             Limit benchmark cases after filtering.
  --offset <n>            Skip benchmark cases before filtering.
  --ids <id,id,...>       Run only the listed benchmark case ids.
  --level <value>         Run only matching benchmark level.
  --split <value>         Add/filter benchmark split metadata.
  --type <value>          Run only rows with a matching attachment type: audio,
                          image, video, or other. Rows without attachments do not match.
  --orchestrate           Route benchmark cases through the orchestration SDK.
  --catalog <path>        Agent config path to add to orchestration catalog. Repeatable.
`;

const PROVIDER_INPUT_CAPABILITIES: Record<
  'openrouter' | 'ollama' | 'mistral' | 'mesh',
  Partial<Record<'image' | 'file' | 'audio', Array<'path' | 'url' | 'data' | 'file_id'>>>
> = {
  openrouter: {
    image: ['path'],
    file: ['path', 'url', 'file_id'],
    audio: ['path', 'data'],
  },
  ollama: {
    image: ['path'],
  },
  mistral: {
    image: ['path'],
    file: ['path', 'url', 'file_id'],
    audio: ['path', 'data'],
  },
  mesh: {
    image: ['path'],
    audio: ['path', 'data'],
  },
};

export async function main(argv = Bun.argv.slice(2)): Promise<number> {
  const cli = parseCliArgs(argv);
  if (cli.help) {
    console.log(HELP_TEXT);
    return 0;
  }

  if (cli.command === 'version') {
    console.log(renderVersion(getVersionInfo()));
    return 0;
  }

  if (cli.command === 'init') {
    return runInitCommand(cli);
  }

  if (cli.command === 'doctor') {
    return runDoctorCommand(cli);
  }

  if (cli.command === 'update') {
    return runUpdateCommand(cli);
  }

  if (cli.command === 'config') {
    return runConfigCommand(cli);
  }

  if (cli.command === 'run') {
    return runInlineCommand(cli, 'run');
  }

  if (cli.command === 'swarm-run') {
    return runSwarmCommand(cli);
  }

  if (cli.command === 'retry') {
    return runRetryCommand(cli);
  }

  if (cli.command === 'chat') {
    return runInlineCommand(cli, 'chat');
  }

  if (cli.command === 'eval') {
    return runEvalCommand(cli);
  }

  return runSpecCommand(cli);
}

async function runInitCommand(cli: ManualTestCliOptions): Promise<number> {
  const report = await runInit({
    cwd: cli.cwd,
    provider: cli.provider,
    model: cli.model,
    apiKeyEnv: cli.apiKeyEnv,
    profile: cli.profile,
    yes: cli.yes,
    force: cli.force,
    dryRun: cli.dryRun,
  });
  console.log(renderInitReport(report, cli.output));
  return report.actions.some((action) => action.kind === 'file' && action.status === 'exists') ? 1 : 0;
}

async function runDoctorCommand(cli: ManualTestCliOptions): Promise<number> {
  const report = await runDoctor({
    cwd: cli.cwd,
    agent: cli.agentConfigPath,
    settings: cli.settingsConfigPath,
    runtime: cli.runtimeMode,
    provider: cli.provider,
    model: cli.model,
    network: cli.network,
    providerCheck: cli.providerCheck,
    strict: cli.strict,
  });
  console.log(renderDoctorReport(report, cli.output));
  return doctorExitCode(report, cli.strict);
}

async function runUpdateCommand(cli: ManualTestCliOptions): Promise<number> {
  const report = await runUpdate({
    check: cli.updateCheck,
    targetVersion: cli.updateVersion,
    channel: cli.updateChannel,
    force: cli.force,
    yes: cli.yes,
    repo: cli.updateRepo,
    baseUrl: cli.updateBaseUrl,
  });
  console.log(renderUpdateReport(report, cli.output));
  return updateExitCode(report, cli.updateCheck);
}

async function runSpecCommand(cli: ManualTestCliOptions): Promise<number> {
  const specPath = resolve(cli.specPath);
  const spec = await parseAndValidateSpec(specPath, cli.mode);
  const resolvedCwd = resolve(cli.cwd ?? process.cwd());
  const sdkOptions = buildSdkOptions(cli, resolvedCwd);
  const inspection = cli.dryRun ? await inspectAgentSdkResolution(sdkOptions) : undefined;
  const resolvedConfig = inspection?.config ?? await loadAgentSdkConfig(sdkOptions);
  const warnings = collectProviderWarnings(spec, resolvedConfig.model.provider);
  const eventLog: Array<Record<string, JsonValue>> = [];
  const lastProgressContentByRun = new Map<string, string>();
  const progressRunColors = cli.progress && cli.output === 'pretty' ? new RunColorRegistry() : undefined;
  const eventListener = shouldListenForCliEvents(cli) ? (event: AgentEvent) => {
    const entry = summarizeEvent(event);
    eventLog.push(entry);
    if (progressRunColors) {
      printRunBoundaryEvent(event, resolvedConfig.tui, progressRunColors, cli.wrapWidth);
    }
    if (cli.events && cli.output === 'pretty') {
      printEvent(entry, resolvedConfig.tui);
    } else if (cli.progress && cli.output === 'pretty') {
      printProgressEvent(event, lastProgressContentByRun, resolvedConfig.tui, cli.showLines, cli.wrapWidth);
    }
  } : undefined;
  const orchestrationListener = shouldListenForCliEvents(cli) ? (event: OrchestrationLifecycleEvent) => {
    const entry = summarizeOrchestrationLifecycleEvent(event);
    eventLog.push(entry);
    if ((cli.events || cli.progress) && cli.output === 'pretty') {
      printOrchestrationLifecycleEvent(event, resolvedConfig.tui);
    }
  } : undefined;

  for (const warning of warnings) {
    if (cli.output === 'pretty') {
      console.error(`warning: ${warning}`);
    }
  }

  if (cli.output === 'pretty') {
    printResolvedConfigSummary(cli, resolvedConfig, spec, warnings);
  }

  if (cli.dryRun) {
    printDryRun(cli, inspection!, spec, warnings);
    return 0;
  }

  const sdk = await createAgentSdk({
    ...sdkOptions,
    eventListener,
  });
  const orchestrationSdk = cli.orchestrate && spec.mode === 'run'
    ? await createOrchestrationSdk({
        ...sdkOptions,
        requestedAgentConfig: sdk.config.agent,
        agentCatalogPaths: cli.agentCatalogPaths,
        runtime: sdk.created.runtime,
        eventListener,
        orchestrationListener,
      })
    : undefined;

  try {
    const orchestrated = orchestrationSdk && spec.mode === 'run'
      ? await orchestrationSdk.runRaw(spec.goal, buildRunOptions(spec))
      : undefined;
    const result = orchestrated?.finalResult ?? (spec.mode === 'chat'
      ? await sdk.chat(spec.messages, buildChatOptions(spec))
      : await sdk.run(spec.goal, buildRunOptions(spec)));

    const inspection = cli.inspect ? await summarizeInspection(sdk, result.runId) : undefined;
    if (cli.output === 'json') {
      const jsonOutput: ManualTestJsonOutput = {
        cli: summarizeCli(cli),
        resolvedConfig: summarizeResolvedConfig(resolvedConfig, spec),
        request: spec as unknown as JsonValue,
        warnings,
        result: summarizeResult(result),
        ...(inspection ? { inspection: inspection as unknown as JsonValue } : {}),
        ...(orchestrated ? { orchestration: summarizeOrchestration(orchestrated) } : {}),
      };
      console.log(JSON.stringify(jsonOutput, null, 2));
      return isSuccessfulResult(result) ? 0 : 1;
    }

    if (orchestrated) printOrchestration(orchestrated);
    printResult(result, spec.mode === 'chat' ? 'assistant' : 'run', resolvedConfig.tui);
    if (cli.inspect && inspection) {
      printInspection(inspection);
    }
    if (cli.events && eventLog.length > 0) {
      console.error(`event log captured: ${eventLog.length}`);
    }
    return isSuccessfulResult(result) ? 0 : 1;
  } finally {
    await orchestrationSdk?.close();
    await sdk.close();
  }
}

async function runInlineCommand(cli: ManualTestCliOptions, mode: 'run' | 'chat'): Promise<number> {
  const resolvedCwd = resolve(cli.cwd ?? process.cwd());
  const goal = await readInlinePrompt(cli, mode === 'run' ? 'run goal' : 'chat message');
  const spec: ManualTestSpec = mode === 'run'
    ? {
        mode: 'run',
        goal,
        ...(cli.inputJson === undefined ? {} : { input: cli.inputJson }),
        ...(cli.imagePaths.length > 0 ? { images: cli.imagePaths.map((path) => ({ path: resolveAssetPath(path, resolvedCwd) })) } : {}),
        ...(cli.audioPaths.length > 0 || cli.fileAttachmentPaths.length > 0
          ? { contentParts: buildInlineContentParts(cli, resolvedCwd) }
          : {}),
      }
    : { mode: 'chat', messages: [{ role: 'user', content: goal }] };
  await validateLocalPaths(spec);

  const sdkOptions = buildSdkOptions(cli, resolvedCwd);
  const inspection = cli.dryRun ? await inspectAgentSdkResolution(sdkOptions) : undefined;
  const resolvedConfig = inspection?.config ?? await loadAgentSdkConfig(sdkOptions);
  const warnings = collectProviderWarnings(spec, resolvedConfig.model.provider);
  const eventLog: Array<Record<string, JsonValue>> = [];
  const lastProgressContentByRun = new Map<string, string>();
  const progressRunColors = cli.progress && cli.output === 'pretty' ? new RunColorRegistry() : undefined;
  const eventListener = shouldListenForCliEvents(cli) ? (event: AgentEvent) => {
    const entry = summarizeEvent(event);
    eventLog.push(entry);
    if (progressRunColors) {
      printRunBoundaryEvent(event, resolvedConfig.tui, progressRunColors, cli.wrapWidth);
    }
    if (cli.events && cli.output === 'pretty') {
      printEvent(entry, resolvedConfig.tui);
    } else if (cli.progress && cli.output === 'pretty') {
      printProgressEvent(event, lastProgressContentByRun, resolvedConfig.tui, cli.showLines, cli.wrapWidth);
    }
  } : undefined;
  const orchestrationListener = shouldListenForCliEvents(cli) ? (event: OrchestrationLifecycleEvent) => {
    const entry = summarizeOrchestrationLifecycleEvent(event);
    eventLog.push(entry);
    if ((cli.events || cli.progress) && cli.output === 'pretty') {
      printOrchestrationLifecycleEvent(event, resolvedConfig.tui);
    }
  } : undefined;

  for (const warning of warnings) {
    if (cli.output === 'pretty') console.error(`warning: ${warning}`);
  }

  if (cli.output === 'pretty') {
    printInlineConfigSummary(cli, resolvedConfig, spec, warnings);
  }

  if (cli.dryRun) {
    printDryRun(cli, inspection!, spec, warnings);
    return 0;
  }

  const sdk = await createAgentSdk({
    ...sdkOptions,
    eventListener,
  });
  const orchestrationSdk = cli.orchestrate && spec.mode === 'run'
    ? await createOrchestrationSdk({
        ...sdkOptions,
        requestedAgentConfig: sdk.config.agent,
        agentCatalogPaths: cli.agentCatalogPaths,
        runtime: sdk.created.runtime,
        eventListener,
        orchestrationListener,
      })
    : undefined;

  try {
    const orchestrated = orchestrationSdk && spec.mode === 'run'
      ? await orchestrationSdk.runRaw(spec.goal, buildRunOptions(spec))
      : undefined;
    const result = orchestrated?.finalResult ?? (spec.mode === 'chat'
      ? await sdk.chat(spec.messages, buildChatOptions(spec))
      : await sdk.run(spec.goal, buildRunOptions(spec)));
    const inspection = cli.inspect ? await summarizeInspection(sdk, result.runId) : undefined;

    if (cli.output === 'json') {
      const jsonOutput: ManualTestJsonOutput = {
        cli: summarizeCli(cli),
        resolvedConfig: summarizeResolvedConfig(resolvedConfig, spec),
        request: spec as unknown as JsonValue,
        warnings,
        result: summarizeResult(result),
        ...(inspection ? { inspection: inspection as unknown as JsonValue } : {}),
        ...(orchestrated ? { orchestration: summarizeOrchestration(orchestrated) } : {}),
      };
      console.log(JSON.stringify(jsonOutput, null, 2));
      return isSuccessfulResult(result) ? 0 : 1;
    }

    if (orchestrated) printOrchestration(orchestrated);
    printResult(result, spec.mode === 'chat' ? 'assistant' : 'run', resolvedConfig.tui);
    if (cli.inspect && inspection) printInspection(inspection);
    if (cli.events && eventLog.length > 0) console.error(`event log captured: ${eventLog.length}`);
    return isSuccessfulResult(result) ? 0 : 1;
  } finally {
    await orchestrationSdk?.close();
    await sdk.close();
  }
}

async function runSwarmCommand(cli: ManualTestCliOptions): Promise<number> {
  const resolvedCwd = resolve(cli.cwd ?? process.cwd());
  const topLevelObjective = await readInlinePrompt(cli, 'swarm task');
  const sdkOptions = buildSdkOptions(cli, resolvedCwd);
  const eventLog: Array<Record<string, JsonValue>> = [];
  const coordinatorConfig = await loadFlaggedAgentSdkConfig(sdkOptions, '--agent', cli.agentConfigPath ?? 'agent.json');
  const workerConfigs = await Promise.all(cli.workerCatalogPaths.map((agentConfigPath) => loadFlaggedAgentSdkConfig(sdkOptions, '--worker-catalog', agentConfigPath)));
  const qualityConfig = cli.qualityAgentPath
    ? await loadFlaggedAgentSdkConfig(sdkOptions, '--quality-agent', cli.qualityAgentPath)
    : await loadAgentSdkConfig({ ...sdkOptions, agentConfig: roleAgentConfig(coordinatorConfig.agent, 'quality') });
  const synthesizerConfig = cli.synthesizerAgentPath
    ? await loadFlaggedAgentSdkConfig(sdkOptions, '--synthesizer-agent', cli.synthesizerAgentPath)
    : await loadAgentSdkConfig({ ...sdkOptions, agentConfig: roleAgentConfig(coordinatorConfig.agent, 'synthesizer') });
  const workerIds = workerConfigs.map((config) => config.agent.id);
  const duplicateWorkerId = workerIds.find((id, index) => workerIds.indexOf(id) !== index);
  if (duplicateWorkerId) throw new Error(`swarm-run worker catalog contains duplicate agent id: ${duplicateWorkerId}`);

  if (cli.dryRun) {
    printSwarmDryRun(cli, coordinatorConfig, workerConfigs, qualityConfig, synthesizerConfig);
    return 0;
  }

  const lastProgressContentByRun = new Map<string, string>();
  const swarmColors = cli.output === 'pretty' ? new RunColorRegistry() : undefined;
  const eventListener = shouldListenForCliEvents(cli) ? (event: AgentEvent) => {
    const entry = summarizeEvent(event);
    eventLog.push(entry);
    if (swarmColors && cli.progress) {
      printRunBoundaryEvent(event, coordinatorConfig.tui, swarmColors, cli.wrapWidth);
    }
    if (cli.events && cli.output === 'pretty') {
      printEvent(entry, coordinatorConfig.tui, swarmColors);
    } else if (cli.progress && cli.output === 'pretty') {
      printProgressEvent(event, lastProgressContentByRun, coordinatorConfig.tui, cli.showLines, cli.wrapWidth, swarmColors);
    }
  } : undefined;

  const coordinatorSdk = await createFlaggedAgentSdk({ ...sdkOptions, eventListener }, '--agent', cli.agentConfigPath ?? 'agent.json');
  const workerSdks = await Promise.all(cli.workerCatalogPaths.map((agentConfigPath) => createFlaggedAgentSdk({ ...sdkOptions, agentConfigPath, runtime: coordinatorSdk.created.runtime, eventListener }, '--worker-catalog', agentConfigPath)));
  const qualitySdk = cli.qualityAgentPath
    ? await createFlaggedAgentSdk({ ...sdkOptions, agentConfigPath: cli.qualityAgentPath, runtime: coordinatorSdk.created.runtime, eventListener }, '--quality-agent', cli.qualityAgentPath)
    : await createAgentSdk({ ...sdkOptions, agentConfig: roleAgentConfig(coordinatorSdk.config.agent, 'quality'), runtime: coordinatorSdk.created.runtime, eventListener });
  const synthesizerSdk = cli.synthesizerAgentPath
    ? await createFlaggedAgentSdk({ ...sdkOptions, agentConfigPath: cli.synthesizerAgentPath, runtime: coordinatorSdk.created.runtime, eventListener }, '--synthesizer-agent', cli.synthesizerAgentPath)
    : await createAgentSdk({ ...sdkOptions, agentConfig: roleAgentConfig(coordinatorSdk.config.agent, 'synthesizer'), runtime: coordinatorSdk.created.runtime, eventListener });

  try {
    const sessionId = cli.sessionId ?? crypto.randomUUID();
    const workerCatalog = workerConfigs.map((config) => ({
      id: config.agent.id,
      name: config.agent.name,
      description: config.agent.description ?? '',
      capabilities: (config.agent.capabilities ?? {}) as JsonValue,
    }));
    const contentParts = buildInlineContentParts(cli, resolvedCwd);
    const decompositionResult = await coordinatorSdk.runRaw(topLevelObjective, {
      sessionId,
      input: {
        originalInput: cli.inputJson ?? null,
        workerCatalog: workerCatalog as unknown as JsonValue,
      },
      contentParts: contentParts.length > 0 ? contentParts : undefined,
      context: {
        phase: 'swarm.decompose',
        topLevelObjective,
        validWorkerAgentIds: workerIds as unknown as JsonValue,
        instructions: [
          'Decompose the top-level objective into independent subtasks.',
          'Each subtask targetAgentId must exactly match one id from validWorkerAgentIds.',
          'Return only structured subtasks; do not invent worker ids.',
        ],
      },
      outputSchema: createSwarmDecompositionOutputSchema(workerIds),
      metadata: { orchestration: { kind: 'swarm', coordinatorRunId: 'pending', role: 'coordinator' } as unknown as JsonValue },
    });

    if (decompositionResult.status !== 'success') {
      throw new Error(`Coordinator decomposition failed: ${summarizeResult(decompositionResult)}`);
    }

    const subtasks = parseSwarmSubtasks(decompositionResult.output);
    validateSdkDecomposition(subtasks, workerIds);
    if (cli.output === 'pretty') {
      printSwarmExecutionPlan(sessionId, decompositionResult.runId, subtasks);
    }
    const swarm = new SwarmCoordinator({
      runStore: coordinatorSdk.created.runtime.runStore,
      coordinatorAgent: coordinatorSdk.agent,
      coordinatorAgentId: coordinatorSdk.config.agent.id,
      workerAgents: Object.fromEntries(workerSdks.map((sdk) => [sdk.config.agent.id, sdk.agent])),
      qualityAgent: qualitySdk.agent,
      qualityAgentId: qualitySdk.config.agent.id,
      synthesizerAgent: synthesizerSdk.agent,
      synthesizerAgentId: synthesizerSdk.config.agent.id,
      defaultMaxWorkers: cli.maxWorkers,
    });
    const result = await swarm.execute({
      sessionId,
      coordinatorRunId: decompositionResult.runId,
      topLevelObjective,
      input: cli.inputJson,
      contentParts: contentParts.length > 0 ? contentParts : undefined,
      maxWorkers: cli.maxWorkers,
      metadata: {
        defaultsUsed: {
          qualityAgent: cli.qualityAgentPath ? 'explicit' : 'coordinator_with_quality_instructions',
          synthesizerAgent: cli.synthesizerAgentPath ? 'explicit' : 'coordinator_with_synthesis_instructions',
        },
      },
      subtasks,
    });

    if (cli.output === 'json') {
      console.log(JSON.stringify(summarizeSwarmRun(result, workerIds, cli, subtasks), null, 2));
    } else if (cli.output === 'jsonl') {
      console.log(JSON.stringify(summarizeSwarmRun(result, workerIds, cli, subtasks)));
    } else {
      printSwarmResult(result, workerIds, cli);
      if (cli.events && eventLog.length > 0) console.error(`event log captured: ${eventLog.length}`);
    }
    return result.status === 'succeeded' ? 0 : 1;
  } finally {
    await Promise.allSettled([
      ...workerSdks.map((sdk) => sdk.close()),
      qualitySdk.close(),
      synthesizerSdk.close(),
      coordinatorSdk.close(),
    ]);
  }
}

async function runRetryCommand(cli: ManualTestCliOptions): Promise<number> {
  const resolvedCwd = resolve(cli.cwd ?? process.cwd());
  const sdkOptions = buildSdkOptions(cli, resolvedCwd);
  const eventLog: Array<Record<string, JsonValue>> = [];
  const resolvedConfig = await loadAgentSdkConfig(sdkOptions);
  const lastProgressContentByRun = new Map<string, string>();
  const retryColors = cli.output === 'pretty' ? new RunColorRegistry() : undefined;
  const eventListener = shouldListenForCliEvents(cli) ? (event: AgentEvent) => {
    const entry = summarizeEvent(event);
    eventLog.push(entry);
    if (retryColors && cli.progress) {
      printRunBoundaryEvent(event, resolvedConfig.tui, retryColors, cli.wrapWidth);
    }
    if (cli.events && cli.output === 'pretty') {
      printEvent(entry, resolvedConfig.tui, retryColors);
    } else if (cli.progress && cli.output === 'pretty') {
      printProgressEvent(event, lastProgressContentByRun, resolvedConfig.tui, cli.showLines, cli.wrapWidth, retryColors);
    }
  } : undefined;

  const coordinatorSdk = await createAgentSdk({ ...sdkOptions, eventListener });
  if (cli.runId) {
    try {
      const inspection = await coordinatorSdk.inspect(cli.runId);
      const runAgentId = typeof inspection.run?.metadata?.agentId === 'string' ? inspection.run.metadata.agentId : undefined;
      if (runAgentId && runAgentId !== coordinatorSdk.config.agent.id) {
        throw new Error(`Run ${cli.runId} belongs to agent ${runAgentId}; loaded agent is ${coordinatorSdk.config.agent.id}`);
      }
      const result = await coordinatorSdk.retry(cli.runId);
      if (cli.output === 'json') {
        console.log(JSON.stringify({ command: 'retry', runId: cli.runId, result: summarizeResult(result) }, null, 2));
      } else if (cli.output === 'jsonl') {
        console.log(JSON.stringify({ command: 'retry', runId: cli.runId, result: summarizeResult(result) }));
      } else {
        printResult(result, 'run', resolvedConfig.tui);
        if (cli.events && eventLog.length > 0) console.error(`event log captured: ${eventLog.length}`);
      }
      return isSuccessfulResult(result) ? 0 : 1;
    } finally {
      await coordinatorSdk.close();
    }
  }

  const sessionId = cli.goalArgs[0]!;
  const workerConfigs = await Promise.all(cli.workerCatalogPaths.map((agentConfigPath) => loadFlaggedAgentSdkConfig(sdkOptions, '--worker-catalog', agentConfigPath)));
  const workerIds = workerConfigs.map((config) => config.agent.id);
  const duplicateWorkerId = workerIds.find((id, index) => workerIds.indexOf(id) !== index);
  if (duplicateWorkerId) throw new Error(`retry worker catalog contains duplicate agent id: ${duplicateWorkerId}`);

  const qualitySdk = cli.qualityAgentPath
    ? await createFlaggedAgentSdk({ ...sdkOptions, agentConfigPath: cli.qualityAgentPath, runtime: coordinatorSdk.created.runtime, eventListener }, '--quality-agent', cli.qualityAgentPath)
    : await createAgentSdk({ ...sdkOptions, agentConfig: roleAgentConfig(coordinatorSdk.config.agent, 'quality'), runtime: coordinatorSdk.created.runtime, eventListener });
  const synthesizerSdk = cli.synthesizerAgentPath
    ? await createFlaggedAgentSdk({ ...sdkOptions, agentConfigPath: cli.synthesizerAgentPath, runtime: coordinatorSdk.created.runtime, eventListener }, '--synthesizer-agent', cli.synthesizerAgentPath)
    : await createAgentSdk({ ...sdkOptions, agentConfig: roleAgentConfig(coordinatorSdk.config.agent, 'synthesizer'), runtime: coordinatorSdk.created.runtime, eventListener });
  const workerSdks = await Promise.all(cli.workerCatalogPaths.map((agentConfigPath) => createFlaggedAgentSdk({ ...sdkOptions, agentConfigPath, runtime: coordinatorSdk.created.runtime, eventListener }, '--worker-catalog', agentConfigPath)));

  try {
    const swarm = new SwarmCoordinator({
      runStore: coordinatorSdk.created.runtime.runStore,
      coordinatorAgent: coordinatorSdk.agent,
      coordinatorAgentId: coordinatorSdk.config.agent.id,
      workerAgents: Object.fromEntries(workerSdks.map((sdk) => [sdk.config.agent.id, sdk.agent])),
      qualityAgent: qualitySdk.agent,
      qualityAgentId: qualitySdk.config.agent.id,
      synthesizerAgent: synthesizerSdk.agent,
      synthesizerAgentId: synthesizerSdk.config.agent.id,
      defaultMaxWorkers: cli.maxWorkers,
    });
    const result = await swarm.retrySession({ sessionId, dryRun: cli.dryRun, maxWorkers: cli.maxWorkers });
    if (cli.output === 'json') {
      console.log(JSON.stringify(summarizeSwarmRetry(result), null, 2));
    } else if (cli.output === 'jsonl') {
      console.log(JSON.stringify(summarizeSwarmRetry(result)));
    } else {
      printSwarmRetryResult(result);
      if (cli.events && eventLog.length > 0) console.error(`event log captured: ${eventLog.length}`);
    }
    return result.status === 'succeeded' ? 0 : 1;
  } finally {
    await Promise.allSettled([
      ...workerSdks.map((sdk) => sdk.close()),
      qualitySdk.close(),
      synthesizerSdk.close(),
      coordinatorSdk.close(),
    ]);
  }
}

async function runConfigCommand(cli: ManualTestCliOptions): Promise<number> {
  const resolvedCwd = resolve(cli.cwd ?? process.cwd());
  const resolvedConfig = await loadAgentSdkConfig(buildSdkOptions(cli, resolvedCwd));
  if (cli.output === 'json') {
    console.log(JSON.stringify(resolvedConfig, null, 2));
    return 0;
  }
  console.log(`agent: ${resolvedConfig.agent.id} (${resolvedConfig.agent.name})`);
  console.log(`model: ${resolvedConfig.model.provider}/${resolvedConfig.model.model}`);
  console.log(`runtime: ${resolvedConfig.runtime.mode} (requested ${resolvedConfig.runtime.requestedMode})`);
  console.log(`workspace: ${resolvedConfig.workspaceRoot}`);
  console.log(`shellCwd: ${resolvedConfig.shellCwd}`);
  console.log(`approval: ${resolvedConfig.interaction.approvalMode}`);
  console.log(`clarification: ${resolvedConfig.interaction.clarificationMode}`);
  console.log(`agentSearchDirs: ${resolvedConfig.agents.dirs.join(', ')}`);
  console.log(`tools: ${resolvedConfig.agent.tools.join(', ')}`);
  console.log(`delegates: ${(resolvedConfig.agent.delegates ?? []).join(', ') || '(none)'}`);
  return 0;
}

async function runEvalCommand(cli: ManualTestCliOptions): Promise<number> {
  if (!cli.evalInputPath) {
    throw new Error(`eval ${cli.evalDataset ?? 'benchmark'} requires --input <path>`);
  }
  if (!cli.evalOutputPath && (!cli.dryRun || cli.evalResume)) {
    if (cli.dryRun && cli.evalResume) {
      throw new Error(`eval ${cli.evalDataset ?? 'benchmark'} --dry-run --resume requires --out <path>`);
    }
    throw new Error(`eval ${cli.evalDataset ?? 'benchmark'} requires --out <path>`);
  }

  const resolvedCwd = resolve(cli.cwd ?? process.cwd());
  const outputPath = cli.evalOutputPath ? resolve(cli.evalOutputPath) : undefined;
  const artifactsDir = cli.evalArtifactsDir ? resolve(cli.evalArtifactsDir) : undefined;
  const allCases = cli.evalDataset === 'gaia'
    ? await loadGaiaBenchmarkCases(cli.evalInputPath, resolvedCwd, cli.evalFilesDir, cli.evalSplit)
    : await loadBenchmarkCases(cli.evalInputPath, resolvedCwd);
  const completedIds = cli.evalResume && outputPath ? await readCompletedBenchmarkIds(outputPath) : new Set<string>();
  const selectedCases = selectBenchmarkCases(allCases, cli, completedIds);
  const sdkOptions = buildSdkOptions(cli, resolvedCwd);
  const inspection = cli.dryRun ? await inspectAgentSdkResolution(sdkOptions) : undefined;
  const resolvedConfig = inspection?.config ?? await loadAgentSdkConfig(sdkOptions);

  if (cli.output === 'pretty') {
    console.log(`benchmark: ${cli.evalDataset}`);
    console.log(`input: ${resolve(resolvedCwd, cli.evalInputPath)}`);
    if (cli.evalFilesDir) console.log(`files: ${resolve(resolvedCwd, cli.evalFilesDir)}`);
    if (cli.evalType) console.log(`type: ${cli.evalType}`);
    if (outputPath) console.log(`out: ${outputPath}`);
    console.log(`selected: ${selectedCases.length}/${allCases.length}`);
    console.log(`swarm: ${cli.evalSwarm}`);
    console.log(`model: ${resolvedConfig.model.provider}/${resolvedConfig.model.model}`);
    console.log(`runtime: ${resolvedConfig.runtime.mode}`);
    console.log('');
  }

  if (cli.dryRun) {
    printEvalDryRun(cli, inspection!, selectedCases, allCases.length);
    return 0;
  }

  if (cli.evalSwarm > 1) {
    validateEvalSwarmRuntime(resolvedConfig);
  }

  if (!outputPath) {
    throw new Error(`eval ${cli.evalDataset ?? 'benchmark'} requires --out <path>`);
  }
  await mkdir(dirname(outputPath), { recursive: true });
  if (artifactsDir) await mkdir(artifactsDir, { recursive: true });

  const eventLog: Array<Record<string, JsonValue>> = [];
  const lastProgressContentByRun = new Map<string, string>();
  const swarmColors = cli.evalSwarm > 1 && cli.output === 'pretty' ? new RunColorRegistry() : undefined;
  const eventListener = (event: AgentEvent) => {
    const entry = summarizeEvent(event);
    eventLog.push(entry);
    if (swarmColors && cli.progress) {
      printRunBoundaryEvent(event, resolvedConfig.tui, swarmColors, cli.wrapWidth);
    }
    if (cli.events && cli.output === 'pretty') {
      printEvent(entry, resolvedConfig.tui, swarmColors);
    } else if (cli.progress && cli.output === 'pretty') {
      printProgressEvent(event, lastProgressContentByRun, resolvedConfig.tui, cli.showLines, cli.wrapWidth, swarmColors);
    }
  };
  const sdk = await createAgentSdk({
    ...sdkOptions,
    eventListener,
  });
  const orchestrationListener = (event: OrchestrationLifecycleEvent) => {
    const entry = summarizeOrchestrationLifecycleEvent(event);
    eventLog.push(entry);
    if ((cli.events || cli.progress) && cli.output === 'pretty') {
      printOrchestrationLifecycleEvent(event, resolvedConfig.tui);
    }
  };
  const orchestrationSdk = cli.orchestrate
    ? await createOrchestrationSdk({
        ...sdkOptions,
        requestedAgentConfig: sdk.config.agent,
        agentCatalogPaths: cli.agentCatalogPaths,
        runtime: sdk.created.runtime,
        eventListener,
        orchestrationListener,
      })
    : undefined;

  let failed = 0;
  let completed = 0;
  let processed = 0;
  const removeProcessErrorGuard = installEvalProcessErrorGuard();
  try {
    for (let batchStart = 0; batchStart < selectedCases.length; batchStart += cli.evalSwarm) {
      const batch = selectedCases.slice(batchStart, batchStart + cli.evalSwarm);
      const records = await Promise.all(batch.map((benchmarkCase) => runBenchmarkCase({
        sdk,
        benchmarkCase,
        resolvedConfig,
        outputPath,
        artifactsDir,
        eventLog,
        orchestrationSdk,
        includeEventArtifacts: cli.evalSwarm === 1,
      })));

      for (const [batchIndex, record] of records.entries()) {
        await appendJsonLine(outputPath, record as unknown as JsonValue);
        printEvalRecord(record, batchStart + batchIndex, cli, swarmColors);
        processed += 1;
        if (record.status === 'completed') {
          completed += 1;
        } else {
          failed += 1;
        }
      }

      if (cli.evalFailFast && records.some((record) => record.status !== 'completed')) {
        break;
      }
    }
  } finally {
    removeProcessErrorGuard();
    await orchestrationSdk?.close();
    await sdk.close();
  }

  if (cli.output === 'pretty') {
    console.log('');
    console.log(`completed: ${completed}`);
    console.log(`failed: ${failed}`);
    if (processed < selectedCases.length) console.log(`skipped: ${selectedCases.length - processed}`);
  }
  return failed === 0 ? 0 : 1;
}

export function parseCliArgs(argv: string[]): ManualTestCliOptions {
  const options: ManualTestCliOptions = {
    command: 'spec',
    specPath: '',
    goalArgs: [],
    imagePaths: [],
    audioPaths: [],
    fileAttachmentPaths: [],
    orchestrate: false,
    agentCatalogPaths: [],
    workerCatalogPaths: [],
    evalResume: false,
    evalFailFast: false,
    evalSwarm: 1,
    evalOffset: 0,
    yes: false,
    force: false,
    network: false,
    providerCheck: false,
    strict: false,
    updateCheck: false,
    updateChannel: 'stable',
    progress: false,
    events: false,
    inspect: false,
    showLines: 3,
    dryRun: false,
    output: 'pretty',
    help: false,
  };

  let commandSeen = false;
  let swarmSpecified = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!commandSeen && (arg === 'run' || arg === 'chat' || arg === 'spec' || arg === 'config' || arg === 'eval' || arg === 'swarm-run' || arg === 'retry' || arg === 'init' || arg === 'doctor' || arg === 'update')) {
      options.command = arg;
      commandSeen = true;
      if (arg === 'spec' && argv[index + 1] && !argv[index + 1].startsWith('--')) {
        options.specPath = argv[++index];
      }
      if (arg === 'eval' && argv[index + 1] && !argv[index + 1].startsWith('--')) {
        options.evalDataset = parseEnumOption(arg, argv[++index], ['cases', 'gaia']);
      }
      continue;
    }

    switch (arg) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--version':
        if (options.command === 'update') {
          options.updateVersion = requireOptionValue(arg, argv[++index]);
          break;
        }
        options.command = 'version';
        break;
      case '--check':
        options.updateCheck = true;
        break;
      case '--events':
        options.events = true;
        break;
      case '--progress':
        options.progress = true;
        break;
      case '--inspect':
        options.inspect = true;
        break;
      case '--show-lines':
        options.showLines = parsePositiveIntegerOption(arg, requireOptionValue(arg, argv[++index]));
        break;
      case '--wrap-width':
        options.wrapWidth = parsePositiveIntegerOption(arg, requireOptionValue(arg, argv[++index]));
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--yes':
        options.yes = true;
        break;
      case '--force':
        options.force = true;
        break;
      case '--network':
        options.network = true;
        break;
      case '--provider-check':
        options.providerCheck = true;
        options.network = true;
        break;
      case '--strict':
        options.strict = true;
        break;
      case '--channel':
        options.updateChannel = parseEnumOption(arg, requireOptionValue(arg, argv[++index]), ['stable', 'preview']);
        break;
      case '--repo':
        options.updateRepo = requireOptionValue(arg, argv[++index]);
        break;
      case '--base-url':
        options.updateBaseUrl = requireOptionValue(arg, argv[++index]);
        break;
      case '--spec':
        options.specPath = requireOptionValue(arg, argv[++index]);
        options.command = 'spec';
        break;
      case '--file':
        options.promptFilePath = requireOptionValue(arg, argv[++index]);
        break;
      case '--input-json':
        options.inputJson = parseJsonFlag(requireOptionValue(arg, argv[++index]), arg);
        break;
      case '--input':
        options.evalInputPath = requireOptionValue(arg, argv[++index]);
        break;
      case '--files-dir':
        options.evalFilesDir = requireOptionValue(arg, argv[++index]);
        break;
      case '--out':
        options.evalOutputPath = requireOptionValue(arg, argv[++index]);
        break;
      case '--artifacts':
        options.evalArtifactsDir = requireOptionValue(arg, argv[++index]);
        break;
      case '--resume':
        options.evalResume = true;
        break;
      case '--fail-fast':
        options.evalFailFast = true;
        break;
      case '--swarm':
        options.evalSwarm = parsePositiveIntegerOption(arg, requireOptionValue(arg, argv[++index]));
        swarmSpecified = true;
        break;
      case '--limit':
        options.evalLimit = parsePositiveIntegerOption(arg, requireOptionValue(arg, argv[++index]));
        break;
      case '--offset':
        options.evalOffset = parseNonNegativeIntegerOption(arg, requireOptionValue(arg, argv[++index]));
        break;
      case '--ids':
        options.evalIds = requireOptionValue(arg, argv[++index]).split(',').map((id) => id.trim()).filter(Boolean);
        break;
      case '--level':
        options.evalLevel = requireOptionValue(arg, argv[++index]);
        break;
      case '--split':
        options.evalSplit = requireOptionValue(arg, argv[++index]);
        break;
      case '--type':
        options.evalType = parseEnumOption(arg, requireOptionValue(arg, argv[++index]), BENCHMARK_ATTACHMENT_TYPES);
        break;
      case '--image':
        options.imagePaths.push(requireOptionValue(arg, argv[++index]));
        break;
      case '--audio':
        options.audioPaths.push(requireOptionValue(arg, argv[++index]));
        break;
      case '--file-attachment':
        options.fileAttachmentPaths.push(requireOptionValue(arg, argv[++index]));
        break;
      case '--orchestrate':
        options.orchestrate = true;
        break;
      case '--catalog':
        options.agentCatalogPaths.push(requireOptionValue(arg, argv[++index]));
        break;
      case '--worker-catalog':
        options.workerCatalogPaths.push(...requireOptionValue(arg, argv[++index]).split(',').map((path) => path.trim()).filter(Boolean));
        break;
      case '--quality-agent':
        options.qualityAgentPath = requireOptionValue(arg, argv[++index]);
        break;
      case '--synthesizer-agent':
        options.synthesizerAgentPath = requireOptionValue(arg, argv[++index]);
        break;
      case '--max-workers':
        options.maxWorkers = parsePositiveIntegerOption(arg, requireOptionValue(arg, argv[++index]));
        break;
      case '--session-id':
        options.sessionId = requireOptionValue(arg, argv[++index]);
        break;
      case '--run-id':
        options.runId = requireOptionValue(arg, argv[++index]);
        break;
      case '--mode':
        options.mode = parseEnumOption(arg, requireOptionValue(arg, argv[++index]), ['chat', 'run']);
        break;
      case '--cwd':
        options.cwd = requireOptionValue(arg, argv[++index]);
        break;
      case '--agent':
        options.agentConfigPath = requireOptionValue(arg, argv[++index]);
        break;
      case '--settings':
        options.settingsConfigPath = requireOptionValue(arg, argv[++index]);
        break;
      case '--runtime':
        options.runtimeMode = parseEnumOption(arg, requireOptionValue(arg, argv[++index]), ['memory', 'postgres']);
        break;
      case '--provider':
        options.provider = parseEnumOption(arg, requireOptionValue(arg, argv[++index]), ['openrouter', 'ollama', 'mistral', 'mesh']);
        break;
      case '--model':
        options.model = requireOptionValue(arg, argv[++index]);
        break;
      case '--api-key-env':
        options.apiKeyEnv = requireOptionValue(arg, argv[++index]);
        break;
      case '--profile':
        options.profile = parseEnumOption(arg, requireOptionValue(arg, argv[++index]), ['safe', 'coding']);
        break;
      case '--approval':
        options.approvalMode = parseEnumOption(arg, requireOptionValue(arg, argv[++index]), ['auto', 'manual', 'reject']);
        break;
      case '--clarification':
        options.clarificationMode = parseEnumOption(arg, requireOptionValue(arg, argv[++index]), ['interactive', 'fail']);
        break;
      case '--output':
        options.output = parseEnumOption(arg, requireOptionValue(arg, argv[++index]), ['pretty', 'json', 'jsonl']);
        break;
      default:
        if (options.command === 'run' || options.command === 'chat' || options.command === 'swarm-run' || options.command === 'retry') {
          options.goalArgs.push(arg);
          break;
        }
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.help && options.command === 'spec' && !options.specPath) {
    throw new Error('Missing required --spec <path> argument');
  }

  if (!options.help && options.command === 'eval' && !options.evalDataset) {
    throw new Error('Missing eval dataset. Expected `adaptive-agent eval cases` or `adaptive-agent eval gaia`.');
  }

  if (!options.help && swarmSpecified && options.command !== 'eval') {
    throw new Error('--swarm is supported for eval requests, not run/chat/spec/config/swarm-run requests');
  }

  if (!options.help && options.command === 'swarm-run') {
    if (!options.agentConfigPath) {
      throw new Error('swarm-run requires --agent <path-or-name> for the coordinator agent');
    }
    if (options.workerCatalogPaths.length === 0) {
      throw new Error('swarm-run requires --worker-catalog <path-or-name,...>');
    }
    if (options.promptFilePath && options.goalArgs.length > 0) {
      throw new Error('swarm-run accepts positional task text or --file <path>, but not both');
    }
    if (!options.promptFilePath && options.goalArgs.length === 0) {
      throw new Error('swarm-run requires positional task text or --file <path>');
    }
    if (options.orchestrate) {
      throw new Error('--orchestrate is not used with swarm-run; swarm-run already uses coordinated decomposition');
    }
  }

  if (!options.help && options.command === 'retry') {
    if (options.runId) {
      if (options.goalArgs.length > 0) {
        throw new Error('retry accepts --run-id <runId> or one positional <sessionId>, but not both');
      }
    } else {
      if (options.goalArgs.length !== 1 || !options.goalArgs[0]?.trim()) {
        throw new Error('retry requires --run-id <runId> or exactly one positional <sessionId>');
      }
      if (!options.agentConfigPath) {
        throw new Error('retry <sessionId> requires --agent <path-or-name> for the coordinator agent');
      }
      if (options.workerCatalogPaths.length === 0) {
        throw new Error('retry <sessionId> requires --worker-catalog <path-or-name,...>');
      }
    }
  }

  if (!options.help && options.command === 'chat' && options.imagePaths.length > 0) {
    throw new Error('--image is supported for run requests, not chat requests');
  }

  if (!options.help && options.command === 'chat' && options.audioPaths.length > 0) {
    throw new Error('--audio is supported for run requests, not chat requests');
  }

  if (!options.help && options.command === 'chat' && options.fileAttachmentPaths.length > 0) {
    throw new Error('--file-attachment is supported for run requests, not chat requests');
  }

  if (!options.help && options.command === 'chat' && options.inputJson !== undefined) {
    throw new Error('--input-json is supported for run requests, not chat requests');
  }

  if (!options.help && options.command === 'chat' && options.orchestrate) {
    throw new Error('--orchestrate is supported for run requests, not chat requests');
  }

  return options;
}

export async function loadManualTestSpec(specPath: string, modeOverride?: 'chat' | 'run'): Promise<ManualTestSpec> {
  const raw = await readSpecJson(specPath);
  const mode = modeOverride ?? readMode(raw);
  if (mode === 'chat') {
    return parseManualChatSpec(raw, specPath);
  }
  return parseManualRunSpec(raw, specPath);
}

export function collectProviderWarnings(spec: ManualTestSpec, provider: 'openrouter' | 'ollama' | 'mistral' | 'mesh'): string[] {
  const parts = collectContentParts(spec);
  const capabilities = PROVIDER_INPUT_CAPABILITIES[provider];
  const warnings: string[] = [];

  for (const part of parts) {
    if (part.type === 'text') continue;
    const supportedSources = capabilities[part.type];
    if (!supportedSources) {
      warnings.push(`Provider "${provider}" does not declare ${part.type} input support; this request will likely fail.`);
      continue;
    }

    const sourceKind = part.type === 'image'
      ? 'path'
      : part.type === 'file'
        ? part.file.source.kind
        : part.audio.source.kind;
    if (!supportedSources.includes(sourceKind)) {
      warnings.push(`Provider "${provider}" does not support ${part.type} source "${sourceKind}" in the current adapter; this request will likely fail.`);
    }
  }

  return warnings;
}

function buildSdkOptions(cli: ManualTestCliOptions, cwd: string) {
  return {
    cwd,
    agentConfigPath: cli.agentConfigPath,
    settingsConfigPath: cli.settingsConfigPath,
    runtimeMode: cli.runtimeMode,
    model: cli.provider || cli.model ? { ...(cli.provider ? { provider: cli.provider } : {}), ...(cli.model ? { model: cli.model } : {}) } : undefined,
    settingsConfig: cli.approvalMode || cli.clarificationMode
      ? {
          interaction: {
            ...(cli.approvalMode ? { approvalMode: cli.approvalMode } : {}),
            ...(cli.clarificationMode ? { clarificationMode: cli.clarificationMode } : {}),
          },
        }
      : undefined,
  };
}

function buildChatOptions(spec: ManualChatSpec): AgentSdkChatOptions {
  return {
    context: spec.context,
    outputSchema: spec.outputSchema,
    metadata: spec.metadata,
  };
}

function buildRunOptions(spec: ManualRunSpec): AgentSdkRunOptions {
  return {
    input: spec.input,
    images: spec.images,
    contentParts: spec.contentParts,
    context: spec.context,
    outputSchema: spec.outputSchema,
    metadata: spec.metadata,
  };
}

function buildInlineContentParts(cli: ManualTestCliOptions, cwd: string): ModelContentPart[] {
  return [
    ...cli.fileAttachmentPaths.map((path) => ({
      type: 'file' as const,
      file: { source: { kind: 'path' as const, path: resolveAssetPath(path, cwd) } },
    })),
    ...cli.audioPaths.map((path) => ({
      type: 'audio' as const,
      audio: { source: { kind: 'path' as const, path: resolveAssetPath(path, cwd) }, format: inferAudioFormat(path) },
    })),
  ];
}

function inferAudioFormat(path: string): Extract<ModelContentPart, { type: 'audio' }>['audio']['format'] {
  switch (extname(path).toLowerCase()) {
    case '.wav': return 'wav';
    case '.mp3': return 'mp3';
    case '.flac': return 'flac';
    case '.m4a': return 'm4a';
    case '.ogg': return 'ogg';
    case '.aac': return 'aac';
    case '.aiff':
    case '.aif': return 'aiff';
    default: return 'mp3';
  }
}

async function readSpecJson(specPath: string): Promise<JsonObject> {
  const content = await readFile(specPath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Spec file ${specPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return ensureObject(parsed, `Spec file ${specPath}`);
}

function readMode(raw: JsonObject): 'chat' | 'run' {
  const mode = raw.mode;
  if (mode !== 'chat' && mode !== 'run') {
    throw new Error('Spec file must include "mode": "chat" or "mode": "run"');
  }
  return mode;
}

function parseManualChatSpec(raw: JsonObject, specPath: string): ManualChatSpec {
  const messagesValue = raw.messages;
  if (!Array.isArray(messagesValue) || messagesValue.length === 0) {
    throw new Error('Chat spec requires a non-empty "messages" array');
  }

  const baseDir = dirname(specPath);
  const messages = messagesValue.map((value, index) => parseChatMessage(value, baseDir, `messages[${index}]`));
  return {
    mode: 'chat',
    messages,
    context: parseOptionalRecord(raw.context, 'context'),
    outputSchema: parseOptionalSchema(raw.outputSchema),
    metadata: parseOptionalRecord(raw.metadata, 'metadata'),
  };
}

function parseManualRunSpec(raw: JsonObject, specPath: string): ManualRunSpec {
  const goal = requireString(raw.goal, 'goal');
  const baseDir = dirname(specPath);
  const images = parseOptionalImageArray(raw.images, baseDir, 'images');
  const contentParts = parseOptionalContentPartArray(raw.contentParts, baseDir, 'contentParts');
  if (images && contentParts?.some((part) => part.type === 'image')) {
    throw new Error('Run spec must not include both "images" and image entries in "contentParts"');
  }

  return {
    mode: 'run',
    goal,
    ...(raw.input === undefined ? {} : { input: raw.input as JsonValue }),
    ...(images ? { images } : {}),
    ...(contentParts ? { contentParts } : {}),
    context: parseOptionalRecord(raw.context, 'context'),
    outputSchema: parseOptionalSchema(raw.outputSchema),
    metadata: parseOptionalRecord(raw.metadata, 'metadata'),
  };
}

function parseChatMessage(value: unknown, baseDir: string, label: string): ChatMessage {
  const raw = ensureObject(value, label);
  const role = parseEnumField(raw.role, `${label}.role`, ['system', 'user', 'assistant']);
  const content = parseMessageContent(raw.content, baseDir, `${label}.content`);
  const images = parseOptionalImageArray(raw.images, baseDir, `${label}.images`);
  if (Array.isArray(content) && images && images.length > 0) {
    throw new Error(`${label}.images is allowed only when ${label}.content is a string`);
  }
  return {
    role,
    content,
    ...(images ? { images } : {}),
  };
}

function parseMessageContent(value: unknown, baseDir: string, label: string): string | ModelContentPart[] {
  if (typeof value === 'string') {
    return value;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be a string or an array of content parts`);
  }
  return value.map((part, index) => parseContentPart(part, baseDir, `${label}[${index}]`));
}

function parseOptionalContentPartArray(value: unknown, baseDir: string, label: string): ModelContentPart[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value.map((part, index) => parseContentPart(part, baseDir, `${label}[${index}]`));
}

function parseContentPart(value: unknown, baseDir: string, label: string): ModelContentPart {
  const raw = ensureObject(value, label);
  const type = parseEnumField(raw.type, `${label}.type`, ['text', 'image', 'file', 'audio']);
  switch (type) {
    case 'text':
      return { type, text: requireString(raw.text, `${label}.text`) };
    case 'image':
      return { type, image: parseImageInput(raw.image, baseDir, `${label}.image`) };
    case 'file':
      return { type, file: parseFileInput(raw.file, baseDir, `${label}.file`) };
    case 'audio':
      return { type, audio: parseAudioInput(raw.audio, baseDir, `${label}.audio`) };
  }
}

function parseOptionalImageArray(value: unknown, baseDir: string, label: string): ImageInput[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value.map((entry, index) => parseImageInput(entry, baseDir, `${label}[${index}]`));
}

function parseImageInput(value: unknown, baseDir: string, label: string): ImageInput {
  const raw = ensureObject(value, label);
  const path = resolveAssetPath(requireString(raw.path, `${label}.path`), baseDir);
  return {
    path,
    ...(raw.mimeType === undefined ? {} : { mimeType: requireString(raw.mimeType, `${label}.mimeType`) }),
    ...(raw.detail === undefined ? {} : { detail: parseEnumField(raw.detail, `${label}.detail`, ['auto', 'low', 'high']) }),
    ...(raw.name === undefined ? {} : { name: requireString(raw.name, `${label}.name`) }),
  };
}

function parseFileInput(value: unknown, baseDir: string, label: string): Extract<ModelContentPart, { type: 'file' }>['file'] {
  const raw = ensureObject(value, label);
  const source = ensureObject(raw.source, `${label}.source`);
  const kind = parseEnumField(source.kind, `${label}.source.kind`, ['path', 'url', 'file_id']);
  return {
    source: kind === 'path'
      ? { kind, path: resolveAssetPath(requireString(source.path, `${label}.source.path`), baseDir) }
      : kind === 'url'
        ? { kind, url: requireString(source.url, `${label}.source.url`) }
        : { kind, fileId: requireString(source.fileId, `${label}.source.fileId`) },
    ...(raw.mimeType === undefined ? {} : { mimeType: requireString(raw.mimeType, `${label}.mimeType`) }),
    ...(raw.name === undefined ? {} : { name: requireString(raw.name, `${label}.name`) }),
  };
}

function parseAudioInput(value: unknown, baseDir: string, label: string): Extract<ModelContentPart, { type: 'audio' }>['audio'] {
  const raw = ensureObject(value, label);
  const source = ensureObject(raw.source, `${label}.source`);
  const kind = parseEnumField(source.kind, `${label}.source.kind`, ['path', 'url', 'data', 'file_id']);
  const format = parseEnumField(raw.format, `${label}.format`, ['wav', 'mp3', 'flac', 'm4a', 'ogg', 'aac', 'aiff', 'pcm16', 'pcm24']);
  return {
    source: kind === 'path'
      ? { kind, path: resolveAssetPath(requireString(source.path, `${label}.source.path`), baseDir) }
      : kind === 'url'
        ? { kind, url: requireString(source.url, `${label}.source.url`) }
        : kind === 'data'
          ? { kind, data: requireString(source.data, `${label}.source.data`) }
          : { kind, fileId: requireString(source.fileId, `${label}.source.fileId`) },
    format,
    ...(raw.mimeType === undefined ? {} : { mimeType: requireString(raw.mimeType, `${label}.mimeType`) }),
    ...(raw.name === undefined ? {} : { name: requireString(raw.name, `${label}.name`) }),
  };
}

function parseOptionalRecord(value: unknown, label: string): Record<string, JsonValue> | undefined {
  if (value === undefined) {
    return undefined;
  }
  return ensureObject(value, label) as Record<string, JsonValue>;
}

function parseOptionalSchema(value: unknown): JsonSchema | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('outputSchema must be an object');
  }
  return value as JsonSchema;
}

function ensureObject(value: unknown, label: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function parseEnumField<const T extends string>(value: unknown, label: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${label} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function parseEnumOption<const T extends string>(flag: string, value: string, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) {
    throw new Error(`${flag} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function parsePositiveIntegerOption(flag: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeIntegerOption(flag: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return parsed;
}

function requireOptionValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parseJsonFlag(value: string, flag: string): JsonValue {
  try {
    return JSON.parse(value) as JsonValue;
  } catch (error) {
    throw new Error(`${flag} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readInlinePrompt(cli: ManualTestCliOptions, label: string): Promise<string> {
  if (cli.promptFilePath) {
    const prompt = await readFile(resolve(cli.promptFilePath), 'utf-8');
    if (prompt.trim().length === 0) {
      throw new Error(`Prompt file for ${label} is empty: ${cli.promptFilePath}`);
    }
    return prompt;
  }

  const prompt = cli.goalArgs.join(' ').trim();
  if (prompt.length > 0) {
    return prompt;
  }

  if (!process.stdin.isTTY) {
    const stdinText = await Bun.stdin.text();
    if (stdinText.trim().length > 0) {
      return stdinText;
    }
  }

  throw new Error(`Missing ${label}; provide positional text, --file <path>, or stdin.`);
}

function resolveAssetPath(inputPath: string, baseDir: string): string {
  return resolve(baseDir, inputPath);
}

export async function loadBenchmarkCases(inputPath: string, cwd = process.cwd()): Promise<BenchmarkCase[]> {
  const resolvedInputPath = resolve(cwd, inputPath);
  const baseDir = dirname(resolvedInputPath);
  const content = await readFile(resolvedInputPath, 'utf-8');
  const trimmed = content.trim();
  if (!trimmed) return [];

  let rawCases: unknown[];
  if (trimmed.startsWith('[')) {
    rawCases = JSON.parse(trimmed) as unknown[];
  } else if (trimmed.startsWith('{')) {
    try {
      rawCases = [JSON.parse(trimmed) as unknown];
    } catch {
      rawCases = parseBenchmarkJsonLines(trimmed);
    }
  } else {
    rawCases = parseBenchmarkJsonLines(trimmed);
  }

  if (!Array.isArray(rawCases)) {
    throw new Error('Benchmark input must be a JSON array, JSON object, or JSONL records');
  }
  return rawCases.map((value, index) => parseBenchmarkCase(value, baseDir, `case[${index}]`));
}

export async function loadGaiaBenchmarkCases(
  inputPath: string,
  cwd = process.cwd(),
  filesDir?: string,
  split?: string,
): Promise<BenchmarkCase[]> {
  const resolvedInputPath = resolve(cwd, inputPath);
  const baseDir = filesDir ? resolve(cwd, filesDir) : dirname(resolvedInputPath);
  const rawRows = await loadBenchmarkRawRecords(resolvedInputPath);
  return rawRows.map((value, index) => parseGaiaBenchmarkCase(value, baseDir, split, `gaia[${index}]`));
}

async function loadBenchmarkRawRecords(inputPath: string): Promise<unknown[]> {
  const content = await readFile(inputPath, 'utf-8');
  const trimmed = content.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) return JSON.parse(trimmed) as unknown[];
  if (trimmed.startsWith('{')) {
    try {
      return [JSON.parse(trimmed) as unknown];
    } catch {
      return parseBenchmarkJsonLines(trimmed);
    }
  }
  return parseBenchmarkJsonLines(trimmed);
}

function parseGaiaBenchmarkCase(value: unknown, baseDir: string, split: string | undefined, label: string): BenchmarkCase {
  const raw = ensureObject(value, label);
  const id = requireString(raw.task_id ?? raw.taskId ?? raw.id, `${label}.task_id`);
  const question = requireString(raw.Question ?? raw.question, `${label}.Question`);
  const fileName = readOptionalString(raw.file_name ?? raw.fileName ?? raw.file, `${label}.file_name`);
  const level = readOptionalString(raw.Level ?? raw.level, `${label}.Level`);
  const expectedAnswer = readOptionalString(raw['Final answer'] ?? raw.final_answer ?? raw.expectedAnswer ?? raw.answer, `${label}.Final answer`);
  const attachment = fileName ? gaiaAttachmentForFile(resolve(baseDir, fileName), fileName) : undefined;
  return {
    id,
    dataset: 'gaia',
    ...(split ? { split } : {}),
    ...(level ? { level } : {}),
    question,
    ...(attachment?.kind === 'image' ? { images: [{ path: attachment.path, name: fileName }] } : {}),
    ...(attachment?.kind === 'audio'
      ? { contentParts: [{ type: 'audio' as const, audio: { source: { kind: 'path' as const, path: attachment.path }, format: attachment.format, name: fileName } }] }
      : {}),
    ...(attachment?.kind === 'file' ? { contentParts: [{ type: 'file', file: { source: { kind: 'path', path: attachment.path }, name: fileName } }] } : {}),
    ...(expectedAnswer ? { expectedAnswer } : {}),
    metadata: {
      source: 'gaia',
      ...(fileName ? { fileName } : {}),
      ...(level ? { level } : {}),
      ...(split ? { split } : {}),
    },
  };
}

function readOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  return value;
}

function gaiaAttachmentForFile(path: string, name: string): GaiaAttachment {
  if (isImageFileName(name)) return { kind: 'image', path };
  const audioFormat = inferAudioFormatFromFileName(name);
  if (audioFormat) return { kind: 'audio', path, format: audioFormat };
  return { kind: 'file', path };
}

function isImageFileName(name: string): boolean {
  return hasFileExtension(name, IMAGE_FILE_EXTENSIONS);
}

function inferAudioFormatFromFileName(name: string): Extract<ModelContentPart, { type: 'audio' }>['audio']['format'] | undefined {
  switch (extname(name).toLowerCase()) {
    case '.wav': return 'wav';
    case '.mp3': return 'mp3';
    case '.flac': return 'flac';
    case '.m4a': return 'm4a';
    case '.ogg': return 'ogg';
    case '.aac': return 'aac';
    case '.aiff':
    case '.aif': return 'aiff';
    default: return undefined;
  }
}

function benchmarkCaseHasAttachmentType(benchmarkCase: BenchmarkCase, type: BenchmarkAttachmentType): boolean {
  if (type === 'image' && (benchmarkCase.images?.length ?? 0) > 0) {
    return true;
  }

  for (const part of benchmarkCase.contentParts ?? []) {
    if (part.type === 'image' && type === 'image') return true;
    if (part.type === 'audio' && type === 'audio') return true;
    if (part.type === 'file' && inferFileAttachmentType(part.file) === type) return true;
  }

  return false;
}

export function summarizeGaiaDryRunTasks(cases: BenchmarkCase[]): GaiaDryRunTaskSummary[] {
  return cases.map((benchmarkCase) => {
    const attachment = summarizeBenchmarkCaseAttachment(benchmarkCase);
    return {
      taskId: benchmarkCase.id,
      attachmentType: attachment.type,
      ...(attachment.fileName ? { fileName: attachment.fileName } : {}),
      ...(attachment.path ? { path: attachment.path } : {}),
      ...(benchmarkCase.level ? { level: benchmarkCase.level } : {}),
      ...(benchmarkCase.split ? { split: benchmarkCase.split } : {}),
    };
  });
}

function summarizeBenchmarkCaseAttachment(
  benchmarkCase: BenchmarkCase,
): { type: BenchmarkDryRunAttachmentType; fileName?: string; path?: string } {
  const image = benchmarkCase.images?.[0];
  if (image) {
    return {
      type: 'image',
      ...(image.name ? { fileName: image.name } : {}),
      path: image.path,
    };
  }

  for (const part of benchmarkCase.contentParts ?? []) {
    if (part.type === 'image') {
      return {
        type: 'image',
        ...(part.image.name ? { fileName: part.image.name } : {}),
        path: part.image.path,
      };
    }
    if (part.type === 'audio') {
      const path = pathFromAudioInputSource(part.audio.source);
      return {
        type: 'audio',
        ...(part.audio.name ? { fileName: part.audio.name } : {}),
        ...(path ? { path } : {}),
      };
    }
    if (part.type === 'file') {
      const path = pathFromFileInputSource(part.file.source);
      return {
        type: inferFileAttachmentType(part.file),
        ...(part.file.name ? { fileName: part.file.name } : {}),
        ...(path ? { path } : {}),
      };
    }
  }

  return { type: 'none' };
}

function inferFileAttachmentType(file: Extract<ModelContentPart, { type: 'file' }>['file']): BenchmarkAttachmentType {
  return inferAttachmentType(file.mimeType, file.name ?? nameFromFileInputSource(file.source));
}

function inferAttachmentType(mimeType: string | undefined, name: string | undefined): BenchmarkAttachmentType {
  const normalizedMimeType = mimeType?.split(';', 1)[0]?.trim().toLowerCase();
  if (normalizedMimeType?.startsWith('image/')) return 'image';
  if (normalizedMimeType?.startsWith('audio/')) return 'audio';
  if (normalizedMimeType?.startsWith('video/')) return 'video';

  if (name) {
    if (hasFileExtension(name, IMAGE_FILE_EXTENSIONS)) return 'image';
    if (hasFileExtension(name, AUDIO_FILE_EXTENSIONS)) return 'audio';
    if (hasFileExtension(name, VIDEO_FILE_EXTENSIONS)) return 'video';
  }

  return 'other';
}

function nameFromFileInputSource(source: Extract<ModelContentPart, { type: 'file' }>['file']['source']): string | undefined {
  return pathFromFileInputSource(source);
}

function pathFromFileInputSource(source: Extract<ModelContentPart, { type: 'file' }>['file']['source']): string | undefined {
  if (source.kind === 'path') return source.path;
  if (source.kind === 'url') {
    try {
      return new URL(source.url).pathname;
    } catch {
      return source.url;
    }
  }
  return undefined;
}

function pathFromAudioInputSource(source: Extract<ModelContentPart, { type: 'audio' }>['audio']['source']): string | undefined {
  if (source.kind === 'path') return source.path;
  if (source.kind === 'url') {
    try {
      return new URL(source.url).pathname;
    } catch {
      return source.url;
    }
  }
  return undefined;
}

function hasFileExtension(name: string, extensions: ReadonlySet<string>): boolean {
  return extensions.has(extname(name).toLowerCase());
}

function parseBenchmarkJsonLines(content: string): unknown[] {
  return content.split(/\r?\n/).filter((line) => line.trim().length > 0).map((line, index) => {
        try {
          return JSON.parse(line) as unknown;
        } catch (error) {
          throw new Error(`Invalid benchmark JSONL at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
}

function parseBenchmarkCase(value: unknown, baseDir: string, label: string): BenchmarkCase {
  const raw = ensureObject(value, label);
  const id = requireString(raw.id ?? raw.taskId ?? raw.task_id, `${label}.id`);
  const question = requireString(raw.question, `${label}.question`);
  const images = parseOptionalImageArray(raw.images, baseDir, `${label}.images`);
  const contentParts = parseOptionalContentPartArray(raw.contentParts, baseDir, `${label}.contentParts`);
  if (images && contentParts?.some((part) => part.type === 'image')) {
    throw new Error(`${label} must not include both images and image content parts`);
  }
  return {
    id,
    ...(raw.dataset === undefined ? {} : { dataset: requireString(raw.dataset, `${label}.dataset`) }),
    ...(raw.split === undefined ? {} : { split: requireString(raw.split, `${label}.split`) }),
    ...(raw.level === undefined ? {} : { level: requireString(raw.level, `${label}.level`) }),
    question,
    ...(raw.input === undefined ? {} : { input: raw.input as JsonValue }),
    ...(images ? { images } : {}),
    ...(contentParts ? { contentParts } : {}),
    ...(raw.expectedAnswer === undefined ? {} : { expectedAnswer: requireString(raw.expectedAnswer, `${label}.expectedAnswer`) }),
    ...(raw.metadata === undefined ? {} : { metadata: parseOptionalRecord(raw.metadata, `${label}.metadata`) }),
  };
}

async function readCompletedBenchmarkIds(outputPath: string): Promise<Set<string>> {
  const completed = new Set<string>();
  let content = '';
  try {
    content = await readFile(outputPath, 'utf-8');
  } catch {
    return completed;
  }
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const record = ensureObject(JSON.parse(line) as unknown, `result[${index}]`);
      if (record.status === 'completed' && typeof record.taskId === 'string') {
        completed.add(record.taskId);
      }
    } catch {
      // Ignore malformed historical result lines so a partially written file does not block resume.
    }
  }
  return completed;
}

export function selectBenchmarkCases(cases: BenchmarkCase[], cli: ManualTestCliOptions, completedIds: Set<string>): BenchmarkCase[] {
  const allowedIds = cli.evalIds ? new Set(cli.evalIds) : undefined;
  let selected = cases.slice(cli.evalOffset).filter((benchmarkCase) => {
    if (allowedIds && !allowedIds.has(benchmarkCase.id)) return false;
    if (cli.evalLevel && benchmarkCase.level !== cli.evalLevel) return false;
    if (cli.evalSplit && benchmarkCase.split && benchmarkCase.split !== cli.evalSplit) return false;
    if (cli.evalType && !benchmarkCaseHasAttachmentType(benchmarkCase, cli.evalType)) return false;
    if (completedIds.has(benchmarkCase.id)) return false;
    return true;
  });
  if (cli.evalLimit !== undefined) {
    selected = selected.slice(0, cli.evalLimit);
  }
  return selected;
}

function validateEvalSwarmRuntime(resolvedConfig: Awaited<ReturnType<typeof loadAgentSdkConfig>>): void {
  if (resolvedConfig.interaction.approvalMode === 'manual' || resolvedConfig.interaction.clarificationMode === 'interactive') {
    throw new Error('--swarm > 1 requires non-interactive eval settings; use --approval auto|reject and --clarification fail');
  }
}

async function runBenchmarkCase(options: {
  sdk: Awaited<ReturnType<typeof createAgentSdk>>;
  benchmarkCase: BenchmarkCase;
  resolvedConfig: Awaited<ReturnType<typeof loadAgentSdkConfig>>;
  outputPath: string;
  artifactsDir?: string;
  eventLog: Array<Record<string, JsonValue>>;
  orchestrationSdk?: OrchestrationSdk;
  includeEventArtifacts?: boolean;
}): Promise<BenchmarkResultRecord> {
  const startedAt = new Date();
  const eventStartIndex = options.eventLog.length;
  const runOptions = buildRunOptions({
    mode: 'run',
    goal: options.benchmarkCase.question,
    input: options.benchmarkCase.input,
    images: options.benchmarkCase.images,
    contentParts: options.benchmarkCase.contentParts,
    metadata: {
      dataset: options.benchmarkCase.dataset ?? 'cases',
      taskId: options.benchmarkCase.id,
      ...(options.benchmarkCase.metadata ?? {}),
    },
  });

  try {
    const orchestrated = options.orchestrationSdk
      ? await options.orchestrationSdk.runRaw(options.benchmarkCase.question, runOptions)
      : undefined;
    const result = orchestrated?.finalResult ?? await options.sdk.run(options.benchmarkCase.question, runOptions);
    const finishedAt = new Date();
    const artifacts = await writeBenchmarkArtifacts(options, result, eventStartIndex);
    return {
      schemaVersion: 1,
      dataset: options.benchmarkCase.dataset ?? 'cases',
      taskId: options.benchmarkCase.id,
      ...(options.benchmarkCase.level ? { level: options.benchmarkCase.level } : {}),
      status: isSuccessfulResult(result) ? 'completed' : 'failed',
      runId: result.runId,
      question: options.benchmarkCase.question,
      ...(isSuccessfulResult(result) ? { prediction: result.output, predictionText: stringifyPrediction(result.output) } : {}),
      ...(options.benchmarkCase.expectedAnswer ? { expectedAnswer: options.benchmarkCase.expectedAnswer } : {}),
      ...('usage' in result ? { usage: result.usage as unknown as JsonValue } : {}),
      timings: { startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), durationMs: finishedAt.getTime() - startedAt.getTime() },
      model: { provider: options.resolvedConfig.model.provider, model: options.resolvedConfig.model.model },
      runtime: { mode: options.resolvedConfig.runtime.mode },
      ...(artifacts ? { artifacts } : {}),
      ...(!isSuccessfulResult(result) && result.status === 'failure' ? { error: { message: result.error, code: isModelTimeoutLike(result.error) ? 'model_timeout' : result.code } } : {}),
      metadata: options.benchmarkCase.metadata ?? {},
    };
  } catch (error) {
    const finishedAt = new Date();
    const artifacts = await writeBenchmarkArtifacts(options, { error: error instanceof Error ? error.message : String(error) }, eventStartIndex);
    return {
      schemaVersion: 1,
      dataset: options.benchmarkCase.dataset ?? 'cases',
      taskId: options.benchmarkCase.id,
      ...(options.benchmarkCase.level ? { level: options.benchmarkCase.level } : {}),
      status: 'failed',
      question: options.benchmarkCase.question,
      ...(options.benchmarkCase.expectedAnswer ? { expectedAnswer: options.benchmarkCase.expectedAnswer } : {}),
      timings: { startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), durationMs: finishedAt.getTime() - startedAt.getTime() },
      model: { provider: options.resolvedConfig.model.provider, model: options.resolvedConfig.model.model },
      runtime: { mode: options.resolvedConfig.runtime.mode },
      ...(artifacts ? { artifacts } : {}),
      error: {
        message: error instanceof Error ? error.message : String(error),
        ...(isModelTimeoutLike(error) ? { code: 'model_timeout' } : {}),
      },
      metadata: options.benchmarkCase.metadata ?? {},
    };
  }
}

function installEvalProcessErrorGuard(): () => void {
  const onUncaughtException = (error: Error) => {
    if (isModelTimeoutLike(error)) {
      console.error(`warning: captured unhandled model timeout during eval: ${error.message}`);
      return;
    }
    throw error;
  };
  const onUnhandledRejection = (reason: unknown) => {
    if (isModelTimeoutLike(reason)) {
      console.error(`warning: captured unhandled model timeout during eval: ${reason instanceof Error ? reason.message : String(reason)}`);
      return;
    }
    throw reason;
  };
  process.on('uncaughtException', onUncaughtException);
  process.on('unhandledRejection', onUnhandledRejection);
  return () => {
    process.off('uncaughtException', onUncaughtException);
    process.off('unhandledRejection', onUnhandledRejection);
  };
}

function isModelTimeoutLike(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return String(error).toLowerCase().includes('model timed out');
  }
  const name = error.name.toLowerCase();
  const message = error.message.toLowerCase();
  return name.includes('timeout') || message.includes('model timed out') || message.includes('model timeout');
}

async function writeBenchmarkArtifacts(
  options: { sdk: Awaited<ReturnType<typeof createAgentSdk>>; benchmarkCase: BenchmarkCase; artifactsDir?: string; eventLog: Array<Record<string, JsonValue>>; includeEventArtifacts?: boolean },
  output: unknown,
  eventStartIndex: number,
): Promise<BenchmarkResultRecord['artifacts'] | undefined> {
  if (!options.artifactsDir) return undefined;
  const taskDir = resolve(options.artifactsDir, safePathSegment(options.benchmarkCase.id));
  await mkdir(taskDir, { recursive: true });
  const inputPath = resolve(taskDir, 'input.json');
  const outputPath = resolve(taskDir, 'output.json');
  const eventLogPath = options.includeEventArtifacts === false ? undefined : resolve(taskDir, 'events.jsonl');
  const answerPath = resolve(taskDir, 'answer.txt');
  await writeFile(inputPath, JSON.stringify(options.benchmarkCase, null, 2));
  await writeFile(outputPath, JSON.stringify(output, null, 2));
  if (eventLogPath) {
    const events = options.eventLog.slice(eventStartIndex);
    await writeFile(eventLogPath, events.map((event) => JSON.stringify(event)).join('\n') + (events.length > 0 ? '\n' : ''));
  }
  if (typeof output === 'object' && output && 'output' in output) {
    await writeFile(answerPath, stringifyPrediction((output as { output?: unknown }).output));
  }
  return { input: inputPath, output: outputPath, ...(eventLogPath ? { eventLog: eventLogPath } : {}), answer: answerPath };
}

function stringifyPrediction(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function appendJsonLine(path: string, value: JsonValue): Promise<void> {
  await appendFile(path, `${JSON.stringify(value)}\n`);
}

function printEvalRecord(
  record: BenchmarkResultRecord,
  caseIndex: number,
  cli: ManualTestCliOptions,
  colors?: RunColorRegistry,
): void {
  if (cli.output === 'json' || cli.output === 'jsonl') {
    console.log(JSON.stringify(record));
    return;
  }
  const countPrefix = cli.evalDataset === 'gaia' ? `${caseIndex + 1} : ` : '';
  const line = `${countPrefix}${record.status === 'completed' ? '✓' : '✗'} ${record.taskId}${record.runId ? ` run=${record.runId}` : ''}`;
  console.log(colors?.colorize(record.runId, line) ?? line);
}

function collectContentParts(spec: ManualTestSpec): ModelContentPart[] {
  if (spec.mode === 'run') {
    return [
      ...(spec.contentParts ?? []),
      ...((spec.images ?? []).map((image) => ({ type: 'image', image }) satisfies ModelContentPart)),
    ];
  }

  return spec.messages.flatMap((message) => {
    if (Array.isArray(message.content)) {
      return message.content;
    }
    return (message.images ?? []).map((image) => ({ type: 'image', image }) satisfies ModelContentPart);
  });
}

function summarizeSpec(spec: ManualTestSpec): ManualTestSummary {
  const summary: ManualTestSummary = {
    textParts: 0,
    imageParts: 0,
    fileParts: 0,
    audioParts: 0,
    legacyImages: 0,
    messageCount: spec.mode === 'chat' ? spec.messages.length : 1,
  };

  if (spec.mode === 'chat') {
    for (const message of spec.messages) {
      if (typeof message.content === 'string') {
        if (message.content.trim().length > 0) summary.textParts += 1;
      } else {
        for (const part of message.content) incrementSummary(summary, part);
      }
      summary.legacyImages += message.images?.length ?? 0;
    }
  } else {
    summary.legacyImages += spec.images?.length ?? 0;
    for (const part of spec.contentParts ?? []) incrementSummary(summary, part);
  }

  return summary;
}

function incrementSummary(summary: ManualTestSummary, part: ModelContentPart): void {
  switch (part.type) {
    case 'text':
      summary.textParts += 1;
      break;
    case 'image':
      summary.imageParts += 1;
      break;
    case 'file':
      summary.fileParts += 1;
      break;
    case 'audio':
      summary.audioParts += 1;
      break;
  }
}

function summarizeCli(cli: ManualTestCliOptions): Record<string, JsonValue> {
  return {
    command: cli.command,
    ...(cli.specPath ? { specPath: resolve(cli.specPath) } : {}),
    ...(cli.promptFilePath ? { promptFilePath: resolve(cli.promptFilePath) } : {}),
    ...(cli.imagePaths.length > 0 ? { imagePaths: cli.imagePaths.map((path) => resolve(path)) } : {}),
    ...(cli.audioPaths.length > 0 ? { audioPaths: cli.audioPaths.map((path) => resolve(path)) } : {}),
    ...(cli.fileAttachmentPaths.length > 0 ? { fileAttachmentPaths: cli.fileAttachmentPaths.map((path) => resolve(path)) } : {}),
    orchestrate: cli.orchestrate,
    ...(cli.agentCatalogPaths.length > 0 ? { agentCatalogPaths: cli.agentCatalogPaths.map((path) => resolve(path)) } : {}),
    ...(cli.workerCatalogPaths.length > 0 ? { workerCatalogPaths: cli.workerCatalogPaths.map((path) => resolve(path)) } : {}),
    ...(cli.qualityAgentPath ? { qualityAgentPath: resolve(cli.qualityAgentPath) } : {}),
    ...(cli.synthesizerAgentPath ? { synthesizerAgentPath: resolve(cli.synthesizerAgentPath) } : {}),
    ...(cli.maxWorkers ? { maxWorkers: cli.maxWorkers } : {}),
    ...(cli.sessionId ? { sessionId: cli.sessionId } : {}),
    ...(cli.runId ? { runId: cli.runId } : {}),
    ...(cli.evalDataset ? { evalDataset: cli.evalDataset } : {}),
    ...(cli.evalInputPath ? { evalInputPath: resolve(cli.evalInputPath) } : {}),
    ...(cli.evalFilesDir ? { evalFilesDir: resolve(cli.evalFilesDir) } : {}),
    ...(cli.evalOutputPath ? { evalOutputPath: resolve(cli.evalOutputPath) } : {}),
    ...(cli.evalArtifactsDir ? { evalArtifactsDir: resolve(cli.evalArtifactsDir) } : {}),
    evalSwarm: cli.evalSwarm,
    ...(cli.evalLimit ? { evalLimit: cli.evalLimit } : {}),
    ...(cli.evalOffset ? { evalOffset: cli.evalOffset } : {}),
    ...(cli.evalIds ? { evalIds: cli.evalIds } : {}),
    ...(cli.evalLevel ? { evalLevel: cli.evalLevel } : {}),
    ...(cli.evalSplit ? { evalSplit: cli.evalSplit } : {}),
    ...(cli.evalType ? { evalType: cli.evalType } : {}),
    evalResume: cli.evalResume,
    evalFailFast: cli.evalFailFast,
    ...(cli.mode ? { modeOverride: cli.mode } : {}),
    ...(cli.cwd ? { cwd: resolve(cli.cwd) } : {}),
    ...(cli.agentConfigPath ? { agentConfigPath: resolve(cli.agentConfigPath) } : {}),
    ...(cli.settingsConfigPath ? { settingsConfigPath: resolve(cli.settingsConfigPath) } : {}),
    ...(cli.runtimeMode ? { runtimeMode: cli.runtimeMode } : {}),
    ...(cli.provider ? { provider: cli.provider } : {}),
    ...(cli.model ? { model: cli.model } : {}),
    ...(cli.approvalMode ? { approvalMode: cli.approvalMode } : {}),
    ...(cli.clarificationMode ? { clarificationMode: cli.clarificationMode } : {}),
    progress: cli.progress,
    events: cli.events,
    inspect: cli.inspect,
    showLines: cli.showLines,
    dryRun: cli.dryRun,
    output: cli.output,
  };
}

function summarizeResolvedConfig(
  resolvedConfig: Awaited<ReturnType<typeof loadAgentSdkConfig>>,
  spec: ManualTestSpec,
): Record<string, JsonValue> {
  const summary = summarizeSpec(spec);
  return {
    agentId: resolvedConfig.agent.id,
    agentName: resolvedConfig.agent.name,
    provider: resolvedConfig.model.provider,
    model: resolvedConfig.model.model,
    runtimeMode: resolvedConfig.runtime.mode,
    requestedRuntimeMode: resolvedConfig.runtime.requestedMode,
    autoMigrate: resolvedConfig.runtime.autoMigrate,
    workspaceRoot: resolvedConfig.workspaceRoot,
    shellCwd: resolvedConfig.shellCwd,
    approvalMode: resolvedConfig.interaction.approvalMode,
    clarificationMode: resolvedConfig.interaction.clarificationMode,
    agentSearchDirs: resolvedConfig.agents.dirs,
    skillSearchDirs: resolvedConfig.skills.dirs,
    mode: spec.mode,
    messageCount: summary.messageCount,
    textParts: summary.textParts,
    imageParts: summary.imageParts,
    fileParts: summary.fileParts,
    audioParts: summary.audioParts,
    legacyImages: summary.legacyImages,
  };
}

function summarizeResult(result: RunResult | ChatResult): JsonValue {
  if (result.status === 'success') {
    return {
      status: result.status,
      runId: result.runId,
      stepsUsed: result.stepsUsed,
      usage: result.usage as unknown as JsonValue,
      output: result.output,
      ...(result.planId ? { planId: result.planId } : {}),
    };
  }
  if (result.status === 'failure') {
    return {
      status: result.status,
      runId: result.runId,
      code: result.code,
      error: result.error,
      stepsUsed: result.stepsUsed,
      usage: result.usage as unknown as JsonValue,
    };
  }
  return {
    status: result.status,
    runId: result.runId,
    message: result.message,
    ...('toolName' in result ? { toolName: result.toolName } : {}),
    ...('suggestedQuestions' in result && result.suggestedQuestions ? { suggestedQuestions: result.suggestedQuestions as unknown as JsonValue } : {}),
  };
}

function parseSwarmSubtasks(output: JsonValue): SwarmSubtask[] {
  const raw = isRecordValue(output) && Array.isArray(output.subtasks)
    ? output.subtasks
    : Array.isArray(output) ? output : undefined;
  if (!raw || raw.length === 0) throw new Error('Coordinator produced no subtasks');
  return raw.map((item, index) => {
    if (!isRecordValue(item)) throw new Error(`Coordinator subtask ${index + 1} is not an object`);
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const subObjective = typeof item.subObjective === 'string' ? item.subObjective.trim() : '';
    if (!id) throw new Error(`Coordinator subtask ${index + 1} is missing id`);
    if (!subObjective) throw new Error(`Coordinator subtask ${id} is missing subObjective`);
    return {
      id,
      subObjective,
      ...(isJsonValueLike(item.input) ? { input: item.input } : {}),
      ...(Array.isArray(item.attachmentRefs) ? { attachmentRefs: item.attachmentRefs.filter((ref): ref is string => typeof ref === 'string' && ref.length > 0) } : {}),
      ...(typeof item.targetAgentId === 'string' && item.targetAgentId.length > 0 ? { targetAgentId: item.targetAgentId } : {}),
      ...(isJsonRecordLike(item.metadata) ? { metadata: item.metadata } : {}),
    };
  });
}

function validateSdkDecomposition(subtasks: SwarmSubtask[], validWorkerIds: string[]): void {
  const ids = new Set<string>();
  const validWorkers = new Set(validWorkerIds);
  const issues: string[] = [];
  for (const subtask of subtasks) {
    if (ids.has(subtask.id)) issues.push(`duplicate subtask id: ${subtask.id}`);
    ids.add(subtask.id);
    if (!subtask.targetAgentId) issues.push(`subtask ${subtask.id} is missing targetAgentId`);
    else if (!validWorkers.has(subtask.targetAgentId)) issues.push(`subtask ${subtask.id} targets unknown worker agent: ${subtask.targetAgentId}`);
  }
  if (issues.length > 0) throw new Error(`Invalid swarm decomposition: ${issues.join('; ')}. Valid worker ids: ${validWorkerIds.join(', ')}`);
}

function roleAgentConfig(base: AgentConfigFile, role: 'quality' | 'synthesizer'): AgentConfigFile {
  const roleInstructions = role === 'quality'
    ? 'Swarm quality role: assess worker outputs against the top-level objective and return structured assessments.'
    : 'Swarm synthesizer role: synthesize one final answer from worker outputs and quality assessments.';
  return {
    ...base,
    id: `${base.id}-${role}`,
    name: `${base.name} ${role}`,
    systemInstructions: [base.systemInstructions, roleInstructions].filter(Boolean).join('\n\n'),
  };
}

async function loadFlaggedAgentSdkConfig(
  baseOptions: AgentSdkOptions,
  flagName: '--agent' | '--worker-catalog' | '--quality-agent' | '--synthesizer-agent',
  agentConfigPath: string,
): Promise<Awaited<ReturnType<typeof loadAgentSdkConfig>>> {
  try {
    return await loadAgentSdkConfig({ ...baseOptions, agentConfigPath });
  } catch (error) {
    throw contextualAgentLoadError(flagName, agentConfigPath, error);
  }
}

async function createFlaggedAgentSdk(
  options: AgentSdkOptions,
  flagName: '--agent' | '--worker-catalog' | '--quality-agent' | '--synthesizer-agent',
  agentConfigPath: string,
): Promise<Awaited<ReturnType<typeof createAgentSdk>>> {
  try {
    return await createAgentSdk(options);
  } catch (error) {
    throw contextualAgentLoadError(flagName, agentConfigPath, error);
  }
}

function contextualAgentLoadError(flagName: string, value: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const wrapped = new Error(`Unable to load ${flagName} agent "${value}": ${message}`);
  if (error instanceof Error) {
    wrapped.stack = `${wrapped.stack ?? wrapped.message}\nCaused by: ${error.stack ?? error.message}`;
  }
  return wrapped;
}

function summarizeSwarmRun(result: SwarmRunResult, workerIds: string[], cli: ManualTestCliOptions, subtasks: SwarmSubtask[]): JsonValue {
  return {
    command: 'swarm-run',
    sessionId: result.sessionId,
    coordinatorRunId: result.coordinatorRunId,
    status: result.status,
    workerAgentIds: workerIds,
    maxWorkers: cli.maxWorkers ?? null,
    subtasks: subtasks as unknown as JsonValue,
    defaultsUsed: {
      qualityAgent: cli.qualityAgentPath ? 'explicit' : 'coordinator_with_quality_instructions',
      synthesizerAgent: cli.synthesizerAgentPath ? 'explicit' : 'coordinator_with_synthesis_instructions',
    },
    subtaskResults: result.subtaskResults as unknown as JsonValue,
    qualityRunId: result.qualityRunId ?? null,
    synthesizerRunId: result.synthesizerRunId ?? null,
    qualityAssessments: (result.qualityAssessments ?? []) as unknown as JsonValue,
    output: result.output,
    errorCode: result.errorCode ?? null,
    errorMessage: result.errorMessage ?? null,
    diagnostics: result.diagnostics ?? null,
  } as JsonValue;
}

function summarizeSwarmRetry(result: SwarmRetryResult): JsonValue {
  return {
    command: 'retry',
    retryTarget: 'swarm-session',
    sessionId: result.sessionId,
    coordinatorRunId: result.coordinatorRunId,
    status: result.status,
    retriedWorkerRunIds: result.retriedWorkerRunIds,
    skippedWorkerRunIds: result.skippedWorkerRunIds as unknown as JsonValue,
    subtaskResults: result.subtaskResults as unknown as JsonValue,
    qualityRunId: result.qualityRunId ?? null,
    synthesizerRunId: result.synthesizerRunId ?? null,
    qualityAssessments: (result.qualityAssessments ?? []) as unknown as JsonValue,
    output: result.output,
    errorCode: result.errorCode ?? null,
    errorMessage: result.errorMessage ?? null,
  } as JsonValue;
}

function printSwarmExecutionPlan(sessionId: string, coordinatorRunId: string, subtasks: SwarmSubtask[]): void {
  console.log(formatSwarmExecutionPlan(sessionId, coordinatorRunId, subtasks));
  console.log('');
}

export function formatSwarmExecutionPlan(sessionId: string, coordinatorRunId: string, subtasks: readonly SwarmSubtask[]): string {
  return [
    `orchestration: session=${sessionId} coordinator=${coordinatorRunId}`,
    formatSwarmSubtasks(subtasks),
  ].join('\n');
}

export function formatSwarmSubtasks(subtasks: readonly SwarmSubtask[]): string {
  const lines = ['subtasks:'];
  for (const [index, subtask] of subtasks.entries()) {
    const target = subtask.targetAgentId ? ` -> ${subtask.targetAgentId}` : '';
    lines.push(`  ${index + 1}. ${subtask.id}${target}: ${subtask.subObjective}`);
  }
  return lines.join('\n');
}

function printSwarmResult(result: SwarmRunResult, workerIds: string[], cli: ManualTestCliOptions): void {
  console.log(`orchestration: session=${result.sessionId} coordinator=${result.coordinatorRunId}`);
  console.log(`workers: ${workerIds.join(', ')} (max ${cli.maxWorkers ?? 'default'})`);
  console.log(`runs: workers=${result.subtaskResults.map((subtask) => `${subtask.subtaskId}:${subtask.runId}:${subtask.status}`).join(', ') || '(none)'}`);
  if (result.qualityRunId) console.log(`qualityRunId: ${result.qualityRunId}`);
  if (result.synthesizerRunId) console.log(`synthesizerRunId: ${result.synthesizerRunId}`);
  if (result.status === 'succeeded') {
    console.log(renderPrettyString(typeof result.output === 'string' ? result.output : JSON.stringify(result.output, null, 2)));
  } else {
    console.error(`swarm-run failed: ${result.errorCode ?? 'UNKNOWN'} ${result.errorMessage ?? ''}`.trim());
  }
}

function printSwarmRetryResult(result: SwarmRetryResult): void {
  console.log(`retry: session=${result.sessionId} coordinator=${result.coordinatorRunId}`);
  console.log(`workers retried: ${result.retriedWorkerRunIds.join(', ') || '(none)'}`);
  if (result.skippedWorkerRunIds.length > 0) {
    console.log(`workers skipped: ${result.skippedWorkerRunIds.map((entry) => `${entry.runId}:${entry.reason}`).join(', ')}`);
  }
  console.log(`runs: workers=${result.subtaskResults.map((subtask) => `${subtask.subtaskId}:${subtask.runId}:${subtask.status}`).join(', ') || '(none)'}`);
  if (result.qualityRunId) console.log(`qualityRunId: ${result.qualityRunId}`);
  if (result.synthesizerRunId) console.log(`synthesizerRunId: ${result.synthesizerRunId}`);
  if (result.status === 'succeeded') {
    console.log(renderPrettyString(typeof result.output === 'string' ? result.output : JSON.stringify(result.output, null, 2)));
  } else {
    console.error(`retry failed: ${result.errorCode ?? 'UNKNOWN'} ${result.errorMessage ?? ''}`.trim());
  }
}

function printSwarmDryRun(
  cli: ManualTestCliOptions,
  coordinatorConfig: Awaited<ReturnType<typeof loadAgentSdkConfig>>,
  workerConfigs: Array<Awaited<ReturnType<typeof loadAgentSdkConfig>>>,
  qualityConfig: Awaited<ReturnType<typeof loadAgentSdkConfig>>,
  synthesizerConfig: Awaited<ReturnType<typeof loadAgentSdkConfig>>,
): void {
  const output = {
    dryRun: true,
    cli: summarizeCli(cli),
    coordinator: summarizeSwarmAgentConfig(coordinatorConfig, 'coordinator', 'explicit'),
    workers: workerConfigs.map((config) => summarizeSwarmAgentConfig(config, 'worker', 'explicit')),
    quality: summarizeSwarmAgentConfig(qualityConfig, 'quality', cli.qualityAgentPath ? 'explicit' : 'derived'),
    synthesizer: summarizeSwarmAgentConfig(synthesizerConfig, 'synthesizer', cli.synthesizerAgentPath ? 'explicit' : 'derived'),
    defaultsUsed: {
      qualityAgent: cli.qualityAgentPath ? 'explicit' : 'coordinator_with_quality_instructions',
      synthesizerAgent: cli.synthesizerAgentPath ? 'explicit' : 'coordinator_with_synthesis_instructions',
    },
    maxWorkers: cli.maxWorkers ?? null,
  } satisfies JsonValue;
  if (cli.output === 'json') console.log(JSON.stringify(output, null, 2));
  else if (cli.output === 'jsonl') console.log(JSON.stringify(output));
  else {
    console.log('# Swarm dry run');
    printSwarmAgentConfigSummary('coordinator', coordinatorConfig, 'explicit');
    for (const workerConfig of workerConfigs) {
      printSwarmAgentConfigSummary('worker', workerConfig, 'explicit');
    }
    printSwarmAgentConfigSummary('quality', qualityConfig, cli.qualityAgentPath ? 'explicit' : 'derived');
    printSwarmAgentConfigSummary('synthesizer', synthesizerConfig, cli.synthesizerAgentPath ? 'explicit' : 'derived');
    console.log(`maxWorkers: ${cli.maxWorkers ?? 'default'}`);
  }
}

function summarizeSwarmAgentConfig(
  resolvedConfig: Awaited<ReturnType<typeof loadAgentSdkConfig>>,
  role: 'coordinator' | 'worker' | 'quality' | 'synthesizer',
  source: 'explicit' | 'derived',
): JsonValue {
  return {
    role,
    source,
    agentId: resolvedConfig.agent.id,
    agentName: resolvedConfig.agent.name,
    description: resolvedConfig.agent.description ?? null,
    provider: resolvedConfig.model.provider,
    model: resolvedConfig.model.model,
    runtimeMode: resolvedConfig.runtime.mode,
    requestedRuntimeMode: resolvedConfig.runtime.requestedMode,
    workspaceRoot: resolvedConfig.workspaceRoot,
    shellCwd: resolvedConfig.shellCwd,
    approvalMode: resolvedConfig.interaction.approvalMode,
    clarificationMode: resolvedConfig.interaction.clarificationMode,
    tools: resolvedConfig.agent.tools,
    delegates: resolvedConfig.agent.delegates ?? [],
  } satisfies JsonValue;
}

function printSwarmAgentConfigSummary(
  label: string,
  resolvedConfig: Awaited<ReturnType<typeof loadAgentSdkConfig>>,
  source: 'explicit' | 'derived',
): void {
  console.log(`${label}: ${resolvedConfig.agent.id} (${resolvedConfig.agent.name}) [${source}]`);
  console.log(`  model: ${resolvedConfig.model.provider}/${resolvedConfig.model.model}`);
  console.log(`  runtime: ${resolvedConfig.runtime.mode} (requested ${resolvedConfig.runtime.requestedMode})`);
  console.log(`  workspace: ${resolvedConfig.workspaceRoot}`);
  console.log(`  shellCwd: ${resolvedConfig.shellCwd}`);
  console.log(`  approval: ${resolvedConfig.interaction.approvalMode}`);
  console.log(`  clarification: ${resolvedConfig.interaction.clarificationMode}`);
  console.log(`  agentSearchDirs: ${formatNameList(resolvedConfig.agents.dirs)}`);
  console.log(`  tools: ${formatNameList(resolvedConfig.agent.tools)}`);
  console.log(`  delegates: ${formatNameList(resolvedConfig.agent.delegates ?? [])}`);
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonRecordLike(value: unknown): value is Record<string, JsonValue> {
  return isRecordValue(value) && Object.values(value).every(isJsonValueLike);
}

function isJsonValueLike(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.every(isJsonValueLike);
  return isJsonRecordLike(value);
}

function summarizeOrchestration(result: OrchestratedRunResult): JsonValue {
  return {
    sessionId: result.sessionId,
    requestedAgentId: result.requestedAgentId,
    detectedModalities: result.detectedModalities,
    executionShape: result.executionShape,
    routingReason: result.plan.routingReason,
    routingDiagnostics: result.plan.routingDiagnostics as unknown as JsonValue,
    finalNodeId: result.plan.finalNodeId,
    stages: result.stages.map((stage) => ({
      nodeId: stage.nodeId,
      stage: stage.stage,
      agentId: stage.agentId,
      runId: stage.runId,
      rootRunId: stage.rootRunId,
      status: stage.result.status,
    })),
  };
}

async function summarizeInspection(sdk: Awaited<ReturnType<typeof createAgentSdk>>, runId: string): Promise<InspectionSummary> {
  const inspection = await sdk.inspect(runId);
  const eventTypes = inspection.events.reduce<Record<string, number>>((counts, event) => {
    counts[event.type] = (counts[event.type] ?? 0) + 1;
    return counts;
  }, {});
  return {
    run: inspection.run,
    eventCount: inspection.events.length,
    eventTypes,
  };
}

function isSuccessfulResult(result: RunResult | ChatResult): result is Extract<RunResult | ChatResult, { status: 'success' }> {
  return result.status === 'success';
}

function shouldListenForCliEvents(cli: ManualTestCliOptions): boolean {
  return cli.events || cli.progress;
}

function summarizeEvent(event: { type: string; runId: string; stepId?: string; toolCallId?: string; payload: JsonValue; createdAt: string }): Record<string, JsonValue> {
  return {
    type: event.type,
    runId: event.runId,
    ...(event.stepId ? { stepId: event.stepId } : {}),
    ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
    createdAt: event.createdAt,
    payload: summarizeEventPayload(event.payload),
  };
}

function summarizeOrchestrationLifecycleEvent(event: OrchestrationLifecycleEvent): Record<string, JsonValue> {
  return {
    type: event.type,
    sessionId: event.sessionId,
    requestedAgentId: event.requestedAgentId,
    createdAt: event.createdAt,
    ...('executionShape' in event ? { executionShape: event.executionShape } : {}),
    ...('detectedModalities' in event ? { detectedModalities: event.detectedModalities } : {}),
    ...('routingReason' in event ? { routingReason: event.routingReason } : {}),
    ...('nodes' in event ? { nodes: event.nodes as unknown as JsonValue } : {}),
    ...('nodeId' in event ? { nodeId: event.nodeId, agentId: event.agentId, stage: event.stage } : {}),
    ...('runId' in event ? { runId: event.runId, rootRunId: event.rootRunId } : {}),
    ...('finalRunId' in event ? { finalRunId: event.finalRunId } : {}),
    ...('status' in event ? { status: event.status } : {}),
  };
}

function summarizeEventPayload(payload: JsonValue): JsonValue {
  if (typeof payload !== 'object' || payload === null) {
    return payload;
  }
  const objectPayload = payload as JsonObject;
  const summary: JsonObject = {};
  for (const [key, value] of Object.entries(objectPayload)) {
    if (key === 'input' || key === 'output' || key === 'messages') {
      summary[key] = '[omitted]';
      continue;
    }
    summary[key] = value;
  }
  return summary;
}

const ASSISTANT_CONTENT_PROGRESS_EVENT_TYPES = new Set([
  'tool.started',
  'approval.requested',
  'delegate.spawned',
]);

class RunColorRegistry {
  private readonly stylesByRunId = new Map<string, TuiTextStyleName>();

  colorize(runId: string | undefined, value: string): string {
    if (!runId) return value;
    return applyNamedStyle(value, this.styleForRun(runId));
  }

  private styleForRun(runId: string): TuiTextStyleName {
    const cached = this.stylesByRunId.get(runId);
    if (cached) return cached;
    const style = RUN_COLOR_STYLES[this.stylesByRunId.size % RUN_COLOR_STYLES.length]!;
    this.stylesByRunId.set(runId, style);
    return style;
  }
}

function shortRunId(runId: string): string {
  return runId.length > 8 ? runId.slice(0, 8) : runId;
}

function printRunBoundaryEvent(event: AgentEvent, theme: TuiSettingsConfig, colors: RunColorRegistry, wrapWidth?: number): void {
  if (event.type === 'run.created') {
    printRunStartedEvent(event, theme, colors, wrapWidth);
    return;
  }
  if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'replan.required') {
    printRunEndedEvent(event, theme, colors, wrapWidth);
  }
}

function printRunStartedEvent(event: AgentEvent, theme: TuiSettingsConfig, colors: RunColorRegistry, wrapWidth?: number): void {
  if (typeof event.payload !== 'object' || event.payload === null || Array.isArray(event.payload)) return;
  const payload = event.payload as JsonObject;
  if (typeof payload.rootRunId === 'string' && payload.rootRunId !== event.runId) return;
  if (typeof payload.delegationDepth === 'number' && payload.delegationDepth > 0) return;
  const lines = [`[started] run: ${event.runId}`];
  if (typeof payload.goal === 'string') {
    lines.push(`goal: ${payload.goal.replace(/\s+/g, ' ').trim()}`);
  }
  const line = colors.colorize(event.runId, wrapRenderedText(lines.join('\n'), wrapWidth));
  console.error(renderStyledPrettyMessage('event', line, theme));
}

function printRunEndedEvent(event: AgentEvent, theme: TuiSettingsConfig, colors: RunColorRegistry, wrapWidth?: number): void {
  const payload = typeof event.payload === 'object' && event.payload !== null && !Array.isArray(event.payload)
    ? event.payload as JsonObject
    : {};
  const status = event.type === 'run.completed'
    ? 'completed'
    : event.type === 'replan.required'
      ? 'replan required'
      : 'failed';
  const lines = [`[${status}] run: ${event.runId}`];
  const lineage = renderRunLineage(event.runId, payload);
  if (lineage) {
    lines.push(lineage);
  }
  const error = typeof payload.error === 'string' ? payload.error.replace(/\s+/g, ' ').trim() : undefined;
  if (error) {
    lines.push(`error: ${error}`);
  }
  const code = typeof payload.code === 'string' ? payload.code : undefined;
  if (code) {
    lines.push(`code: ${code}`);
  }
  const colorRunId = terminalEventColorRunId(event.runId, payload);
  const line = colors.colorize(colorRunId, wrapRenderedText(lines.join('\n'), wrapWidth));
  console.error(renderStyledPrettyMessage('event', line, theme));
}

function terminalEventColorRunId(runId: string, payload: JsonObject): string {
  return typeof payload.parentRunId === 'string' ? payload.parentRunId : runId;
}

function renderRunLineage(runId: string, payload: JsonObject): string | undefined {
  const rootRunId = typeof payload.rootRunId === 'string' ? payload.rootRunId : undefined;
  const parentRunId = typeof payload.parentRunId === 'string' ? payload.parentRunId : undefined;
  const parentStepId = typeof payload.parentStepId === 'string' ? payload.parentStepId : undefined;
  const delegateName = typeof payload.delegateName === 'string' ? payload.delegateName : undefined;
  const delegationDepth = typeof payload.delegationDepth === 'number' ? payload.delegationDepth : undefined;
  const parts: string[] = [];
  if (rootRunId && rootRunId !== runId) parts.push(`root=${rootRunId}`);
  if (parentRunId) parts.push(`parent=${parentRunId}`);
  if (parentStepId) parts.push(`parentStep=${parentStepId}`);
  if (delegateName) parts.push(`delegate=${delegateName}`);
  if (delegationDepth !== undefined && delegationDepth > 0) parts.push(`depth=${delegationDepth}`);
  return parts.length > 0 ? `context: ${parts.join(' ')}` : undefined;
}

function printProgressEvent(
  event: { type: string; runId: string; payload: JsonValue },
  lastContentByRun: Map<string, string>,
  theme: TuiSettingsConfig,
  showLines: number,
  wrapWidth?: number,
  colors?: RunColorRegistry,
): void {
  const assistantContent = extractAssistantProgressContent(event);
  if (!assistantContent) {
    return;
  }
  if (lastContentByRun.get(event.runId) === assistantContent) {
    return;
  }
  lastContentByRun.set(event.runId, assistantContent);
  const rendered = limitRenderedProgressLines(wrapRenderedText(renderPrettyString(assistantContent), wrapWidth), showLines);
  if (colors) {
    const prefix = `[run ${shortRunId(event.runId)}]`;
    console.error(formatStyledMessageBlock('progress', wrapRenderedText(colors.colorize(event.runId, `${prefix} ${rendered}`), wrapWidth), swarmProgressTheme(theme)));
    return;
  }
  console.error(formatStyledMessageBlock('progress', rendered, theme));
}

const ANSI_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]/g;

function wrapRenderedText(rendered: string, requestedWidth?: number): string {
  const width = requestedWidth ?? resolveDefaultWrapWidth();
  if (!Number.isFinite(width) || width < 20) {
    return rendered.trim();
  }
  return rendered
    .trim()
    .split(/\r?\n/)
    .flatMap((line) => wrapRenderedLine(line, width))
    .join('\n');
}

function wrapRenderedLine(line: string, width: number): string[] {
  if (visibleLength(line) <= width) {
    return [line];
  }
  const strippedLine = stripAnsi(line);
  const labelMatch = /^(\s*[^:\s]+:\s+)(.+)$/.exec(strippedLine);
  const leadingWhitespace = /^\s*/.exec(strippedLine)?.[0] ?? '';
  const continuationIndent = labelMatch ? ' '.repeat(labelMatch[1].length) : leadingWhitespace;
  const tokens = line.trim().split(/\s+/);
  const lines: string[] = [];
  let current = '';
  let currentWidth = 0;

  for (const token of tokens) {
    const tokenWidth = visibleLength(token);
    if (current && currentWidth + 1 + tokenWidth > width) {
      lines.push(current);
      current = `${continuationIndent}${token}`;
      currentWidth = continuationIndent.length + tokenWidth;
      continue;
    }
    if (!current) {
      current = token;
      currentWidth = tokenWidth;
      continue;
    }
    current += ` ${token}`;
    currentWidth += 1 + tokenWidth;
  }

  if (current) {
    lines.push(current);
  }
  return lines.length > 0 ? lines : [line];
}

function visibleLength(value: string): number {
  return stripAnsi(value).length;
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}

function resolveDefaultWrapWidth(): number {
  const terminalWidth = process.stderr.columns || process.stdout.columns;
  if (!terminalWidth || terminalWidth < 20) {
    return 100;
  }
  return Math.max(40, Math.min(terminalWidth, 120));
}

function limitRenderedProgressLines(rendered: string, showLines: number): string {
  return rendered.trim().split(/\r?\n/).slice(0, showLines).join('\n');
}

function swarmProgressTheme(theme: TuiSettingsConfig): TuiSettingsConfig {
  return {
    ...theme,
    messages: {
      ...(theme.messages ?? {}),
      progress: {
        ...(theme.messages?.progress ?? {}),
        showPrefix: false,
      },
    },
  };
}

function extractAssistantProgressContent(event: { type: string; payload: JsonValue }): string | undefined {
  if (!ASSISTANT_CONTENT_PROGRESS_EVENT_TYPES.has(event.type)) {
    return undefined;
  }
  if (typeof event.payload !== 'object' || event.payload === null || Array.isArray(event.payload)) {
    return undefined;
  }
  const assistantContent = (event.payload as JsonObject).assistantContent;
  if (typeof assistantContent !== 'string') {
    return undefined;
  }
  const trimmed = assistantContent.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function printResolvedConfigSummary(
  cli: ManualTestCliOptions,
  resolvedConfig: Awaited<ReturnType<typeof loadAgentSdkConfig>>,
  spec: ManualTestSpec,
  warnings: string[],
): void {
  const summary = summarizeSpec(spec);
  console.log(`spec: ${resolve(cli.specPath)}`);
  console.log(`mode: ${spec.mode}`);
  console.log(`agent: ${resolvedConfig.agent.id} (${resolvedConfig.agent.name})`);
  console.log(`model: ${resolvedConfig.model.provider}/${resolvedConfig.model.model}`);
  console.log(`runtime: ${resolvedConfig.runtime.mode} (requested ${resolvedConfig.runtime.requestedMode})`);
  console.log(`workspace: ${resolvedConfig.workspaceRoot}`);
  console.log(`messages: ${summary.messageCount}`);
  console.log(`content: text=${summary.textParts} image=${summary.imageParts + summary.legacyImages} file=${summary.fileParts} audio=${summary.audioParts}`);
  if (warnings.length > 0) {
    console.log(`warnings: ${warnings.length}`);
  }
  console.log('');
}

function formatNameList(values: readonly string[]): string {
  return values.length > 0 ? values.join(', ') : '(none)';
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function printDryRun(
  cli: ManualTestCliOptions,
  inspection: Awaited<ReturnType<typeof inspectAgentSdkResolution>>,
  spec: ManualTestSpec,
  warnings: string[],
): void {
  const output = summarizeDryRun(cli, inspection, spec, warnings);
  if (cli.output === 'json') {
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  if (cli.output === 'jsonl') {
    console.log(JSON.stringify(output));
    return;
  }

  console.log(renderPrettyString(formatDryRunMarkdown(inspection, spec, warnings)));
}

function printEvalDryRun(
  cli: ManualTestCliOptions,
  inspection: Awaited<ReturnType<typeof inspectAgentSdkResolution>>,
  selectedCases: BenchmarkCase[],
  totalCases: number,
): void {
  const output = summarizeEvalDryRun(cli, inspection, selectedCases, totalCases);
  if (cli.output === 'json') {
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  if (cli.output === 'jsonl') {
    console.log(JSON.stringify(output));
    return;
  }

  console.log(renderPrettyString(formatEvalDryRunMarkdown(cli, inspection, selectedCases, totalCases)));
}

function formatEvalDryRunMarkdown(
  cli: ManualTestCliOptions,
  inspection: Awaited<ReturnType<typeof inspectAgentSdkResolution>>,
  selectedCases: BenchmarkCase[],
  totalCases: number,
): string {
  const config = inspection.config;
  const lines = [
    '# Dry run',
    '',
    '- `dryRun`: `true`',
    '- `command`: `eval`',
    `- \`benchmark\`: \`${cli.evalDataset ?? 'benchmark'}\``,
    `- \`requests\`: \`0\``,
    `- \`selected\`: \`${selectedCases.length}/${totalCases}\``,
    `- \`swarm\`: \`${cli.evalSwarm}\``,
    `- \`approval\`: \`${config.interaction.approvalMode}\``,
    `- \`clarification\`: \`${config.interaction.clarificationMode}\``,
    `- \`shellCwd\`: \`${config.shellCwd}\``,
    `- \`agentSearchDirs\`: ${formatNameList(config.agents.dirs)}`,
    `- \`skillSearchDirs\`: ${formatNameList(config.skills.dirs)}`,
    '',
    '## Tools',
    '',
    ...(inspection.tools.length === 0 ? ['- (none)'] : inspection.tools.map((tool) => `- \`${tool.name}\``)),
    '',
    '## Delegates',
    '',
    ...(inspection.delegates.length === 0
      ? ['- (none)']
      : inspection.delegates.flatMap((delegate) => [
          `- \`${delegate.name}\``,
          ...(delegate.description ? [`  - description: ${oneLine(delegate.description)}`] : []),
          `  - allowedTools: ${formatNameList(delegate.allowedTools)}`,
        ])),
    '',
    `- \`registeredTools\`: ${formatNameList(inspection.registeredToolNames)}`,
  ];

  if (cli.evalDataset === 'gaia') {
    lines.push('', '## GAIA Tasks', '');
    const tasks = summarizeGaiaDryRunTasks(selectedCases);
    lines.push(...(tasks.length === 0 ? ['- (none)'] : tasks.map(formatGaiaDryRunTaskLine)));
    lines.push('', `- \`totalTaskIds\`: \`${tasks.length}\``);
  }

  return `${lines.join('\n')}\n`;
}

function formatGaiaDryRunTaskLine(task: GaiaDryRunTaskSummary): string {
  const details = [
    `attachment=${task.attachmentType}`,
    ...(task.fileName ? [`file=${task.fileName}`] : []),
    ...(task.level ? [`level=${task.level}`] : []),
    ...(task.split ? [`split=${task.split}`] : []),
  ];
  return `- \`${task.taskId}\` ${details.join(' ')}`;
}

function formatDryRunMarkdown(
  inspection: Awaited<ReturnType<typeof inspectAgentSdkResolution>>,
  spec: ManualTestSpec,
  warnings: string[],
): string {
  const config = inspection.config;
  const summary = summarizeSpec(spec);
  const lines = [
    '# Dry run',
    '',
    '- `dryRun`: `true`',
    `- \`approval\`: \`${config.interaction.approvalMode}\``,
    `- \`clarification\`: \`${config.interaction.clarificationMode}\``,
    `- \`shellCwd\`: \`${config.shellCwd}\``,
    `- \`agentSearchDirs\`: ${formatNameList(config.agents.dirs)}`,
    `- \`skillSearchDirs\`: ${formatNameList(config.skills.dirs)}`,
    '',
    '## Request',
    '',
    `- \`mode\`: \`${spec.mode}\``,
    ...(spec.mode === 'run'
      ? [
          `- \`goalLength\`: \`${spec.goal.length}\``,
          `- \`input\`: \`${spec.input === undefined ? 'absent' : 'present'}\``,
        ]
      : []),
    `- \`messages\`: \`${summary.messageCount}\``,
    `- \`content\`: text=${summary.textParts} image=${summary.imageParts + summary.legacyImages} file=${summary.fileParts} audio=${summary.audioParts}`,
    '',
    '## Tools',
    '',
    ...(inspection.tools.length === 0 ? ['- (none)'] : inspection.tools.map((tool) => `- \`${tool.name}\``)),
    '',
    '## Delegates',
    '',
    ...(inspection.delegates.length === 0
      ? ['- (none)']
      : inspection.delegates.flatMap((delegate) => [
          `- \`${delegate.name}\``,
          ...(delegate.description ? [`  - description: ${oneLine(delegate.description)}`] : []),
          `  - allowedTools: ${formatNameList(delegate.allowedTools)}`,
        ])),
    '',
    `- \`registeredTools\`: ${formatNameList(inspection.registeredToolNames)}`,
  ];

  if (warnings.length > 0) {
    lines.push('', '## Warnings', '', ...warnings.map((warning) => `- ${warning}`));
  }

  return `${lines.join('\n')}\n`;
}

function summarizeDryRun(
  cli: ManualTestCliOptions,
  inspection: Awaited<ReturnType<typeof inspectAgentSdkResolution>>,
  spec: ManualTestSpec,
  warnings: string[],
): Record<string, JsonValue> {
  return {
    dryRun: true,
    cli: summarizeCli(cli),
    resolvedConfig: summarizeResolvedConfig(inspection.config, spec),
    request: spec as unknown as JsonValue,
    tools: inspection.tools.map((tool) => tool.name),
    delegates: inspection.delegates as unknown as JsonValue,
    registeredToolNames: inspection.registeredToolNames,
    warnings,
  };
}

function summarizeEvalDryRun(
  cli: ManualTestCliOptions,
  inspection: Awaited<ReturnType<typeof inspectAgentSdkResolution>>,
  selectedCases: BenchmarkCase[],
  totalCases: number,
): Record<string, JsonValue> {
  return {
    dryRun: true,
    cli: summarizeCli(cli),
    resolvedConfig: summarizeEvalResolvedConfig(inspection.config),
    benchmark: {
      dataset: cli.evalDataset ?? 'benchmark',
      inputPath: cli.evalInputPath ? resolve(cli.cwd ? resolve(cli.cwd) : process.cwd(), cli.evalInputPath) : undefined,
      filesDir: cli.evalFilesDir ? resolve(cli.cwd ? resolve(cli.cwd) : process.cwd(), cli.evalFilesDir) : undefined,
      outputPath: cli.evalOutputPath ? resolve(cli.evalOutputPath) : undefined,
      selectedCases: selectedCases.length,
      totalCases,
      requests: 0,
      swarm: cli.evalSwarm,
    } as JsonValue,
    tools: inspection.tools.map((tool) => tool.name),
    delegates: inspection.delegates as unknown as JsonValue,
    registeredToolNames: inspection.registeredToolNames,
    ...(cli.evalDataset === 'gaia'
      ? {
          gaiaTaskCount: selectedCases.length,
          gaiaTasks: summarizeGaiaDryRunTasks(selectedCases) as unknown as JsonValue,
        }
      : {}),
  };
}

function summarizeEvalResolvedConfig(
  resolvedConfig: Awaited<ReturnType<typeof loadAgentSdkConfig>>,
): Record<string, JsonValue> {
  return {
    agentId: resolvedConfig.agent.id,
    agentName: resolvedConfig.agent.name,
    provider: resolvedConfig.model.provider,
    model: resolvedConfig.model.model,
    runtimeMode: resolvedConfig.runtime.mode,
    requestedRuntimeMode: resolvedConfig.runtime.requestedMode,
    autoMigrate: resolvedConfig.runtime.autoMigrate,
    workspaceRoot: resolvedConfig.workspaceRoot,
    shellCwd: resolvedConfig.shellCwd,
    approvalMode: resolvedConfig.interaction.approvalMode,
    clarificationMode: resolvedConfig.interaction.clarificationMode,
    agentSearchDirs: resolvedConfig.agents.dirs,
    skillSearchDirs: resolvedConfig.skills.dirs,
  };
}

function printInlineConfigSummary(
  cli: ManualTestCliOptions,
  resolvedConfig: Awaited<ReturnType<typeof loadAgentSdkConfig>>,
  spec: ManualTestSpec,
  warnings: string[],
): void {
  const summary = summarizeSpec(spec);
  console.log(`command: ${cli.command}`);
  console.log(`mode: ${spec.mode}`);
  console.log(`agent: ${resolvedConfig.agent.id} (${resolvedConfig.agent.name})`);
  console.log(`model: ${resolvedConfig.model.provider}/${resolvedConfig.model.model}`);
  console.log(`runtime: ${resolvedConfig.runtime.mode} (requested ${resolvedConfig.runtime.requestedMode})`);
  console.log(`workspace: ${resolvedConfig.workspaceRoot}`);
  console.log(`messages: ${summary.messageCount}`);
  console.log(`content: text=${summary.textParts} image=${summary.imageParts + summary.legacyImages} file=${summary.fileParts} audio=${summary.audioParts}`);
  if (warnings.length > 0) {
    console.log(`warnings: ${warnings.length}`);
  }
  console.log('');
}

function printEvent(event: Record<string, JsonValue>, theme: TuiSettingsConfig, colors?: RunColorRegistry): void {
  const parts = [
    `[event] ${String(event.type)}`,
    `run=${String(event.runId)}`,
    ...(event.stepId ? [`step=${String(event.stepId)}`] : []),
    ...(event.toolCallId ? [`toolCall=${String(event.toolCallId)}`] : []),
  ];
  const runId = typeof event.runId === 'string' ? event.runId : undefined;
  console.error(renderStyledPrettyMessage('event', colors?.colorize(runId, parts.join(' ')) ?? parts.join(' '), theme));
}

function printOrchestrationLifecycleEvent(event: OrchestrationLifecycleEvent, theme: TuiSettingsConfig): void {
  const parts = [`[event] ${event.type}`, `session=${event.sessionId}`];
  if ('nodeId' in event) parts.push(`node=${event.nodeId}`, `agent=${event.agentId}`, `stage=${event.stage}`);
  if ('runId' in event) parts.push(`run=${event.runId}`);
  if ('finalRunId' in event) parts.push(`run=${event.finalRunId}`);
  if ('status' in event) parts.push(`status=${event.status}`);
  if ('executionShape' in event) parts.push(`shape=${event.executionShape}`);
  console.error(renderStyledPrettyMessage('event', parts.join(' '), theme));
}

function printResult(
  result: RunResult | ChatResult,
  successType: Extract<TuiMessageType, 'assistant' | 'run'>,
  theme: TuiSettingsConfig,
): void {
  console.log(`status: ${result.status}`);
  console.log(`runId: ${result.runId}`);
  if (result.status === 'success') {
    console.log(`stepsUsed: ${result.stepsUsed}`);
    printUsage(result.usage);
    console.log('output:');
    console.log(renderStyledPrettyValue(successType, result.output, theme));
    return;
  }
  if (result.status === 'failure') {
    console.log(`code: ${result.code}`);
    console.log('error:');
    console.log(renderStyledPrettyMessage('system', result.error, theme));
    console.log(`stepsUsed: ${result.stepsUsed}`);
    printUsage(result.usage);
    return;
  }
  console.log('message:');
  console.log(renderStyledPrettyMessage('system', result.message, theme));
  if ('toolName' in result) {
    console.log(`tool: ${result.toolName}`);
  }
}

function printOrchestration(result: OrchestratedRunResult): void {
  console.log(`orchestration: session=${result.sessionId} shape=${result.executionShape}`);
  console.log(`routing: ${result.plan.routingReason}`);
  console.log(`stages: ${result.stages.map((stage) => `${stage.nodeId}:${stage.agentId}:${stage.runId}`).join(', ') || '(none)'}`);
  console.log('');
}

function printUsage(usage: { promptTokens: number; completionTokens: number; reasoningTokens?: number; totalTokens?: number; estimatedCostUSD: number; provider?: string; model?: string }): void {
  console.log(`usage: prompt=${usage.promptTokens} completion=${usage.completionTokens} total=${usage.totalTokens ?? usage.promptTokens + usage.completionTokens} costUsd=${usage.estimatedCostUSD}`);
}

function printInspection(inspection: InspectionSummary): void {
  console.log('');
  console.log('inspection:');
  console.log(`runStatus: ${inspection.run?.status ?? 'missing'}`);
  console.log(`eventCount: ${inspection.eventCount}`);
  for (const [type, count] of Object.entries(inspection.eventTypes).sort(([left], [right]) => left.localeCompare(right))) {
    console.log(`  ${type}: ${count}`);
  }
}

export function renderPrettyValue(value: unknown): string {
  if (typeof value === 'string') {
    return renderPrettyString(value);
  }
  return JSON.stringify(value, null, 2) ?? String(value);
}

export function renderStyledPrettyValue(
  type: TuiMessageType,
  value: unknown,
  theme: TuiSettingsConfig = {},
): string {
  return renderStyledPrettyMessage(type, renderPrettyValue(value), theme);
}

export function renderPrettyString(value: string): string {
  return marked.parse(value) as string;
}

export function renderStyledPrettyMessage(
  type: TuiMessageType,
  value: string,
  theme: TuiSettingsConfig = {},
): string {
  const rendered = type === 'assistant' || type === 'progress' || type === 'run'
    ? renderPrettyString(value)
    : value;
  return formatStyledMessageBlock(type, rendered, theme);
}

async function validateLocalPaths(spec: ManualTestSpec): Promise<void> {
  const checks = collectContentParts(spec).flatMap((part) => {
    if (part.type === 'image') return [{ path: part.image.path, label: `image ${part.image.name ?? part.image.path}` }];
    if (part.type === 'file' && part.file.source.kind === 'path') return [{ path: part.file.source.path, label: `file ${part.file.name ?? part.file.source.path}` }];
    if (part.type === 'audio' && part.audio.source.kind === 'path') return [{ path: part.audio.source.path, label: `audio ${part.audio.name ?? part.audio.source.path}` }];
    return [];
  });

  for (const check of checks) {
    try {
      await access(check.path);
    } catch {
      throw new Error(`Referenced ${check.label} does not exist: ${check.path}`);
    }
  }
}

if (import.meta.main) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export async function parseAndValidateSpec(specPath: string, modeOverride?: 'chat' | 'run'): Promise<ManualTestSpec> {
  const spec = await loadManualTestSpec(specPath, modeOverride);
  await validateLocalPaths(spec);
  return spec;
}
