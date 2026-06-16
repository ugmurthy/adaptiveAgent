import { access, mkdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin, stderr } from 'node:process';
import { resolve } from 'node:path';

import type { JsonObject, JsonSchema, JsonValue, RunResult } from '@adaptive-agent/core';

import {
  createAgentSdk,
  loadAgentSdkConfig,
  type AgentCapabilityConfig,
  type AgentConfigFile,
  type AgentSdkOptions,
  type InvocationMode,
  type ResolvedAgentSdkConfig,
  type RuntimeMode,
} from './index.js';

export type AgentCreateProvider = 'openrouter' | 'ollama' | 'mistral' | 'mesh';
export type AgentCreateOutputFormat = 'pretty' | 'json' | 'jsonl';
export type AgentCreateStatus = 'created' | 'overwritten' | 'exists' | 'cancelled';

export interface AgentCreateDraft {
  agent: {
    id?: string;
    name: string;
    description?: string;
    systemInstructions: string;
    capabilities?: AgentCapabilityConfig;
    routing?: JsonObject;
    metadata?: JsonObject;
  };
  notes?: string[];
  recommendations?: string[];
}

export interface AgentCreateGenerateDraftArgs {
  brief: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  generatorConfig: ResolvedAgentSdkConfig;
}

export interface AgentCreatePrepared {
  command: 'agent-create';
  brief: string;
  generatorAgent: {
    requested: string;
    id: string;
    name: string;
  };
  agentsDir: string;
  path: string;
  exists: boolean;
  agent: AgentConfigFile;
  draft: AgentCreateDraft;
  notes: string[];
  recommendations: string[];
}

export interface AgentCreateReport {
  command: 'agent-create';
  status: AgentCreateStatus;
  dryRun: boolean;
  yes: boolean;
  force: boolean;
  prompted: boolean;
  message: string;
  prepared: AgentCreatePrepared;
}

export interface AgentCreateOptions {
  brief: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  settingsConfigPath?: string;
  generatorAgent?: string;
  id?: string;
  provider?: AgentCreateProvider;
  model?: string;
  runtimeMode?: RuntimeMode;
  yes?: boolean;
  force?: boolean;
  dryRun?: boolean;
  generateDraft?: (args: AgentCreateGenerateDraftArgs) => Promise<AgentCreateDraft>;
  confirm?: (prepared: AgentCreatePrepared) => Promise<boolean> | boolean;
}

const DEFAULT_GENERATOR_AGENT = 'default-agent';

const AGENT_CREATE_DRAFT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['agent'],
  additionalProperties: false,
  properties: {
    agent: {
      type: 'object',
      required: ['id', 'name', 'systemInstructions'],
      additionalProperties: false,
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        systemInstructions: { type: 'string' },
        capabilities: { type: 'object', additionalProperties: true },
        routing: { type: 'object', additionalProperties: true },
        metadata: { type: 'object', additionalProperties: true },
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
    recommendations: { type: 'array', items: { type: 'string' } },
  },
};

export async function runAgentCreate(options: AgentCreateOptions): Promise<AgentCreateReport> {
  const prepared = await prepareAgentCreate(options);
  const dryRun = options.dryRun ?? false;
  const yes = options.yes ?? false;
  const force = options.force ?? false;

  if (prepared.exists && !force) {
    return {
      command: 'agent-create',
      status: 'exists',
      dryRun,
      yes,
      force,
      prompted: false,
      message: `Agent config already exists at ${prepared.path}; use --force to overwrite.`,
      prepared,
    };
  }

  let prompted = false;
  if (dryRun || !yes) {
    prompted = true;
    const confirmed = await (options.confirm ?? confirmAgentCreateInTerminal)(prepared);
    if (!confirmed) {
      return {
        command: 'agent-create',
        status: 'cancelled',
        dryRun,
        yes,
        force,
        prompted,
        message: 'Cancelled; no file written.',
        prepared,
      };
    }
  }

  await mkdir(prepared.agentsDir, { recursive: true });
  await writeFile(prepared.path, `${JSON.stringify(prepared.agent, null, 2)}\n`);
  const status = prepared.exists ? 'overwritten' : 'created';
  return {
    command: 'agent-create',
    status,
    dryRun,
    yes,
    force,
    prompted,
    message: prepared.exists
      ? `Overwrote agent config at ${prepared.path}.`
      : `Created agent config at ${prepared.path}.`,
    prepared,
  };
}

