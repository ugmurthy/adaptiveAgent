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
  type ReadWebPageProvider,
  type ToolDefinition,
  type WebSearchProvider,
} from '@adaptive-agent/core';

import type {
  AgentConfigFile,
  AgentSdkCatalogAgent,
  AgentSdkCatalogDiagnostic,
  AgentSdkCatalogDelegate,
  AgentSdkOptions,
  ResolvedAgentSdkConfig,
} from './config-types.js';
import type { GatewayClient } from '@adaptive-agent/gateway-client';
import { createGatewayProxyTool } from './gateway-tools.js';
import { resolveAgentSdkConfig } from './config-resolve.js';
import { validateAgent } from './config-validate.js';
import { prepareSkillHandlerModule } from './skill-handler-preparation.js';
import { agentConfigurationFingerprint, expandStrings, parseNonNegativeNumber, parsePositiveInteger, pathExists, readJson } from './sdk-utils.js';

const DEFAULT_MODULE_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

export async function resolveToolsAndDelegates(config: ResolvedAgentSdkConfig, options: AgentSdkOptions, gatewayClient?: GatewayClient): Promise<{ tools: Array<ToolDefinition<any, any>>; delegates: DelegateDefinition[]; registeredTools: Array<ToolDefinition<any, any>>; registeredToolNames: string[] }> {
  process.env.ADAPTIVE_AGENT_MODULE_ROOT ??= DEFAULT_MODULE_ROOT;

  const env = { ...(options.env ?? process.env), ...(config.settings.env ?? {}) };
  const builtins = createBuiltinTools(config.workspaceRoot, config.shellCwd, env);
  const gatewayTools = new Map<string, ToolDefinition<any, any>>();
  if (config.inference.mode === 'gateway' && gatewayClient) {
    for (const toolName of config.gateway.remoteTools) gatewayTools.set(toolName, createGatewayProxyTool({ client: gatewayClient, toolName }));
  }
  const providedTools = new Map((options.tools ?? []).map((tool) => [tool.name, tool]));
  const registry = new Map([...builtins, ...gatewayTools, ...providedTools]);
  const registeredToolNames = [...registry.keys()].sort();
  const registeredTools = registeredToolNames.map((toolName) => registry.get(toolName)!);
  const missing = config.agent.tools.filter((name) => !registry.has(name));
  if (missing.length) throw new Error(`Unknown tool reference(s): ${missing.join(', ')}. Registered tools: ${registeredToolNames.join(', ') || '(none)'}.`);
  const tools = config.agent.tools.map((name) => registry.get(name)!);
  const delegates = [...(options.delegates ?? []), ...(await loadDelegates(config.agent.delegates ?? [], config.skills.dirs, new Set(tools.map((tool) => tool.name)), env))];
  for (const delegate of delegates) {
    const unavailable = delegate.allowedTools.filter((name) => !registry.has(name));
    if (unavailable.length) throw new Error(`Delegate "${delegate.name}" requires unavailable tool(s): ${unavailable.join(', ')}.`);
  }
  return { tools, delegates, registeredTools, registeredToolNames };
}

