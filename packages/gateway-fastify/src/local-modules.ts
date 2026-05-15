import { access, readdir } from 'node:fs/promises';
import { delimiter } from 'node:path';
import { join, resolve } from 'node:path';

import { createJwtAuthProvider } from './auth.js';
import { createBuiltinTools, loadSkillDelegateFromDirectory, type DelegateDefinition } from './core.js';
import { ADAPTIVE_AGENT_ARTIFACTS_DIR, GATEWAY_SKILLS_DIR } from './local-dev.js';
import { createModuleRegistry, type ModuleRegistry } from './registries.js';

export interface CreateLocalModuleRegistryOptions {
  workspaceRoot?: string;
  skillDirectories?: string[];
  requiredDelegateNames?: string[];
}

export async function createLocalModuleRegistry(
  options: CreateLocalModuleRegistryOptions = {},
): Promise<ModuleRegistry> {
  const workspaceRoot = resolve(options.workspaceRoot ?? ADAPTIVE_AGENT_ARTIFACTS_DIR);
  const tools = await createBuiltinTools({
    rootDir: workspaceRoot,
    webSearchProvider: readWebSearchProvider(process.env.WEB_SEARCH_PROVIDER),
    braveSearchApiKey: process.env.BRAVE_SEARCH_API_KEY,
    webToolTimeoutMs: parseOptionalPositiveInteger(process.env.WEB_TOOL_TIMEOUT_MS),
  });
  const delegates = await loadLocalSkillDelegates({
    availableToolNames: new Set(tools.map((tool) => tool.name)),
    requiredDelegateNames: options.requiredDelegateNames,
    skillDirectories: options.skillDirectories ?? defaultSkillDirectories(),
  });

  return createModuleRegistry({
    tools,
    delegates,
    authProviders: [createJwtAuthProvider()],
  });
}

async function loadLocalSkillDelegates(options: {
  availableToolNames: Set<string>;
  requiredDelegateNames?: string[];
  skillDirectories: string[];
}): Promise<DelegateDefinition[]> {
  const delegates: DelegateDefinition[] = [];
  const loadedNames = new Set<string>();
  const requiredDelegateNames = new Set(options.requiredDelegateNames ?? []);

  for (const skillDirectory of options.skillDirectories) {
    const resolvedSkillDirectory = resolve(skillDirectory);
    if (!(await pathExists(resolvedSkillDirectory))) {
      continue;
    }

    const entries = (await readdir(resolvedSkillDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .filter((entry) => requiredDelegateNames.size === 0 || requiredDelegateNames.has(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const loadedSkill = await loadSkillDelegateFromDirectory(join(resolvedSkillDirectory, entry.name));
      if (loadedNames.has(loadedSkill.name)) {
        continue;
      }

      const missingTools = loadedSkill.allowedTools.filter((toolName) => !options.availableToolNames.has(toolName));
      if (missingTools.length > 0) {
        continue;
      }

      delegates.push(loadedSkill.delegate);
      loadedNames.add(loadedSkill.name);
    }
  }

  return delegates;
}

function defaultSkillDirectories(): string[] {
  const configuredDirectories = parseConfiguredSkillDirectories(process.env.ADAPTIVE_AGENT_GATEWAY_SKILL_DIRS);
  return [GATEWAY_SKILLS_DIR, ...configuredDirectories];
}

function parseConfiguredSkillDirectories(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function readWebSearchProvider(value: string | undefined): 'brave' | 'duckduckgo' {
  return value === 'brave' ? 'brave' : 'duckduckgo';
}

function parseOptionalPositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