export async function prepareAgentCreate(options: AgentCreateOptions): Promise<AgentCreatePrepared> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const brief = options.brief.trim();
  if (!brief) {
    throw new Error('agent-create requires a non-empty agent description from positionals, --file, or stdin.');
  }

  const generatorAgent = options.generatorAgent ?? DEFAULT_GENERATOR_AGENT;
  const generatorConfig = await loadAgentSdkConfig({
    cwd,
    env,
    settingsConfigPath: options.settingsConfigPath,
    agentConfigPath: generatorAgent,
    runtimeMode: options.runtimeMode,
  });
  const agentsDir = generatorConfig.agents.dirs[0];
  if (!agentsDir) {
    throw new Error('agent-create requires at least one configured agents.dirs entry.');
  }

  const draft = validateAgentCreateDraft(
    await (options.generateDraft ?? generateAgentCreateDraft)({
      brief,
      cwd,
      env,
      generatorConfig,
    }),
  );
  const agent = buildAgentConfig(generatorConfig.agent, draft, {
    id: options.id,
    provider: options.provider,
    model: options.model,
  });
  await validateGeneratedAgentConfig(agent, cwd, env, generatorConfig);

  const path = resolve(agentsDir, `${agent.id}.json`);
  return {
    command: 'agent-create',
    brief,
    generatorAgent: {
      requested: generatorAgent,
      id: generatorConfig.agent.id,
      name: generatorConfig.agent.name,
    },
    agentsDir,
    path,
    exists: await pathExists(path),
    agent,
    draft,
    notes: draft.notes ?? [],
    recommendations: draft.recommendations ?? [],
  };
}

export function renderAgentCreateReport(report: AgentCreateReport, output: AgentCreateOutputFormat = 'pretty'): string {
  if (output === 'json') {
    return JSON.stringify(agentCreateReportJson(report), null, 2);
  }

  if (output === 'jsonl') {
    return JSON.stringify(agentCreateReportJson(report));
  }

  const lines = report.prompted
    ? [
        report.message,
        `path: ${report.prepared.path}`,
      ]
    : [
        renderAgentCreatePreview(report.prepared),
        '',
        report.message,
      ];
  return lines.join('\n');
}

export function renderAgentCreatePreview(prepared: AgentCreatePrepared): string {
  const agent = prepared.agent;
  const model = agent.model;
  const lines = [
    'New agent config',
    '',
    'Path:',
    `  ${prepared.path}`,
    '',
    'Generator:',
    `  ${prepared.generatorAgent.id} (${prepared.generatorAgent.name})`,
    '',
    'Identity:',
    `  id: ${agent.id}`,
    `  name: ${agent.name}`,
    `  description: ${agent.description ?? '(none)'}`,
    '',
    'Runtime:',
    `  provider: ${model.provider ?? '(from settings)'}`,
    `  model: ${model.model ?? '(from settings)'}`,
    `  invocationModes: ${agent.invocationModes.join(', ')}`,
    `  defaultInvocationMode: ${agent.defaultInvocationMode}`,
    `  workspaceRoot: ${agent.workspaceRoot ?? agent.workspace?.root ?? '(current workspace)'}`,
    '',
    'Tools:',
    ...formatList(agent.tools),
    '',
    'Delegates:',
    ...formatList(agent.delegates ?? []),
    '',
    'System instructions:',
    ...indentBlock(agent.systemInstructions),
  ];

  if (prepared.notes.length > 0) {
    lines.push('', 'Notes:', ...formatList(prepared.notes));
  }

  if (prepared.recommendations.length > 0) {
    lines.push('', 'Recommendations:', ...formatList(prepared.recommendations));
  }

  return lines.join('\n');
}

