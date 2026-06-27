import { access, copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, resolve } from 'node:path';

import { loadAgentSdkConfig, type AgentConfigFile, type AgentSettingsFile } from '../index.js';
import { BUNDLED_INSTALL_CATALOG, materializeBundledAgent, type BundledSkillAsset } from './bundled-assets.js';

export type InitProvider = 'openrouter' | 'ollama' | 'mistral' | 'mesh';
export type InitProfile = 'safe' | 'coding';
export type InitOutputFormat = 'pretty' | 'json' | 'jsonl';
export type InitActionStatus = 'created' | 'exists' | 'would_create' | 'overwritten' | 'failed';

export interface InitOptions {
  provider?: InitProvider;
  model?: string;
  apiKeyEnv?: string;
  profile?: InitProfile;
  minimal?: boolean;
  bundles?: string[];
  installAgents?: string[];
  installSkills?: string[];
  installManifests?: string[];
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
  bundles: string[];
}

type InstallManifestEntry = string | { source: string; dest?: string };

interface InitInstallManifest {
  version?: 1;
  bundles?: string[];
  agents?: InstallManifestEntry[];
  skills?: InstallManifestEntry[];
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

const SAFE_TOOLS = ['read_file', 'list_directory', 'search_files', 'web_search', 'read_web_page'];
const CODING_TOOLS = [...SAFE_TOOLS, 'write_file', 'edit_file', 'shell_exec'];

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

  const bundles = resolveRequestedBundles(options);
  await installBundledBundles(bundles, { agentsDir, skillsDir, provider, model, apiKeyEnv }, options, actions);
  const manifestBundles = await installManifestInputs(options.installManifests ?? [], { cwd, agentsDir, skillsDir, provider, model, apiKeyEnv }, options, actions);
  await installAgentInputs(options.installAgents ?? [], cwd, agentsDir, options, actions);
  await installSkillInputs(options.installSkills ?? [], cwd, skillsDir, options, actions);
  const installedBundles = [...new Set([...bundles, ...manifestBundles])];

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
    bundles: installedBundles,
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
  ];
  if (report.bundles.length > 0) {
    lines.push(`Installed bundled assets: ${report.bundles.join(', ')}`);
    lines.push('');
  }
  lines.push('Next steps:');
  if (report.apiKeyEnv) {
    lines.push(`  export ${report.apiKeyEnv}=<your-key>`);
  }
  lines.push('  adaptive-agent doctor --provider-check');
  lines.push('  adaptive-agent run "Hello, confirm you are working"');
  return lines.join('\n');
}

function resolveRequestedBundles(options: InitOptions): string[] {
  if (options.minimal) return [];
  const requested = options.bundles?.length ? options.bundles : BUNDLED_INSTALL_CATALOG.defaultBundles;
  return [...new Set(requested)];
}

async function installBundledBundles(
  bundleNames: string[],
  context: { agentsDir: string; skillsDir: string; provider: InitProvider; model: string; apiKeyEnv?: string },
  options: InitOptions,
  actions: InitAction[],
): Promise<void> {
  const installedAgents = new Set<string>();
  const installedSkills = new Set<string>();
  for (const bundleName of bundleNames) {
    const bundle = BUNDLED_INSTALL_CATALOG.bundles[bundleName];
    if (!bundle) throw new Error(`Unknown init bundle "${bundleName}". Available bundles: ${Object.keys(BUNDLED_INSTALL_CATALOG.bundles).sort().join(', ')}`);
    for (const agentId of bundle.agents) {
      if (installedAgents.has(agentId)) continue;
      const asset = BUNDLED_INSTALL_CATALOG.agents[agentId];
      if (!asset) throw new Error(`Init bundle "${bundleName}" references unknown bundled agent "${agentId}".`);
      const agent = materializeBundledAgent(asset, context.provider, context.model, context.apiKeyEnv);
      await loadAgentSdkConfig({ agentConfig: agent, settingsConfig: { runtime: { mode: 'memory' } }, env: {} });
      await ensureFile(resolve(context.agentsDir, asset.fileName), `${JSON.stringify(agent, null, 2)}\n`, options, actions);
      installedAgents.add(agentId);
    }
    for (const skillName of bundle.skills) {
      if (installedSkills.has(skillName)) continue;
      const asset = BUNDLED_INSTALL_CATALOG.skills[skillName];
      if (!asset) throw new Error(`Init bundle "${bundleName}" references unknown bundled skill "${skillName}".`);
      await installBundledSkill(asset, context.skillsDir, options, actions);
      installedSkills.add(skillName);
    }
  }
}