function createBuiltinTools(workspaceRoot: string, shellCwd: string, env: NodeJS.ProcessEnv): Map<string, ToolDefinition<any, any>> {
  const tools = new Map<string, ToolDefinition<any, any>>();
  tools.set('read_file', createReadFileTool({
    allowedRoots: (context) => [
      context.executionContext?.fileAccess?.workspaceRoot ?? workspaceRoot,
      ...(context.executionContext?.fileAccess?.attachmentRoots ?? []),
    ],
  }));
  tools.set('list_directory', createListDirectoryTool({ allowedRoot: workspaceRoot }));
  tools.set('search_files', createSearchFilesTool({ allowedRoot: workspaceRoot }));
  tools.set('write_file', createWriteFileTool({ allowedRoot: workspaceRoot }));
  tools.set('edit_file', createEditFileTool({ allowedRoot: workspaceRoot }));
  tools.set('shell_exec', createShellExecTool({ cwd: shellCwd }));
  const timeoutMs = parsePositiveInteger(env.WEB_TOOL_TIMEOUT_MS);
  const webSearchProvider = resolveWebSearchProvider(env);
  const webSearchCost = resolveWebSearchCostPerRequest(env, webSearchProvider);
  if (webSearchProvider === 'brave') tools.set('web_search', createWebSearchTool({ provider: 'brave', apiKey: env.BRAVE_SEARCH_API_KEY!, timeoutMs, estimatedCostPerRequestUSD: webSearchCost }));
  else if (webSearchProvider === 'serper') tools.set('web_search', createWebSearchTool({ provider: 'serper', apiKey: env.SERPER_API_KEY!, timeoutMs, estimatedCostPerRequestUSD: webSearchCost }));
  else if (webSearchProvider === 'parallel') tools.set('web_search', createWebSearchTool({ provider: 'parallel', apiKey: env.PARALLEL_API_KEY!, timeoutMs, estimatedCostPerRequestUSD: webSearchCost }));
  else tools.set('web_search', createWebSearchTool({ provider: 'duckduckgo', timeoutMs, estimatedCostPerRequestUSD: webSearchCost }));
  const readWebPageProvider = resolveReadWebPageProvider(env);
  const readWebPageCost = resolveReadWebPageCostPerRequest(env, readWebPageProvider);
  tools.set(
    'read_web_page',
    readWebPageProvider === 'parallel'
      ? createReadWebPageTool({ provider: 'parallel', apiKey: env.PARALLEL_API_KEY!, timeoutMs, estimatedCostPerRequestUSD: readWebPageCost })
      : createReadWebPageTool({ provider: 'direct', timeoutMs, estimatedCostPerRequestUSD: readWebPageCost }),
  );
  return tools;
}

export function resolveWebSearchProvider(env: NodeJS.ProcessEnv): WebSearchProvider {
  if (env.WEB_SEARCH_PROVIDER === 'brave' && env.BRAVE_SEARCH_API_KEY) return 'brave';
  if (env.WEB_SEARCH_PROVIDER === 'serper' && env.SERPER_API_KEY) return 'serper';
  if (env.WEB_SEARCH_PROVIDER === 'parallel' && env.PARALLEL_API_KEY) return 'parallel';
  return 'duckduckgo';
}

export function resolveReadWebPageProvider(env: NodeJS.ProcessEnv): ReadWebPageProvider {
  if (env.WEB_READ_PAGE_PROVIDER === 'parallel' && env.PARALLEL_API_KEY) return 'parallel';
  return 'direct';
}

function resolveWebSearchCostPerRequest(env: NodeJS.ProcessEnv, provider: WebSearchProvider): number | undefined {
  const providerEnvName = `${provider.toUpperCase()}_SEARCH_COST_USD_PER_REQUEST`;
  return parseNonNegativeNumber(env[providerEnvName])
    ?? parseNonNegativeNumber(env.WEB_SEARCH_COST_USD_PER_REQUEST);
}

function resolveReadWebPageCostPerRequest(env: NodeJS.ProcessEnv, provider: ReadWebPageProvider): number | undefined {
  if (provider === 'parallel') {
    return parseNonNegativeNumber(env.PARALLEL_EXTRACT_COST_USD_PER_REQUEST)
      ?? parseNonNegativeNumber(env.WEB_READ_PAGE_COST_USD_PER_REQUEST);
  }
  return parseNonNegativeNumber(env.DIRECT_READ_PAGE_COST_USD_PER_REQUEST)
    ?? parseNonNegativeNumber(env.WEB_READ_PAGE_COST_USD_PER_REQUEST);
}