export async function confirmAgentCreateInTerminal(prepared: AgentCreatePrepared): Promise<boolean> {
  stderr.write(`${renderAgentCreatePreview(prepared)}\n\n`);
  if (!stdin.isTTY) {
    throw new Error('agent-create requires --yes to write in a non-interactive terminal.');
  }
  const rl = createInterface({ input: stdin, output: stderr });
  try {
    const answer = await rl.question('Write this agent config? [y/N] ');
    return ['y', 'yes'].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

async function generateAgentCreateDraft(args: AgentCreateGenerateDraftArgs): Promise<AgentCreateDraft> {
  const sdkOptions: AgentSdkOptions = {
    cwd: args.cwd,
    env: args.env,
    agentConfig: args.generatorConfig.agent,
    settingsConfig: args.generatorConfig.settings,
    runtimeMode: args.generatorConfig.runtime.mode,
  };
  const sdk = await createAgentSdk(sdkOptions);
  try {
    const result = await sdk.runRaw(agentCreateGoal(args.brief, args.generatorConfig), {
      forbiddenTools: args.generatorConfig.agent.tools,
      outputSchema: AGENT_CREATE_DRAFT_SCHEMA,
      metadata: {
        command: 'agent-create',
        generatorAgentId: args.generatorConfig.agent.id,
      },
    });
    if (result.status !== 'success') {
      throw new Error(formatDraftGenerationFailure(result));
    }
    return validateAgentCreateDraft(result.output);
  } finally {
    await sdk.close();
  }
}

function agentCreateGoal(brief: string, generatorConfig: ResolvedAgentSdkConfig): string {
  return [
    'Create a new Adaptive Agent profile draft from the user description.',
    '',
    'Return only the structured JSON object requested by outputSchema.',
    'Draft only the new agent identity, description, systemInstructions, capabilities, routing, metadata, notes, and recommendations.',
    'Do not choose model, tools, delegates, invocation modes, defaults, delegation, recovery, workspace, runtime, or file path.',
    'The CLI will inherit those operational fields from the generator agent after validation.',
    'Keep systemInstructions directly usable as the target agent system prompt.',
    'Do not include hidden reasoning or chain-of-thought.',
    '',
    'Inherited operational defaults summary:',
    JSON.stringify({
      invocationModes: generatorConfig.agent.invocationModes,
      defaultInvocationMode: generatorConfig.agent.defaultInvocationMode,
      tools: generatorConfig.agent.tools,
      delegates: generatorConfig.agent.delegates ?? [],
      provider: generatorConfig.agent.model.provider,
      model: generatorConfig.agent.model.model,
    }, null, 2),
    '',
    'User description:',
    brief,
  ].join('\n');
}

function buildAgentConfig(
  generatorAgent: AgentConfigFile,
  draft: AgentCreateDraft,
  overrides: { id?: string; provider?: AgentCreateProvider; model?: string },
): AgentConfigFile {
  const agentId = overrides.id ? validateExplicitAgentId(overrides.id) : normalizeGeneratedAgentId(draft.agent.id ?? draft.agent.name);
  const model = applyModelOverrides(generatorAgent.model, overrides);
  return compactObject({
    version: 1,
    id: agentId,
    name: draft.agent.name.trim(),
    description: optionalTrimmedString(draft.agent.description),
    invocationModes: [...generatorAgent.invocationModes] as InvocationMode[],
    defaultInvocationMode: generatorAgent.defaultInvocationMode,
    workspace: cloneConfigValue(generatorAgent.workspace),
    workspaceRoot: generatorAgent.workspaceRoot,
    model,
    systemInstructions: draft.agent.systemInstructions.trim(),
    tools: [...generatorAgent.tools],
    delegates: [...(generatorAgent.delegates ?? [])],
    defaults: cloneConfigValue(generatorAgent.defaults),
    delegation: cloneConfigValue(generatorAgent.delegation),
    recovery: cloneConfigValue(generatorAgent.recovery),
    metadata: cloneConfigValue(draft.agent.metadata),
    routing: cloneConfigValue(draft.agent.routing),
    capabilities: cloneConfigValue(draft.agent.capabilities),
  }) as AgentConfigFile;
}

function validateAgentCreateDraft(value: unknown): AgentCreateDraft {
  const root = expectObject(value, 'agent-create draft');
  const agent = expectObject(root.agent, 'agent-create draft.agent');
  const name = expectNonEmptyString(agent.name, 'agent-create draft.agent.name');
  const systemInstructions = expectNonEmptyString(agent.systemInstructions, 'agent-create draft.agent.systemInstructions');
  return {
    agent: compactObject({
      id: optionalTrimmedString(readOptionalString(agent.id, 'agent-create draft.agent.id')),
      name,
      description: optionalTrimmedString(readOptionalString(agent.description, 'agent-create draft.agent.description')),
      systemInstructions,
      capabilities: readOptionalObject(agent.capabilities, 'agent-create draft.agent.capabilities') as AgentCapabilityConfig | undefined,
      routing: readOptionalObject(agent.routing, 'agent-create draft.agent.routing'),
      metadata: readOptionalObject(agent.metadata, 'agent-create draft.agent.metadata'),
    }) as AgentCreateDraft['agent'],
    notes: readOptionalStringList(root.notes, 'agent-create draft.notes'),
    recommendations: readOptionalStringList(root.recommendations, 'agent-create draft.recommendations'),
  };
}

async function validateGeneratedAgentConfig(
  agent: AgentConfigFile,
  cwd: string,
  env: NodeJS.ProcessEnv,
  generatorConfig: ResolvedAgentSdkConfig,
): Promise<void> {
  await loadAgentSdkConfig({
    cwd,
    env,
    agentConfig: agent,
    settingsConfig: {
      version: 1,
      agents: { dirs: generatorConfig.agents.dirs },
      skills: generatorConfig.settings.skills,
      runtime: { mode: 'memory' },
    },
  });
}

function applyModelOverrides(
  model: AgentConfigFile['model'],
  overrides: { provider?: AgentCreateProvider; model?: string },
): AgentConfigFile['model'] {
  const next = { ...model };
  if (overrides.provider) {
    const providerChanged = next.provider !== undefined && next.provider !== overrides.provider;
    next.provider = overrides.provider;
    if (providerChanged) {
      delete next.apiKey;
      delete next.baseUrl;
      const apiKeyEnv = defaultApiKeyEnv(overrides.provider);
      if (apiKeyEnv) next.apiKeyEnv = apiKeyEnv;
      else delete next.apiKeyEnv;
    }
  }
  if (overrides.model) {
    next.model = overrides.model;
  }
  return next;
}

function defaultApiKeyEnv(provider: AgentCreateProvider): string | undefined {
  if (provider === 'openrouter') return 'OPENROUTER_API_KEY';
  if (provider === 'mistral') return 'MISTRAL_API_KEY';
  if (provider === 'mesh') return 'MESH_API_KEY';
  return undefined;
}

function agentCreateReportJson(report: AgentCreateReport): JsonObject {
  return {
    command: report.command,
    status: report.status,
    dryRun: report.dryRun,
    yes: report.yes,
    force: report.force,
    prompted: report.prompted,
    message: report.message,
    path: report.prepared.path,
    agentsDir: report.prepared.agentsDir,
    generatorAgent: report.prepared.generatorAgent,
    agent: report.prepared.agent as unknown as JsonValue,
    notes: report.prepared.notes,
    recommendations: report.prepared.recommendations,
  };
}

function formatDraftGenerationFailure(result: Exclude<RunResult, { status: 'success' }>): string {
  if (result.status === 'failure') {
    return `agent-create generator failed: ${result.error}`;
  }
  if (result.status === 'clarification_requested') {
    return `agent-create generator requested clarification: ${result.message}`;
  }
  return `agent-create generator requested approval for tool ${result.toolName}: ${result.message}`;
}

function expectObject(value: unknown, label: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function expectNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function readOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

function readOptionalObject(value: unknown, label: string): JsonObject | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return expectObject(value, label);
}

function readOptionalStringList(value: unknown, label: string): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const rawValues = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(rawValues)) {
    throw new Error(`${label} must be a string array`);
  }
  const values = rawValues.map((entry, index) => expectNonEmptyString(entry, `${label}[${index}]`));
  return values.length > 0 ? values : undefined;
}

function validateExplicitAgentId(value: string): string {
  const id = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) {
    throw new Error('--id must contain only letters, numbers, dot, underscore, and hyphen, and must start with a letter or number.');
  }
  return id;
}

function normalizeGeneratedAgentId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/g, '')
    .replace(/[^a-z0-9]+$/g, '')
    .replace(/-{2,}/g, '-');
  if (!normalized) {
    throw new Error('Generated agent id is empty after normalization.');
  }
  return normalized;
}

function optionalTrimmedString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function compactObject<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

function cloneConfigValue<T>(value: T | undefined): T | undefined {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

function formatList(values: readonly string[]): string[] {
  if (values.length === 0) {
    return ['  none'];
  }
  return values.map((value) => `  - ${value}`);
}

function indentBlock(value: string | undefined): string[] {
  const lines = value?.trim().split(/\r?\n/) ?? [];
  if (lines.length === 0) {
    return ['  (none)'];
  }
  return lines.map((line) => `  ${line}`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
