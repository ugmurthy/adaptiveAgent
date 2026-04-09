import { readFile, access } from 'node:fs/promises';
import { join, basename, resolve } from 'node:path';

import type { AgentDefaults, ToolDefinition, JsonValue } from '../types.js';
import type { SkillDefinition } from './types.js';

export interface LoadSkillOptions {
  /** Override the allowed tools (frontmatter cannot express these). */
  allowedTools?: string[];
}

/**
 * Load a skill definition from a directory containing a SKILL.md file.
 *
 * The SKILL.md file uses YAML frontmatter for metadata and the remaining
 * Markdown body as the skill instructions.
 *
 * Required frontmatter fields: `name`, `description`.
 * Optional frontmatter fields: `triggers`, `allowedTools`, `handler`, and
 * dotted `defaults.*` keys such as `defaults.toolTimeoutMs: 120000`.
 *
 * `allowedTools` can be specified in frontmatter or passed via `options`.
 * The `options` value takes precedence.
 *
 * When `handler` is set in frontmatter, the module is dynamically imported
 * from the skill directory and exposed as a scoped tool in the child run.
 */
export async function loadSkillFromDirectory(
  skillDir: string,
  options?: LoadSkillOptions,
): Promise<SkillDefinition> {
  const skillPath = join(skillDir, 'SKILL.md');
  const raw = await readFile(skillPath, 'utf-8');
  const skill = parseSkillMarkdown(raw, skillDir, options);

  if (skill.handler) {
    const handlerPath = resolve(skillDir, skill.handler);
    await assertFileExists(handlerPath, skillDir);
    const handlerTool = await loadHandlerModule(handlerPath, skill.name, skillDir);
    skill.handlerTools = [handlerTool];
  }

  return skill;
}

/**
 * Load a skill definition directly from a SKILL.md file path.
 */
export async function loadSkillFromFile(
  filePath: string,
  options?: LoadSkillOptions,
): Promise<SkillDefinition> {
  const raw = await readFile(filePath, 'utf-8');
  return parseSkillMarkdown(raw, filePath, options);
}

/**
 * Parse a SKILL.md string into a SkillDefinition. Exported for testing.
 */
export function parseSkillMarkdown(
  content: string,
  source: string,
  options?: LoadSkillOptions,
): SkillDefinition {
  const { frontmatter, body } = splitFrontmatter(content);

  if (!frontmatter) {
    throw new SkillLoadError(`SKILL.md at ${source} is missing YAML frontmatter`);
  }

  const meta = parseFrontmatter(frontmatter);

  const name = requireString(meta, 'name', source);
  const description = requireString(meta, 'description', source);

  const triggers = parseStringArray(meta.triggers);
  const allowedTools = options?.allowedTools ?? parseStringArray(meta.allowedTools) ?? [];
  const defaults = parseSkillDefaults(meta, source);

  const instructions = body.trim();
  if (!instructions) {
    throw new SkillLoadError(`SKILL.md at ${source} has no instruction body after frontmatter`);
  }

  const handler = typeof meta.handler === 'string' && meta.handler ? meta.handler : undefined;

  return {
    name,
    description,
    instructions,
    allowedTools,
    triggers: triggers && triggers.length > 0 ? triggers : undefined,
    defaults,
    handler,
  };
}

export class SkillLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillLoadError';
  }
}

// ── frontmatter parsing ─────────────────────────────────────────────────────

interface FrontmatterSplit {
  frontmatter: string | null;
  body: string;
}

function splitFrontmatter(content: string): FrontmatterSplit {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) {
    return { frontmatter: null, body: content };
  }

  const endIndex = trimmed.indexOf('---', 3);
  if (endIndex === -1) {
    return { frontmatter: null, body: content };
  }

  const frontmatter = trimmed.slice(3, endIndex).trim();
  const body = trimmed.slice(endIndex + 3);

  return { frontmatter, body };
}

/**
 * Minimal YAML-subset parser that handles the frontmatter fields we care about:
 * simple `key: value` pairs and `key:` followed by indented `- item` lists.
 * No dependency on a full YAML library.
 */
function parseFrontmatter(yaml: string): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  const lines = yaml.split('\n');
  let currentKey: string | null = null;
  let currentList: string[] | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    // Check for list item under current key
    if (trimmed.startsWith('- ') && currentKey && currentList) {
      currentList.push(unquote(trimmed.slice(2).trim()));
      continue;
    }

    // Flush previous list
    if (currentKey && currentList) {
      result[currentKey] = currentList;
      currentKey = null;
      currentList = null;
    }

    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, colonIndex).trim();
    const value = trimmed.slice(colonIndex + 1).trim();

    if (!value) {
      // Start of a list or empty value
      currentKey = key;
      currentList = [];
    } else {
      result[key] = unquote(value);
    }
  }

  // Flush final list
  if (currentKey && currentList) {
    result[currentKey] = currentList;
  }

  return result;
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function requireString(
  meta: Record<string, string | string[]>,
  key: string,
  source: string,
): string {
  const value = meta[key];
  if (typeof value !== 'string' || !value) {
    throw new SkillLoadError(`SKILL.md at ${source} is missing required field '${key}'`);
  }

  return value;
}

function parseStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string');
  }

  return undefined;
}

function parseSkillDefaults(
  meta: Record<string, string | string[]>,
  source: string,
): Partial<AgentDefaults> | undefined {
  const defaults: Partial<AgentDefaults> = {};

  const maxSteps = parseOptionalInteger(meta, 'defaults.maxSteps', source, { minimum: 1 });
  if (maxSteps !== undefined) {
    defaults.maxSteps = maxSteps;
  }

  const toolTimeoutMs = parseOptionalInteger(meta, 'defaults.toolTimeoutMs', source, { minimum: 0 });
  if (toolTimeoutMs !== undefined) {
    defaults.toolTimeoutMs = toolTimeoutMs;
  }

  const modelTimeoutMs = parseOptionalInteger(meta, 'defaults.modelTimeoutMs', source, { minimum: 0 });
  if (modelTimeoutMs !== undefined) {
    defaults.modelTimeoutMs = modelTimeoutMs;
  }

  const maxRetriesPerStep = parseOptionalInteger(meta, 'defaults.maxRetriesPerStep', source, { minimum: 0 });
  if (maxRetriesPerStep !== undefined) {
    defaults.maxRetriesPerStep = maxRetriesPerStep;
  }

  const requireApprovalForWriteTools = parseOptionalBoolean(meta, 'defaults.requireApprovalForWriteTools', source);
  if (requireApprovalForWriteTools !== undefined) {
    defaults.requireApprovalForWriteTools = requireApprovalForWriteTools;
  }

  const autoApproveAll = parseOptionalBoolean(meta, 'defaults.autoApproveAll', source);
  if (autoApproveAll !== undefined) {
    defaults.autoApproveAll = autoApproveAll;
  }

  const capture = parseOptionalCaptureMode(meta, 'defaults.capture', source);
  if (capture !== undefined) {
    defaults.capture = capture;
  }

  return Object.keys(defaults).length > 0 ? defaults : undefined;
}

function parseOptionalInteger(
  meta: Record<string, string | string[]>,
  key: string,
  source: string,
  options: { minimum: number },
): number | undefined {
  const value = meta[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new SkillLoadError(`SKILL.md at ${source} has invalid integer for '${key}'`);
  }

  const parsed = Number.parseInt(value, 10);
  if (parsed < options.minimum) {
    throw new SkillLoadError(`SKILL.md at ${source} requires '${key}' to be >= ${options.minimum}`);
  }

  return parsed;
}

function parseOptionalBoolean(
  meta: Record<string, string | string[]>,
  key: string,
  source: string,
): boolean | undefined {
  const value = meta[key];
  if (value === undefined) {
    return undefined;
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  throw new SkillLoadError(`SKILL.md at ${source} has invalid boolean for '${key}'`);
}

function parseOptionalCaptureMode(
  meta: Record<string, string | string[]>,
  key: string,
  source: string,
): AgentDefaults['capture'] | undefined {
  const value = meta[key];
  if (value === undefined) {
    return undefined;
  }

  if (value === 'full' || value === 'summary' || value === 'none') {
    return value;
  }

  throw new SkillLoadError(`SKILL.md at ${source} has invalid capture mode for '${key}'`);
}

// ── handler loading ─────────────────────────────────────────────────────────

/**
 * Expected shape of a handler module's default export.
 */
interface SkillHandlerExport {
  name?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  execute(input: JsonValue, context: unknown): Promise<JsonValue>;
}

async function assertFileExists(filePath: string, skillDir: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    throw new SkillLoadError(`Handler module '${filePath}' not found in skill directory ${skillDir}`);
  }
}

async function loadHandlerModule(
  handlerPath: string,
  skillName: string,
  skillDir: string,
): Promise<ToolDefinition> {
  let mod: Record<string, unknown>;
  try {
    mod = await import(handlerPath);
  } catch (error) {
    throw new SkillLoadError(
      `Failed to import handler module '${handlerPath}' for skill '${skillName}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const handler = (mod.default ?? mod) as Partial<SkillHandlerExport>;

  if (typeof handler.execute !== 'function') {
    throw new SkillLoadError(
      `Handler module '${handlerPath}' for skill '${skillName}' must export an execute(input, context) function`,
    );
  }

  const toolName = handler.name ?? `skill.${skillName}.handler`;

  return {
    name: toolName,
    description: handler.description ?? `Handler tool for skill ${skillName}`,
    inputSchema: handler.inputSchema ?? { type: 'object', additionalProperties: true },
    outputSchema: handler.outputSchema,
    execute: handler.execute,
  };
}