async function installBundledSkill(asset: BundledSkillAsset, skillsDir: string, options: InitOptions, actions: InitAction[]): Promise<void> {
  const skillDir = resolve(skillsDir, asset.name);
  await ensureDirectory(skillDir, options, actions);
  for (const [relativePath, content] of Object.entries(asset.files)) {
    await ensureFile(resolve(skillDir, relativePath), content, options, actions);
  }
}

async function installManifestInputs(
  manifestPaths: string[],
  context: { cwd: string; agentsDir: string; skillsDir: string; provider: InitProvider; model: string; apiKeyEnv?: string },
  options: InitOptions,
  actions: InitAction[],
): Promise<string[]> {
  const installedBundles: string[] = [];
  for (const manifestPath of manifestPaths) {
    const path = resolve(context.cwd, manifestPath);
    const manifest = parseInstallManifest(await readFile(path, 'utf-8'), path);
    if (manifest.bundles?.length) {
      await installBundledBundles(manifest.bundles, context, options, actions);
      installedBundles.push(...manifest.bundles);
    }
    const manifestDir = dirname(path);
    await installAgentEntries(manifest.agents ?? [], manifestDir, context.agentsDir, options, actions);
    await installSkillEntries(manifest.skills ?? [], manifestDir, context.skillsDir, options, actions);
  }
  return installedBundles;
}

function parseInstallManifest(raw: string, path: string): InitInstallManifest {
  const parsed = JSON.parse(raw) as InitInstallManifest;
  if (parsed.version !== undefined && parsed.version !== 1) throw new Error(`Unsupported install manifest version in ${path}: ${String(parsed.version)}`);
  if (parsed.bundles !== undefined && !Array.isArray(parsed.bundles)) throw new Error(`Install manifest ${path} field "bundles" must be an array.`);
  if (parsed.agents !== undefined && !Array.isArray(parsed.agents)) throw new Error(`Install manifest ${path} field "agents" must be an array.`);
  if (parsed.skills !== undefined && !Array.isArray(parsed.skills)) throw new Error(`Install manifest ${path} field "skills" must be an array.`);
  return parsed;
}

async function installAgentInputs(inputs: string[], cwd: string, agentsDir: string, options: InitOptions, actions: InitAction[]): Promise<void> {
  await installAgentEntries(inputs, cwd, agentsDir, options, actions);
}

async function installAgentEntries(entries: InstallManifestEntry[], baseDir: string, agentsDir: string, options: InitOptions, actions: InitAction[]): Promise<void> {
  for (const entry of entries) {
    const source = resolve(baseDir, typeof entry === 'string' ? entry : entry.source);
    const dest = typeof entry === 'string' ? undefined : entry.dest;
    const sourceStat = await stat(source);
    if (sourceStat.isDirectory()) {
      if (dest) throw new Error(`Agent directory install source ${source} cannot use a single dest override.`);
      const children = await readdir(source, { withFileTypes: true });
      for (const child of children) {
        if (!child.isFile() || extname(child.name).toLowerCase() !== '.json') continue;
        await installAgentFile(resolve(source, child.name), agentsDir, undefined, options, actions);
      }
      continue;
    }
    await installAgentFile(source, agentsDir, dest, options, actions);
  }
}

async function installAgentFile(source: string, agentsDir: string, dest: string | undefined, options: InitOptions, actions: InitAction[]): Promise<void> {
  if (extname(source).toLowerCase() !== '.json') throw new Error(`Agent install source must be a .json file: ${source}`);
  const raw = await readFile(source, 'utf-8');
  const agent = JSON.parse(raw) as AgentConfigFile;
  await loadAgentSdkConfig({ agentConfig: agent, settingsConfig: { runtime: { mode: 'memory' } }, env: {} });
  const destFileName = dest ?? basename(source);
  if (destFileName.includes('/') || destFileName.includes('\\')) throw new Error(`Agent install dest must be a file name, got: ${destFileName}`);
  await ensureFile(resolve(agentsDir, destFileName), raw.endsWith('\n') ? raw : `${raw}\n`, options, actions);
}

