import { readFile, readdir } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createEditFileTool,
  createListDirectoryTool,
  createReadFileTool,
  createReadWebPageTool,
  createSearchFilesTool,
  createShellExecTool,
  createWebSearchTool,
  createWriteFileTool,
  loadSkillFromDirectory,
  skillToDelegate,
  type DelegateDefinition,
  type ToolDefinition,
  type WebSearchProvider,
} from '@adaptive-agent/core';

import type {
  AgentConfigFile,
  AgentSdkCatalogAgent,
  AgentSdkCatalogDelegate,
  AgentSdkOptions,
  ResolvedAgentSdkConfig,
} from './config-types.js';
import { validateAgent } from './config-validate.js';
import { expandStrings, parsePositiveInteger, pathExists, readJson } from './sdk-utils.js';

const DEFAULT_MODULE_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

export async function resolveToolsAndDelegates(config: ResolvedAgentSdkConfig, options: AgentSdkOptions): Promise<{ tools: Array<ToolDefinition<any, any>>; delegates: DelegateDefinition[]; registeredTools: Array<ToolDefinition<any, any>>; registeredToolNames: string[] }> {
  process.env.ADAPTIVE_AGENT_MODULE_ROOT ??= DEFAULT_MODULE_ROOT;

  const env = { ...(options.env ?? process.env), ...(config.settings.env ?? {}) };
  const builtins = createBuiltinTools(config.workspaceRoot, config.shellCwd, env);
  const providedTools = new Map((options.tools ?? []).map((tool) => [tool.name, tool]));
  const registry = new Map([...builtins, ...providedTools]);
  const registeredToolNames = [...registry.keys()].sort();
  const registeredTools = registeredToolNames.map((toolName) => registry.get(toolName)!);
  const missing = config.agent.tools.filter((name) => !registry.has(name));
  if (missing.length) throw new Error(`Unknown tool reference(s): ${missing.join(', ')}. Registered tools: ${registeredToolNames.join(', ') || '(none)'}.`);
  const tools = config.agent.tools.map((name) => registry.get(name)!);
  const delegates = [...(options.delegates ?? []), ...(await loadDelegates(config.agent.delegates ?? [], config.skills.dirs, new Set(tools.map((tool) => tool.name))))];
  return { tools, delegates, registeredTools, registeredToolNames };
}

function createBuiltinTools(workspaceRoot: string, shellCwd: string, env: NodeJS.ProcessEnv): Map<string, ToolDefinition<any, any>> {
  const tools = new Map<string, ToolDefinition<any, any>>();
  tools.set('read_file', createReadFileTool({ allowedRoot: workspaceRoot }));
  tools.set('list_directory', createListDirectoryTool({ allowedRoot: workspaceRoot }));
  tools.set('search_files', createSearchFilesTool({ allowedRoot: workspaceRoot }));
  tools.set('write_file', createWriteFileTool({ allowedRoot: workspaceRoot }));
  tools.set('edit_file', createEditFileTool({ allowedRoot: workspaceRoot }));
  tools.set('shell_exec', createShellExecTool({ cwd: shellCwd }));
  const timeoutMs = parsePositiveInteger(env.WEB_TOOL_TIMEOUT_MS);
  const webSearchProvider = resolveWebSearchProvider(env);
  if (webSearchProvider === 'brave') tools.set('web_search', createWebSearchTool({ provider: 'brave', apiKey: env.BRAVE_SEARCH_API_KEY!, timeoutMs }));
  else if (webSearchProvider === 'serper') tools.set('web_search', createWebSearchTool({ provider: 'serper', apiKey: env.SERPER_API_KEY!, timeoutMs }));
  else tools.set('web_search', createWebSearchTool({ provider: 'duckduckgo', timeoutMs }));
  tools.set('read_web_page', createReadWebPageTool({ timeoutMs }));
  return tools;
}

export function resolveWebSearchProvider(env: NodeJS.ProcessEnv): WebSearchProvider {
  if (env.WEB_SEARCH_PROVIDER === 'brave' && env.BRAVE_SEARCH_API_KEY) return 'brave';
  if (env.WEB_SEARCH_PROVIDER === 'serper' && env.SERPER_API_KEY) return 'serper';
  return 'duckduckgo';
}

async function loadDelegates(names: string[], dirs: string[], availableTools: Set<string>): Promise<DelegateDefinition[]> {
  const delegates = new Map<string, DelegateDefinition>();
  for (const dir of dirs) {
    if (!(await pathExists(dir))) continue;
    for (const name of names) {
      if (delegates.has(name)) continue;
      const skillDir = resolve(dir, name);
      if (!(await pathExists(skillDir))) continue;
      const delegate = skillToDelegate(await loadSkillFromDirectory(skillDir));
      if (delegate.name !== name) throw new Error(`Delegate "${name}" loaded from ${skillDir} declared skill name "${delegate.name}".`);
      const missing = delegate.allowedTools.filter((tool) => !availableTools.has(tool));
      if (missing.length) throw new Error(`Delegate "${name}" requires unavailable tool(s): ${missing.join(', ')}.`);
      delegates.set(name, delegate);
    }
  }
  const missing = names.filter((name) => !delegates.has(name));
  if (missing.length) throw new Error(`Unable to load delegate(s): ${missing.join(', ')}. Skill search dirs: ${dirs.join(', ') || '(none)'}.`);
  return names.map((name) => delegates.get(name)!);
}

