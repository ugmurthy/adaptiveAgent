#!/usr/bin/env bun

import { access, appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import type {
  ChatMessage,
  ChatResult,
  ImageInput,
  JsonObject,
  JsonSchema,
  JsonValue,
  ModelContentPart,
  RunResult,
} from '@adaptive-agent/core';

import {
  createAgentSdk,
  loadAgentSdkConfig,
  type AgentSdkChatOptions,
  type AgentSdkRunOptions,
  type ApprovalMode,
  type ClarificationMode,
  type RuntimeMode,
} from './index.js';

marked.use(markedTerminal() as never);

export interface ManualTestCliOptions {
  command: 'run' | 'chat' | 'spec' | 'config' | 'eval';
  specPath: string;
  goalArgs: string[];
  promptFilePath?: string;
  inputJson?: JsonValue;
  imagePaths: string[];
  evalDataset?: 'cases' | 'gaia';
  evalInputPath?: string;
  evalFilesDir?: string;
  evalOutputPath?: string;
  evalArtifactsDir?: string;
  evalResume: boolean;
  evalFailFast: boolean;
  evalLimit?: number;
  evalOffset: number;
  evalIds?: string[];
  evalLevel?: string;
  evalSplit?: string;
  mode?: 'chat' | 'run';
  cwd?: string;
  agentConfigPath?: string;
  settingsConfigPath?: string;
  runtimeMode?: RuntimeMode;
  provider?: 'openrouter' | 'ollama' | 'mistral' | 'mesh';
  model?: string;
  approvalMode?: ApprovalMode;
  clarificationMode?: ClarificationMode;
  events: boolean;
  inspect: boolean;
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

const HELP_TEXT = `adaptive-agent

Agent SDK CLI

Usage:
  adaptive-agent run [options] <goal...>
  adaptive-agent chat [options] [message...]
  adaptive-agent spec <path> [options]
  adaptive-agent eval cases --input <path> --out <path> [options]
  adaptive-agent eval gaia --input <path> --out <path> [options]
  adaptive-agent config [options]
  adaptive-agent --spec <path> [options]
  bun run ./packages/agent-sdk/dist/adaptive-agent.js --spec <path> [options]

Commands:
  run                   Run a one-shot goal.
  chat                  Send one chat turn. Reads stdin when no message is given.
  spec                  Run the existing JSON spec format.
  eval cases            Run generic benchmark cases from JSON/JSONL.
  eval gaia             Run GAIA benchmark rows from JSON/JSONL.
  config                Print resolved SDK configuration.

Options:
  --spec <path>           Path to the JSON spec file.
  --file <path>           Read run/chat prompt from a file.
  --input-json <json>     JSON input passed to run requests.
  --image <path>          Add an image attachment to a run request. Repeatable.
  --input <path>          Benchmark input JSONL for eval cases.
  --files-dir <path>      Directory for benchmark attachments.
  --out <path>            Benchmark result JSONL path.
  --artifacts <dir>       Benchmark artifact directory.
  --resume                Skip benchmark cases already present in --out.
  --fail-fast             Stop eval after the first failed case.
  --limit <n>             Limit benchmark cases after filtering.
  --offset <n>            Skip benchmark cases before filtering.
  --ids <id,id,...>       Run only the listed benchmark case ids.
  --level <value>         Run only matching benchmark level.
  --split <value>         Add/filter benchmark split metadata.
  --mode <chat|run>       Override the spec mode.
  --cwd <path>            Working directory used for SDK config lookup.
  --agent <path>          Explicit path to agent.json.
  --settings <path>       Explicit path to agent.settings.json.
  --runtime <mode>        Runtime mode: memory or postgres.
  --provider <name>       Override provider: openrouter, ollama, mistral, mesh.
  --model <name>          Override model name.
  --approval <mode>       Approval mode: auto, manual, reject.
  --clarification <mode>  Clarification mode: interactive or fail.
  --events                Print lifecycle events as they arrive.
  --inspect               Print a compact inspection summary after completion.
  --output <format>       Output format: pretty, json, or jsonl. Default: pretty.
  --help                  Show this help text.
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

  if (cli.command === 'config') {
    return runConfigCommand(cli);
  }

  if (cli.command === 'run') {
    return runInlineCommand(cli, 'run');
  }

  if (cli.command === 'chat') {
    return runInlineCommand(cli, 'chat');
  }

  if (cli.command === 'eval') {
    return runEvalCommand(cli);
  }

  return runSpecCommand(cli);
}

async function runSpecCommand(cli: ManualTestCliOptions): Promise<number> {
  const specPath = resolve(cli.specPath);
  const spec = await parseAndValidateSpec(specPath, cli.mode);
  const resolvedCwd = resolve(cli.cwd ?? process.cwd());
  const sdkOptions = buildSdkOptions(cli, resolvedCwd);
  const resolvedConfig = await loadAgentSdkConfig(sdkOptions);
  const warnings = collectProviderWarnings(spec, resolvedConfig.model.provider);
  const eventLog: Array<Record<string, JsonValue>> = [];

  for (const warning of warnings) {
    if (cli.output === 'pretty') {
      console.error(`warning: ${warning}`);
    }
  }

  if (cli.output === 'pretty') {
    printResolvedConfigSummary(cli, resolvedConfig, spec, warnings);
  }

  const sdk = await createAgentSdk({
    ...sdkOptions,
    eventListener: cli.events ? (event) => {
      const entry = summarizeEvent(event);
      eventLog.push(entry);
      if (cli.output === 'pretty') {
        printEvent(entry);
      }
    } : undefined,
  });

  try {
    const result = spec.mode === 'chat'
      ? await sdk.chat(spec.messages, buildChatOptions(spec))
      : await sdk.run(spec.goal, buildRunOptions(spec));

    const inspection = cli.inspect ? await summarizeInspection(sdk, result.runId) : undefined;
    if (cli.output === 'json') {
      const jsonOutput: ManualTestJsonOutput = {
        cli: summarizeCli(cli),
        resolvedConfig: summarizeResolvedConfig(resolvedConfig, spec),
        request: spec as unknown as JsonValue,
        warnings,
        result: summarizeResult(result),
        ...(inspection ? { inspection: inspection as unknown as JsonValue } : {}),
      };
      console.log(JSON.stringify(jsonOutput, null, 2));
      return isSuccessfulResult(result) ? 0 : 1;
    }

    printResult(result);
    if (cli.inspect && inspection) {
      printInspection(inspection);
    }
    if (cli.events && eventLog.length > 0) {
      console.error(`event log captured: ${eventLog.length}`);
    }
    return isSuccessfulResult(result) ? 0 : 1;
  } finally {
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
      }
    : { mode: 'chat', messages: [{ role: 'user', content: goal }] };
  await validateLocalPaths(spec);

  const sdkOptions = buildSdkOptions(cli, resolvedCwd);
  const resolvedConfig = await loadAgentSdkConfig(sdkOptions);
  const warnings = collectProviderWarnings(spec, resolvedConfig.model.provider);
  const eventLog: Array<Record<string, JsonValue>> = [];

  for (const warning of warnings) {
    if (cli.output === 'pretty') console.error(`warning: ${warning}`);
  }

  if (cli.output === 'pretty') {
    printInlineConfigSummary(cli, resolvedConfig, spec, warnings);
  }

  const sdk = await createAgentSdk({
    ...sdkOptions,
    eventListener: cli.events ? (event) => {
      const entry = summarizeEvent(event);
      eventLog.push(entry);
      if (cli.output === 'pretty') printEvent(entry);
    } : undefined,
  });

  try {
    const result = spec.mode === 'chat'
      ? await sdk.chat(spec.messages, buildChatOptions(spec))
      : await sdk.run(spec.goal, buildRunOptions(spec));
    const inspection = cli.inspect ? await summarizeInspection(sdk, result.runId) : undefined;

    if (cli.output === 'json') {
      const jsonOutput: ManualTestJsonOutput = {
        cli: summarizeCli(cli),
        resolvedConfig: summarizeResolvedConfig(resolvedConfig, spec),
        request: spec as unknown as JsonValue,
        warnings,
        result: summarizeResult(result),
        ...(inspection ? { inspection: inspection as unknown as JsonValue } : {}),
      };
      console.log(JSON.stringify(jsonOutput, null, 2));
      return isSuccessfulResult(result) ? 0 : 1;
    }

    printResult(result);
    if (cli.inspect && inspection) printInspection(inspection);
    if (cli.events && eventLog.length > 0) console.error(`event log captured: ${eventLog.length}`);
    return isSuccessfulResult(result) ? 0 : 1;
  } finally {
    await sdk.close();
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
  console.log(`tools: ${resolvedConfig.agent.tools.join(', ')}`);
  console.log(`delegates: ${(resolvedConfig.agent.delegates ?? []).join(', ') || '(none)'}`);
  return 0;
}

async function runEvalCommand(cli: ManualTestCliOptions): Promise<number> {
  if (!cli.evalInputPath) {
    throw new Error(`eval ${cli.evalDataset ?? 'benchmark'} requires --input <path>`);
  }
  if (!cli.evalOutputPath) {
    throw new Error(`eval ${cli.evalDataset ?? 'benchmark'} requires --out <path>`);
  }

  const resolvedCwd = resolve(cli.cwd ?? process.cwd());
  const outputPath = resolve(cli.evalOutputPath);
  const artifactsDir = cli.evalArtifactsDir ? resolve(cli.evalArtifactsDir) : undefined;
  const allCases = cli.evalDataset === 'gaia'
    ? await loadGaiaBenchmarkCases(cli.evalInputPath, resolvedCwd, cli.evalFilesDir, cli.evalSplit)
    : await loadBenchmarkCases(cli.evalInputPath, resolvedCwd);
  const completedIds = cli.evalResume ? await readCompletedBenchmarkIds(outputPath) : new Set<string>();
  const selectedCases = selectBenchmarkCases(allCases, cli, completedIds);
  const sdkOptions = buildSdkOptions(cli, resolvedCwd);
  const resolvedConfig = await loadAgentSdkConfig(sdkOptions);
  await mkdir(dirname(outputPath), { recursive: true });
  if (artifactsDir) await mkdir(artifactsDir, { recursive: true });

  if (cli.output === 'pretty') {
    console.log(`benchmark: ${cli.evalDataset}`);
    console.log(`input: ${resolve(cli.evalInputPath)}`);
    if (cli.evalFilesDir) console.log(`files: ${resolve(resolvedCwd, cli.evalFilesDir)}`);
    console.log(`out: ${outputPath}`);
    console.log(`selected: ${selectedCases.length}/${allCases.length}`);
    console.log(`model: ${resolvedConfig.model.provider}/${resolvedConfig.model.model}`);
    console.log(`runtime: ${resolvedConfig.runtime.mode}`);
    console.log('');
  }

  const eventLog: Array<Record<string, JsonValue>> = [];
  const sdk = await createAgentSdk({
    ...sdkOptions,
    eventListener: (event) => {
      const entry = summarizeEvent(event);
      eventLog.push(entry);
      if (cli.events && cli.output === 'pretty') printEvent(entry);
    },
  });

  let failed = 0;
  const removeProcessErrorGuard = installEvalProcessErrorGuard();
  try {
    for (const benchmarkCase of selectedCases) {
      const record = await runBenchmarkCase({
        sdk,
        benchmarkCase,
        resolvedConfig,
        outputPath,
        artifactsDir,
        eventLog,
      });
      await appendJsonLine(outputPath, record as unknown as JsonValue);
      if (cli.output === 'json' || cli.output === 'jsonl') {
        console.log(JSON.stringify(record));
      } else {
        console.log(`${record.status === 'completed' ? '✓' : '✗'} ${record.taskId}${record.runId ? ` run=${record.runId}` : ''}`);
      }
      if (record.status !== 'completed') {
        failed += 1;
        if (cli.evalFailFast) break;
      }
    }
  } finally {
    removeProcessErrorGuard();
    await sdk.close();
  }

  if (cli.output === 'pretty') {
    console.log('');
    console.log(`completed: ${selectedCases.length - failed}`);
    console.log(`failed: ${failed}`);
  }
  return failed === 0 ? 0 : 1;
}

export function parseCliArgs(argv: string[]): ManualTestCliOptions {
  const options: ManualTestCliOptions = {
    command: 'spec',
    specPath: '',
    goalArgs: [],
    imagePaths: [],
    evalResume: false,
    evalFailFast: false,
    evalOffset: 0,
    events: false,
    inspect: false,
    output: 'pretty',
    help: false,
  };

  let commandSeen = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!commandSeen && (arg === 'run' || arg === 'chat' || arg === 'spec' || arg === 'config' || arg === 'eval')) {
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
      case '--events':
        options.events = true;
        break;
      case '--inspect':
        options.inspect = true;
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
      case '--image':
        options.imagePaths.push(requireOptionValue(arg, argv[++index]));
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
        if (options.command === 'run' || options.command === 'chat') {
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

  if (!options.help && options.command === 'chat' && options.imagePaths.length > 0) {
    throw new Error('--image is supported for run requests, not chat requests');
  }

  if (!options.help && options.command === 'chat' && options.inputJson !== undefined) {
    throw new Error('--input-json is supported for run requests, not chat requests');
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

function gaiaAttachmentForFile(path: string, name: string): { kind: 'image' | 'file'; path: string } {
  return isImageFileName(name) ? { kind: 'image', path } : { kind: 'file', path };
}

function isImageFileName(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(name);
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

function selectBenchmarkCases(cases: BenchmarkCase[], cli: ManualTestCliOptions, completedIds: Set<string>): BenchmarkCase[] {
  const allowedIds = cli.evalIds ? new Set(cli.evalIds) : undefined;
  let selected = cases.slice(cli.evalOffset).filter((benchmarkCase) => {
    if (allowedIds && !allowedIds.has(benchmarkCase.id)) return false;
    if (cli.evalLevel && benchmarkCase.level !== cli.evalLevel) return false;
    if (cli.evalSplit && benchmarkCase.split && benchmarkCase.split !== cli.evalSplit) return false;
    if (completedIds.has(benchmarkCase.id)) return false;
    return true;
  });
  if (cli.evalLimit !== undefined) {
    selected = selected.slice(0, cli.evalLimit);
  }
  return selected;
}

async function runBenchmarkCase(options: {
  sdk: Awaited<ReturnType<typeof createAgentSdk>>;
  benchmarkCase: BenchmarkCase;
  resolvedConfig: Awaited<ReturnType<typeof loadAgentSdkConfig>>;
  outputPath: string;
  artifactsDir?: string;
  eventLog: Array<Record<string, JsonValue>>;
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
    const result = await options.sdk.run(options.benchmarkCase.question, runOptions);
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
  options: { sdk: Awaited<ReturnType<typeof createAgentSdk>>; benchmarkCase: BenchmarkCase; artifactsDir?: string; eventLog: Array<Record<string, JsonValue>> },
  output: unknown,
  eventStartIndex: number,
): Promise<BenchmarkResultRecord['artifacts'] | undefined> {
  if (!options.artifactsDir) return undefined;
  const taskDir = resolve(options.artifactsDir, safePathSegment(options.benchmarkCase.id));
  await mkdir(taskDir, { recursive: true });
  const inputPath = resolve(taskDir, 'input.json');
  const outputPath = resolve(taskDir, 'output.json');
  const eventLogPath = resolve(taskDir, 'events.jsonl');
  const answerPath = resolve(taskDir, 'answer.txt');
  await writeFile(inputPath, JSON.stringify(options.benchmarkCase, null, 2));
  await writeFile(outputPath, JSON.stringify(output, null, 2));
  const events = options.eventLog.slice(eventStartIndex);
  await writeFile(eventLogPath, events.map((event) => JSON.stringify(event)).join('\n') + (events.length > 0 ? '\n' : ''));
  if (typeof output === 'object' && output && 'output' in output) {
    await writeFile(answerPath, stringifyPrediction((output as { output?: unknown }).output));
  }
  return { input: inputPath, output: outputPath, eventLog: eventLogPath, answer: answerPath };
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
    ...(cli.evalDataset ? { evalDataset: cli.evalDataset } : {}),
    ...(cli.evalInputPath ? { evalInputPath: resolve(cli.evalInputPath) } : {}),
    ...(cli.evalFilesDir ? { evalFilesDir: resolve(cli.evalFilesDir) } : {}),
    ...(cli.evalOutputPath ? { evalOutputPath: resolve(cli.evalOutputPath) } : {}),
    ...(cli.evalArtifactsDir ? { evalArtifactsDir: resolve(cli.evalArtifactsDir) } : {}),
    ...(cli.evalLimit ? { evalLimit: cli.evalLimit } : {}),
    ...(cli.evalOffset ? { evalOffset: cli.evalOffset } : {}),
    ...(cli.evalIds ? { evalIds: cli.evalIds } : {}),
    ...(cli.evalLevel ? { evalLevel: cli.evalLevel } : {}),
    ...(cli.evalSplit ? { evalSplit: cli.evalSplit } : {}),
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
    events: cli.events,
    inspect: cli.inspect,
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
    workspaceRoot: resolvedConfig.workspaceRoot,
    shellCwd: resolvedConfig.shellCwd,
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

function printEvent(event: Record<string, JsonValue>): void {
  const parts = [
    `[event] ${String(event.type)}`,
    `run=${String(event.runId)}`,
    ...(event.stepId ? [`step=${String(event.stepId)}`] : []),
    ...(event.toolCallId ? [`toolCall=${String(event.toolCallId)}`] : []),
  ];
  console.error(parts.join(' '));
}

function printResult(result: RunResult | ChatResult): void {
  console.log(`status: ${result.status}`);
  console.log(`runId: ${result.runId}`);
  if (result.status === 'success') {
    console.log(`stepsUsed: ${result.stepsUsed}`);
    printUsage(result.usage);
    console.log('output:');
    console.log(renderPrettyValue(result.output));
    return;
  }
  if (result.status === 'failure') {
    console.log(`code: ${result.code}`);
    console.log('error:');
    console.log(renderPrettyString(result.error));
    console.log(`stepsUsed: ${result.stepsUsed}`);
    printUsage(result.usage);
    return;
  }
  console.log('message:');
  console.log(renderPrettyString(result.message));
  if ('toolName' in result) {
    console.log(`tool: ${result.toolName}`);
  }
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

export function renderPrettyString(value: string): string {
  return marked.parse(value) as string;
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
