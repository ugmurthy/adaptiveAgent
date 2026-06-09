import { access, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { loadAgentSdkConfig, type AgentConfigFile, type AgentSettingsFile } from '../index.js';

export type InitProvider = 'openrouter' | 'ollama' | 'mistral' | 'mesh';
export type InitProfile = 'safe' | 'coding';
export type InitOutputFormat = 'pretty' | 'json' | 'jsonl';
export type InitActionStatus = 'created' | 'exists' | 'would_create' | 'overwritten' | 'failed';

export interface InitOptions {
  provider?: InitProvider;
  model?: string;
  apiKeyEnv?: string;
  profile?: InitProfile;
  cwd?: string;
  homeDir?: string;
  yes?: boolean;
  force?: boolean;
  dryRun?: boolean;
  output?: InitOutputFormat;
  env?: NodeJS.ProcessEnv;
}

export interface InitAction {
  path: string;
  kind: 'file' | 'directory';
  status: InitActionStatus;
  message: string;
}

export interface InitReport {
  command: 'init';
  homeDir: string;
  dryRun: boolean;
  yes: boolean;
  force: boolean;
  provider: InitProvider;
  model: string;
  profile: InitProfile;
  apiKeyEnv?: string;
  actions: InitAction[];
  settingsPath: string;
  defaultAgentPath: string;
  skillsDir: string;
}

const PROVIDER_DEFAULT_MODELS: Record<InitProvider, string> = {
  openrouter: 'qwen/qwen3.5-27b',
  mistral: 'mistral-small-2603',
  mesh: 'qwen/qwen3.5-27b',
  ollama: 'llama3.2',
};

const PROVIDER_DEFAULT_API_KEY_ENV: Partial<Record<InitProvider, string>> = {
  openrouter: 'OPENROUTER_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  mesh: 'MESH_API_KEY',
};

const SAFE_TOOLS = ['read_file', 'list_directory', 'web_search', 'read_web_page'];
const CODING_TOOLS = [...SAFE_TOOLS, 'write_file', 'shell_exec'];

export async function runInit(options: InitOptions = {}): Promise<InitReport> {
  const env = options.env ?? process.env;
  const cwd = resolve(options.cwd ?? process.cwd());
  const homeDir = resolve(options.homeDir ?? env.ADAPTIVE_AGENT_HOME ?? resolve(homedir(), '.adaptiveAgent'));
  const provider = options.provider ?? detectProvider(env) ?? 'openrouter';
  const model = options.model ?? PROVIDER_DEFAULT_MODELS[provider];
  const profile = options.profile ?? 'safe';
  const apiKeyEnv = provider === 'ollama' ? undefined : options.apiKeyEnv ?? PROVIDER_DEFAULT_API_KEY_ENV[provider];
  const settingsPath = resolve(homeDir, 'agent.settings.json');
  const agentsDir = resolve(homeDir, 'agents');
  const defaultAgentPath = resolve(agentsDir, 'default-agent.json');
  const skillsDir = resolve(homeDir, 'skills');
  const actions: InitAction[] = [];

  const settings: AgentSettingsFile = {
    version: 1,
    agents: { dirs: [agentsDir] },
    skills: { dirs: [skillsDir] },
    runtime: { mode: 'memory' },
  };
  const agent: AgentConfigFile = {
    id: 'default-agent',
    name: 'Default Agent',
    invocationModes: ['chat', 'run'],
    defaultInvocationMode: 'run',
    model: { provider, model, ...(apiKeyEnv ? { apiKeyEnv } : {}) },
    workspaceRoot: '.',
    systemInstructions: 'You are a helpful local agent.',
    tools: profile === 'coding' ? CODING_TOOLS : SAFE_TOOLS,
    delegates: [],
    defaults: { maxSteps: 30, capture: 'summary' },
  };

  await loadAgentSdkConfig({ cwd, env, agentConfig: agent, settingsConfig: settings });

  await ensureDirectory(homeDir, options, actions);
  await ensureDirectory(agentsDir, options, actions);
  await ensureDirectory(skillsDir, options, actions);
  await ensureDirectory(resolve(skillsDir, 'getting-started'), options, actions);
  await ensureFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, options, actions);
  await ensureFile(defaultAgentPath, `${JSON.stringify(agent, null, 2)}\n`, options, actions);
  await ensureFile(resolve(skillsDir, 'getting-started', 'SKILL.md'), gettingStartedSkill(), options, actions);

  return {
    command: 'init',
    homeDir,
    dryRun: options.dryRun ?? false,
    yes: options.yes ?? false,
    force: options.force ?? false,
    provider,
    model,
    profile,
    apiKeyEnv,
    actions,
    settingsPath,
    defaultAgentPath,
    skillsDir,
  };
}

