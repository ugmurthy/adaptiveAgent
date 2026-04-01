import { readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';

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
 * Optional frontmatter fields: `triggers`, `allowedTools`.
 *
 * `allowedTools` can be specified in frontmatter or passed via `options`.
 * The `options` value takes precedence.
 */
export async function loadSkillFromDirectory(
  skillDir: string,
  options?: LoadSkillOptions,
): Promise<SkillDefinition> {
  const skillPath = join(skillDir, 'SKILL.md');
  const raw = await readFile(skillPath, 'utf-8');
  return parseSkillMarkdown(raw, skillDir, options);
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

  const instructions = body.trim();
  if (!instructions) {
    throw new SkillLoadError(`SKILL.md at ${source} has no instruction body after frontmatter`);
  }

  return {
    name,
    description,
    instructions,
    allowedTools,
    triggers: triggers && triggers.length > 0 ? triggers : undefined,
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