async function loadDelegates(names: string[], dirs: string[], availableTools: Set<string>, env: NodeJS.ProcessEnv): Promise<DelegateDefinition[]> {
  const delegates = new Map<string, DelegateDefinition>();
  for (const dir of dirs) {
    if (!(await pathExists(dir))) continue;
    for (const name of names) {
      if (delegates.has(name)) continue;
      const skillDir = resolve(dir, name);
      if (!(await pathExists(skillDir))) continue;
      const delegate = skillToDelegate(await loadSkillFromDirectory(skillDir, {
        resolveHandlerModule: async (request) => (await prepareSkillHandlerModule(request, { env })).modulePath,
      }));
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

export async function discoverCatalogAgents(config: ResolvedAgentSdkConfig, activeAgentPath: string, options: AgentSdkOptions = {}): Promise<AgentSdkCatalogAgent[]> {
  return (await discoverCatalogAgentInventory(config, activeAgentPath, options)).agents;
}

export async function discoverCatalogAgentInventory(config: ResolvedAgentSdkConfig, activeAgentPath: string, options: AgentSdkOptions = {}): Promise<{ agents: AgentSdkCatalogAgent[]; diagnostics: AgentSdkCatalogDiagnostic[] }> {
  const activeArchived = config.agents.dirs.some((dir) => dirname(activeAgentPath) === resolve(dir, '.archive'));
  const agents: AgentSdkCatalogAgent[] = [agentConfigToCatalogAgent(config.agent, activeAgentPath, true, activeArchived, agentConfigurationFingerprint(config))];
  const diagnostics: AgentSdkCatalogDiagnostic[] = [];
  const seenPaths = new Set([activeAgentPath]);
  const env = { ...(options.env ?? process.env), ...(config.settings.env ?? {}) };

  for (const dir of config.agents.dirs) {
    if (!(await pathExists(dir))) continue;
    for (const source of [{ path: dir, archived: false }, { path: resolve(dir, '.archive'), archived: true }]) {
      const entries = await readdir(source.path, { withFileTypes: true }).catch(() => []);
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.json') continue;
        const path = resolve(source.path, entry.name);
        if (seenPaths.has(path)) continue;
        seenPaths.add(path);
        try {
          const agent = validateAgent(expandStrings(await readJson(path), env), path);
          const resolved = await resolveAgentSdkConfig({
            ...options,
            agentConfig: agent,
            agentConfigPath: undefined,
            settingsConfig: {
              ...config.settings,
              agent: { ...config.settings.agent, id: agent.id, configPath: path },
            },
            settingsConfigPath: undefined,
            settingsOverrides: undefined,
          });
          agents.push(agentConfigToCatalogAgent(agent, path, path === activeAgentPath, source.archived, agentConfigurationFingerprint(resolved)));
        } catch (error) {
          diagnostics.push({ code: 'invalid-profile', path, message: safeErrorMessage(error) });
        }
      }
    }
  }

  const byId = new Map<string, AgentSdkCatalogAgent[]>();
  for (const agent of agents) byId.set(agent.id, [...(byId.get(agent.id) ?? []), agent]);
  for (const [id, matches] of byId) {
    if (matches.length < 2) continue;
    const paths = matches.map((agent) => agent.path).sort();
    for (const agent of matches) agent.validationState = 'duplicate-id';
    diagnostics.push({ code: 'duplicate-agent-id', path: paths[0]!, relatedPaths: paths.slice(1), message: `Agent id "${id}" is declared by ${paths.length} profiles.` });
  }

  agents.sort((left, right) => Number(right.active) - Number(left.active) || left.id.localeCompare(right.id) || left.path.localeCompare(right.path));
  diagnostics.sort((left, right) => left.path.localeCompare(right.path) || left.code.localeCompare(right.code));
  return { agents, diagnostics };
}

function agentConfigToCatalogAgent(agent: AgentConfigFile, path: string, active: boolean, archived: boolean, configurationFingerprint: string): AgentSdkCatalogAgent {
  return {
    id: agent.id,
    name: agent.name,
    ...(agent.description ? { description: agent.description } : {}),
    configPath: path,
    path,
    active,
    archived,
    configurationFingerprint,
    validationState: 'valid',
    invocationModes: agent.invocationModes,
    defaultInvocationMode: agent.defaultInvocationMode,
    ...(agent.model.provider ? { provider: agent.model.provider } : {}),
    ...(agent.model.model ? { model: agent.model.model } : {}),
    tools: agent.tools,
    delegates: agent.delegates ?? [],
    ...(agent.capabilities ? { capabilities: agent.capabilities } : {}),
  };
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Invalid agent profile.';
  return message.replace(/[\r\n]+/g, ' ').slice(0, 500);
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
