#!/usr/bin/env bun

import { access, readFile } from 'node:fs/promises';
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
  command: 'run' | 'chat' | 'spec' | 'config';
  specPath: string;
  goalArgs: string[];
  promptFilePath?: string;
  inputJson?: JsonValue;
  imagePaths: string[];
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
  output: 'pretty' | 'json';
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

const HELP_TEXT = `adaptive-agent

Agent SDK CLI

Usage:
  adaptive-agent run [options] <goal...>
  adaptive-agent chat [options] [message...]
  adaptive-agent spec <path> [options]
  adaptive-agent config [options]
  adaptive-agent --spec <path> [options]
  bun run ./packages/agent-sdk/dist/adaptive-agent.js --spec <path> [options]

Commands:
  run                   Run a one-shot goal.
  chat                  Send one chat turn. Reads stdin when no message is given.
  spec                  Run the existing JSON spec format.
  config                Print resolved SDK configuration.

Options:
  --spec <path>           Path to the JSON spec file.
  --file <path>           Read run/chat prompt from a file.
  --input-json <json>     JSON input passed to run requests.
  --image <path>          Add an image attachment to a run request. Repeatable.
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
  --output <pretty|json>  Output format. Default: pretty.
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

export function parseCliArgs(argv: string[]): ManualTestCliOptions {
  const options: ManualTestCliOptions = {
    command: 'spec',
    specPath: '',
    goalArgs: [],
    imagePaths: [],
    events: false,
    inspect: false,
    output: 'pretty',
    help: false,
  };

  let commandSeen = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!commandSeen && (arg === 'run' || arg === 'chat' || arg === 'spec' || arg === 'config')) {
      options.command = arg;
      commandSeen = true;
      if (arg === 'spec' && argv[index + 1] && !argv[index + 1].startsWith('--')) {
        options.specPath = argv[++index];
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
        options.output = parseEnumOption(arg, requireOptionValue(arg, argv[++index]), ['pretty', 'json']);
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