export async function discoverCatalogAgents(config: ResolvedAgentSdkConfig, activeAgentPath: string): Promise<AgentSdkCatalogAgent[]> {
  const agents: AgentSdkCatalogAgent[] = [agentConfigToCatalogAgent(config.agent, activeAgentPath, true)];
  const seenPaths = new Set([activeAgentPath]);
  const env = { ...process.env, ...(config.settings.env ?? {}) };

  for (const dir of config.agents.dirs) {
    if (!(await pathExists(dir))) continue;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.json') continue;
      const path = resolve(dir, entry.name);
      if (seenPaths.has(path)) continue;
      const agent = await readCatalogAgent(path, env);
      if (!agent) continue;
      agents.push(agentConfigToCatalogAgent(agent, path, path === activeAgentPath));
      seenPaths.add(path);
    }
  }

  return agents.sort((left, right) => Number(right.active) - Number(left.active) || left.id.localeCompare(right.id) || left.path.localeCompare(right.path));
}

async function readCatalogAgent(path: string, env: NodeJS.ProcessEnv): Promise<AgentConfigFile | undefined> {
  try {
    return validateAgent(expandStrings(await readJson(path), env), path);
  } catch {
    return undefined;
  }
}

function agentConfigToCatalogAgent(agent: AgentConfigFile, path: string, active: boolean): AgentSdkCatalogAgent {
  return {
    id: agent.id,
    name: agent.name,
    ...(agent.description ? { description: agent.description } : {}),
    path,
    active,
    invocationModes: agent.invocationModes,
    defaultInvocationMode: agent.defaultInvocationMode,
    ...(agent.model.provider ? { provider: agent.model.provider } : {}),
    ...(agent.model.model ? { model: agent.model.model } : {}),
    tools: agent.tools,
    delegates: agent.delegates ?? [],
    ...(agent.capabilities ? { capabilities: agent.capabilities } : {}),
  };
}

export async function discoverCatalogDelegates(config: ResolvedAgentSdkConfig, configuredDelegateNames: Set<string>): Promise<AgentSdkCatalogDelegate[]> {
  const delegates = new Map<string, AgentSdkCatalogDelegate>();

  for (const dir of config.skills.dirs) {
    if (!(await pathExists(dir))) continue;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = resolve(dir, entry.name, 'SKILL.md');
      if (!(await pathExists(skillPath))) continue;
      const delegate = await readCatalogDelegate(skillPath, configuredDelegateNames);
      if (!delegate || delegates.has(delegate.name)) continue;
      delegates.set(delegate.name, delegate);
    }
  }

  return [...delegates.values()].sort((left, right) => Number(right.configured) - Number(left.configured) || left.name.localeCompare(right.name) || left.path.localeCompare(right.path));
}

async function readCatalogDelegate(skillPath: string, configuredDelegateNames: Set<string>): Promise<AgentSdkCatalogDelegate | undefined> {
  let raw: string;
  try {
    raw = await readFile(skillPath, 'utf-8');
  } catch {
    return undefined;
  }

  // Metadata-only scan: listing the catalog must not import handler modules.
  const metadata = parseCatalogFrontmatter(raw);
  const name = readCatalogString(metadata, 'name');
  const description = readCatalogString(metadata, 'description');
  if (!name || !description) return undefined;
  const triggers = readCatalogStringArray(metadata, 'triggers');
  const handler = readCatalogString(metadata, 'handler');

  return {
    name,
    description,
    path: dirname(skillPath),
    configured: configuredDelegateNames.has(name),
    allowedTools: readCatalogStringArray(metadata, 'allowedTools') ?? [],
    ...(triggers?.length ? { triggers } : {}),
    ...(handler ? { handler } : {}),
  };
}

function parseCatalogFrontmatter(content: string): Record<string, string | string[]> {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) return {};
  const endIndex = trimmed.indexOf('---', 3);
  if (endIndex === -1) return {};

  const result: Record<string, string | string[]> = {};
  const lines = trimmed.slice(3, endIndex).trim().split('\n');
  let currentKey: string | undefined;
  let currentList: string[] | undefined;

  for (const line of lines) {
    const value = line.trim();
    if (!value || value.startsWith('#')) continue;
    if (value.startsWith('- ') && currentKey && currentList) {
      currentList.push(unquoteCatalogValue(value.slice(2).trim()));
      continue;
    }
    if (currentKey && currentList) {
      result[currentKey] = currentList;
      currentKey = undefined;
      currentList = undefined;
    }

    const colonIndex = value.indexOf(':');
    if (colonIndex === -1) continue;
    const key = value.slice(0, colonIndex).trim();
    const rawValue = value.slice(colonIndex + 1).trim();
    if (!rawValue) {
      currentKey = key;
      currentList = [];
      continue;
    }
    result[key] = parseInlineCatalogArray(rawValue) ?? unquoteCatalogValue(rawValue);
  }

  if (currentKey && currentList) {
    result[currentKey] = currentList;
  }
  return result;
}

function parseInlineCatalogArray(value: string): string[] | undefined {
  if (!value.startsWith('[') || !value.endsWith(']')) return undefined;
  return value.slice(1, -1).split(',').map((entry) => unquoteCatalogValue(entry.trim())).filter(Boolean);
}

function unquoteCatalogValue(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function readCatalogString(metadata: Record<string, string | string[]>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readCatalogStringArray(metadata: Record<string, string | string[]>, key: string): string[] | undefined {
  const value = metadata[key];
  return Array.isArray(value) ? value.filter((entry) => entry.trim()) : undefined;
}
