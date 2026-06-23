import { access, readdir, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { homedir } from 'node:os';
import { delimiter, extname, isAbsolute, resolve } from 'node:path';
import { stdin, stderr } from 'node:process';

import type { JsonObject } from '@adaptive-agent/core';

import { AgentConfigValidationError } from './errors.js';
import type { AgentConfigFile } from './config-types.js';

export async function readJson(path: string): Promise<unknown> { try { return JSON.parse(await readFile(path, 'utf-8')) as unknown; } catch (error) { throw new AgentConfigValidationError(path, [`Unable to read or parse JSON: ${error instanceof Error ? error.message : String(error)}`]); } }
export async function pathExists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
export function resolvePath(cwd: string, value: string): string { const expanded = expandEnvironmentVariables(value, process.env); return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded); }
export function expandStrings<T>(value: T, env: NodeJS.ProcessEnv = process.env): T { if (typeof value === 'string') return expandEnvironmentVariables(value, env) as T; if (Array.isArray(value)) return value.map((entry) => expandStrings(entry, env)) as T; if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, expandStrings(entry, env)])) as T; return value; }
export function expandEnvironmentVariables(value: string, env: NodeJS.ProcessEnv = process.env): string { return value.replace(/\$(\w+)|\$\{([^}]+)\}|^~(?=\/|$)/g, (match, bare: string | undefined, braced: string | undefined) => { if (match === '~') return env.HOME ?? homedir(); const name = bare ?? braced; return name === 'HOME' ? env.HOME ?? homedir() : name ? env[name] ?? match : match; }); }
export function expandOptional(value: string | undefined, env: NodeJS.ProcessEnv): string | undefined { return value ? expandEnvironmentVariables(value, env) : undefined; }
export function optionsString(value: string | undefined): string | undefined { return value && value.trim() ? value : undefined; }
export function defaultApiKeyEnv(provider: string): string | undefined { const normalized = provider.toLowerCase(); if (normalized === 'openrouter') return 'OPENROUTER_API_KEY'; if (normalized === 'mistral') return 'MISTRAL_API_KEY'; if (normalized === 'mesh') return 'MESH_API_KEY'; return undefined; }
export function adaptiveAgentHome(env: NodeJS.ProcessEnv): string { return env.ADAPTIVE_AGENT_HOME ? resolve(env.ADAPTIVE_AGENT_HOME) : resolve(homedir(), '.adaptiveAgent'); }
export function resolveAgentDirs(cwd: string, dirs: string[] | undefined, env: NodeJS.ProcessEnv): string[] { const selected = dirs?.length ? dirs : env.ADAPTIVE_AGENT_AGENTS_DIR ? env.ADAPTIVE_AGENT_AGENTS_DIR.split(delimiter).filter(Boolean) : ['./agents', '~/.adaptiveAgent/agents']; return selected.map((dir) => resolvePath(cwd, expandEnvironmentVariables(dir, env))); }
export async function resolveAgentConfigByName(name: string, dirs: string[]): Promise<string | undefined> {
  if (!isAgentName(name)) return undefined;
  const fileNames = extname(name) ? [name] : [name, `${name}.json`];
  const matches: string[] = [];
  for (const dir of dirs) {
    if (!(await pathExists(dir))) continue;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !fileNames.includes(entry.name)) continue;
      matches.push(resolve(dir, entry.name));
    }
  }
  matches.sort();
  if (matches.length > 1) {
    throw new Error(`Ambiguous agent config "${name}". Matches:\n${matches.map((match) => `- ${match}`).join('\n')}`);
  }
  return matches[0];
}
export function resolveSkillDirs(cwd: string, dirs: string[] | undefined, allowExamples: boolean | undefined, env: NodeJS.ProcessEnv): string[] { const selected = dirs?.length ? dirs : env.ADAPTIVE_AGENT_SKILLS_DIR ? env.ADAPTIVE_AGENT_SKILLS_DIR.split(delimiter).filter(Boolean) : ['./skills', '~/.adaptiveAgent/skills']; const resolved = selected.map((dir) => resolvePath(cwd, expandEnvironmentVariables(dir, env))); if (allowExamples) resolved.push(resolve(cwd, 'examples', 'skills')); return resolved; }
export function normalizeRecovery(recovery: AgentConfigFile['recovery']) { return recovery ? { ...recovery, continuation: recovery.continuation ? { enabled: recovery.continuation.enabled ?? true, defaultStrategy: recovery.continuation.defaultStrategy, requireUserApproval: recovery.continuation.requireUserApproval } : undefined } : undefined; }
export function mergeMetadata(base: JsonObject, extra: JsonObject | undefined): JsonObject { return { ...base, ...(extra ?? {}) }; }
export function parsePositiveInteger(value: string | undefined): number | undefined { const parsed = value ? Number.parseInt(value, 10) : NaN; return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined; }
export function readBooleanEnv(value: string | undefined): boolean { return value === '1' || value === 'true' || value === 'yes'; }
export async function promptYesNo(question: string): Promise<boolean> { return ['y', 'yes'].includes((await promptText(question)).trim().toLowerCase()); }
export async function promptText(question: string): Promise<string> { const rl = createInterface({ input: stdin, output: stderr }); try { return await rl.question(question); } finally { rl.close(); } }

function isAgentName(value: string): boolean {
  return Boolean(value.trim()) && !isAbsolute(value) && !/[\\/]/.test(value);
}