export function renderInitReport(report: InitReport, output: InitOutputFormat = 'pretty'): string {
  if (output === 'json') return JSON.stringify(report, null, 2);
  if (output === 'jsonl') return [...report.actions.map((action) => JSON.stringify(action)), JSON.stringify({ command: 'init', summary: summarizeActions(report.actions) })].join('\n');
  const lines = [
    `Adaptive Agent initialized at ${report.homeDir}`,
    '',
    ...report.actions.map((action) => `${statusIcon(action.status)} ${action.status.padEnd(12)} ${action.path}`),
    '',
    'Next steps:',
  ];
  if (report.apiKeyEnv) {
    lines.push(`  export ${report.apiKeyEnv}=<your-key>`);
  }
  lines.push('  adaptive-agent doctor --provider-check');
  lines.push('  adaptive-agent run "Hello, confirm you are working"');
  return lines.join('\n');
}

function detectProvider(env: NodeJS.ProcessEnv): InitProvider | undefined {
  if (env.OPENROUTER_API_KEY) return 'openrouter';
  if (env.MESH_API_KEY) return 'mesh';
  if (env.MISTRAL_API_KEY) return 'mistral';
  return undefined;
}

async function ensureDirectory(path: string, options: InitOptions, actions: InitAction[]): Promise<void> {
  if (await pathExists(path)) {
    actions.push({ path, kind: 'directory', status: 'exists', message: 'Directory already exists.' });
    return;
  }
  if (options.dryRun) {
    actions.push({ path, kind: 'directory', status: 'would_create', message: 'Directory would be created.' });
    return;
  }
  await mkdir(path, { recursive: true });
  actions.push({ path, kind: 'directory', status: 'created', message: 'Directory created.' });
}

async function ensureFile(path: string, content: string, options: InitOptions, actions: InitAction[]): Promise<void> {
  if (await pathExists(path)) {
    if (!options.force) {
      actions.push({ path, kind: 'file', status: 'exists', message: 'File already exists; use --force to overwrite.' });
      return;
    }
    if (options.dryRun) {
      actions.push({ path, kind: 'file', status: 'would_create', message: 'File would be overwritten.' });
      return;
    }
    await writeFile(path, content);
    actions.push({ path, kind: 'file', status: 'overwritten', message: 'File overwritten.' });
    return;
  }
  if (options.dryRun) {
    actions.push({ path, kind: 'file', status: 'would_create', message: 'File would be created.' });
    return;
  }
  await writeFile(path, content);
  actions.push({ path, kind: 'file', status: 'created', message: 'File created.' });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function summarizeActions(actions: InitAction[]): Record<InitActionStatus, number> {
  return actions.reduce((summary, action) => ({ ...summary, [action.status]: (summary[action.status] ?? 0) + 1 }), {} as Record<InitActionStatus, number>);
}

function statusIcon(status: InitActionStatus): string {
  if (status === 'created' || status === 'overwritten' || status === 'would_create') return 'ok';
  if (status === 'exists') return '--';
  return '!!';
}

function gettingStartedSkill(): string {
  return `---\nname: getting-started\ndescription: Use for first-run orientation and setup checks.\n---\n\n# Getting Started\n\nConfirm the local configuration, explain missing provider setup clearly, and keep first-run actions read-only unless the user chooses a coding profile.\n`;
}