async function installSkillInputs(inputs: string[], cwd: string, skillsDir: string, options: InitOptions, actions: InitAction[]): Promise<void> {
  await installSkillEntries(inputs, cwd, skillsDir, options, actions);
}

async function installSkillEntries(entries: InstallManifestEntry[], baseDir: string, skillsDir: string, options: InitOptions, actions: InitAction[]): Promise<void> {
  for (const entry of entries) {
    const source = resolve(baseDir, typeof entry === 'string' ? entry : entry.source);
    const dest = typeof entry === 'string' ? undefined : entry.dest;
    const sourceStat = await stat(source);
    if (!sourceStat.isDirectory()) throw new Error(`Skill install source must be a directory: ${source}`);
    if (await pathExists(resolve(source, 'SKILL.md'))) {
      await installSkillDirectory(source, skillsDir, dest, options, actions);
      continue;
    }
    if (dest) throw new Error(`Skill parent directory install source ${source} cannot use a single dest override.`);
    const children = await readdir(source, { withFileTypes: true });
    for (const child of children) {
      if (!child.isDirectory()) continue;
      const childPath = resolve(source, child.name);
      if (await pathExists(resolve(childPath, 'SKILL.md'))) {
        await installSkillDirectory(childPath, skillsDir, undefined, options, actions);
      }
    }
  }
}

async function installSkillDirectory(source: string, skillsDir: string, dest: string | undefined, options: InitOptions, actions: InitAction[]): Promise<void> {
  const rawSkill = await readFile(resolve(source, 'SKILL.md'), 'utf-8');
  const skillName = dest ?? readSkillName(rawSkill, source);
  if (skillName.includes('/') || skillName.includes('\\')) throw new Error(`Skill install dest must be a directory name, got: ${skillName}`);
  await copyDirectory(source, resolve(skillsDir, skillName), options, actions);
}

function readSkillName(content: string, source: string): string {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) throw new Error(`SKILL.md at ${source} is missing YAML frontmatter.`);
  const endIndex = trimmed.indexOf('---', 3);
  if (endIndex === -1) throw new Error(`SKILL.md at ${source} is missing closing YAML frontmatter marker.`);
  const frontmatter = trimmed.slice(3, endIndex).split('\n');
  for (const line of frontmatter) {
    const value = line.trim();
    if (!value.startsWith('name:')) continue;
    const name = value.slice('name:'.length).trim().replace(/^['"]|['"]$/g, '');
    if (name) return name;
  }
  throw new Error(`SKILL.md at ${source} is missing required frontmatter field "name".`);
}

async function copyDirectory(source: string, target: string, options: InitOptions, actions: InitAction[]): Promise<void> {
  await ensureDirectory(target, options, actions);
  const children = await readdir(source, { withFileTypes: true });
  for (const child of children) {
    const childSource = resolve(source, child.name);
    const childTarget = resolve(target, child.name);
    if (child.isDirectory()) {
      await copyDirectory(childSource, childTarget, options, actions);
      continue;
    }
    if (child.isFile()) {
      await copyFileWithAction(childSource, childTarget, options, actions);
    }
  }
}

async function copyFileWithAction(source: string, target: string, options: InitOptions, actions: InitAction[]): Promise<void> {
  if (await pathExists(target)) {
    if (!options.force) {
      actions.push({ path: target, kind: 'file', status: 'exists', message: 'File already exists; use --force to overwrite.' });
      return;
    }
    if (options.dryRun) {
      actions.push({ path: target, kind: 'file', status: 'would_create', message: 'File would be overwritten.' });
      return;
    }
    await copyFile(source, target);
    actions.push({ path: target, kind: 'file', status: 'overwritten', message: 'File overwritten.' });
    return;
  }
  if (options.dryRun) {
    actions.push({ path: target, kind: 'file', status: 'would_create', message: 'File would be created.' });
    return;
  }
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
  actions.push({ path: target, kind: 'file', status: 'created', message: 'File created.' });
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
