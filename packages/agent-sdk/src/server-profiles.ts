import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  type DeclarativeProfileBundle,
  type GatewayClient,
  type ProfileRef,
  validateDeclarativeProfileBundle,
} from '@adaptive-agent/gateway-client';
import type { DelegateDefinition } from '@adaptive-agent/core';
import type { AgentConfigFile } from './config-types.js';
import { adaptiveAgentHome } from './sdk-utils.js';

export interface ResolvedServerProfile {
  ref: ProfileRef;
  bundle: DeclarativeProfileBundle;
  agentConfig: AgentConfigFile;
  delegates: DelegateDefinition[];
}

export function defaultProfileCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(adaptiveAgentHome(env), 'profiles');
}

export async function resolveServerProfile(
  selection: string | ProfileRef,
  options: { client?: Pick<GatewayClient, 'listProfiles' | 'getProfile'>; cachePath?: string; env?: NodeJS.ProcessEnv; executableTools?: Iterable<string> } = {},
): Promise<ResolvedServerProfile> {
  const cache = options.cachePath ?? defaultProfileCachePath(options.env);
  let ref: ProfileRef;
  if (typeof selection !== 'string') {
    if (selection.source !== 'server') throw new Error('Exact server profile resolution requires a server ProfileRef');
    ref = selection;
    const cached = await readCached(cache, ref).catch(() => undefined);
    if (cached) return convert(cached, options.executableTools);
    if (!options.client) throw new Error(`Pinned server profile ${ref.id}@${ref.version} is not cached; connect to the gateway to download that exact version`);
  } else {
    if (!selection.startsWith('server:')) throw new Error('Server profiles require the server:<id> namespace');
    if (!options.client) throw new Error(`Server profile ${selection.slice(7)} is unavailable offline; use an exact cached ProfileRef for resume`);
    const id = selection.slice(7);
    const matches = (await options.client.listProfiles('1')).filter((summary) => summary.ref.id === id);
    if (matches.length !== 1) throw new Error(matches.length ? `Server profile ${id} has multiple current versions; supply an exact ProfileRef` : `Server profile ${id} is unavailable`);
    ref = matches[0]!.ref;
  }
  const cached = await readCached(cache, ref).catch(() => undefined);
  if (cached) return convert(cached, options.executableTools);
  if (!options.client) throw new Error(`Pinned server profile ${ref.id}@${ref.version} is not cached; gateway is unavailable`);
  const bundle = validateExact(await options.client.getProfile(ref), ref);
  await writeCached(cache, bundle);
  return convert(bundle, options.executableTools);
}

export async function resolveProfileNamespace(selection: string, localMatch: boolean, serverMatch: boolean): Promise<'local' | 'server'> {
  if (selection.startsWith('local:')) return 'local';
  if (selection.startsWith('server:')) return 'server';
  if (localMatch && serverMatch) throw new Error(`Ambiguous profile "${selection}"; use local:${selection} or server:${selection}`);
  if (serverMatch) throw new Error(`Server profile IDs must be qualified as server:${selection}`);
  return 'local';
}

function validateExact(value: unknown, ref: ProfileRef): DeclarativeProfileBundle {
  const bundle = validateDeclarativeProfileBundle(value);
  if (!sameRef(bundle.ref, ref)) throw new Error('Gateway returned a different profile version than requested');
  if (hash(bundle) !== ref.contentHash) throw new Error('Server profile content hash mismatch');
  return bundle;
}
async function readCached(root: string, ref: ProfileRef): Promise<DeclarativeProfileBundle> { return validateExact(JSON.parse(await readFile(cacheFile(root, ref), 'utf8')), ref); }
async function writeCached(root: string, bundle: DeclarativeProfileBundle): Promise<void> { const path = cacheFile(root, bundle.ref); await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.${crypto.randomUUID()}.tmp`; await writeFile(temporary, `${JSON.stringify(bundle)}\n`, { mode: 0o600 }); await rename(temporary, path); }
function cacheFile(root: string, ref: ProfileRef): string { return resolve(root, safeSegment(ref.id), safeSegment(ref.version), `${safeSegment(ref.contentHash)}.json`); }
function safeSegment(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function hash(bundle: DeclarativeProfileBundle): string { const input = structuredClone(bundle); input.ref.contentHash = ''; return createHash('sha256').update(canonical(input)).digest('hex'); }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`; return JSON.stringify(value); }
function sameRef(a: ProfileRef, b: ProfileRef): boolean { return a.source === b.source && a.id === b.id && a.version === b.version && a.contentHash === b.contentHash; }
function convert(bundle: DeclarativeProfileBundle, executableTools?: Iterable<string>): ResolvedServerProfile {
  const available = executableTools ? new Set(executableTools) : undefined;
  const delegates: DelegateDefinition[] = [];
  const ids = new Set<string>();
  const visit = (items: NonNullable<DeclarativeProfileBundle['delegates']>) => { for (const item of items) { if (ids.has(item.id)) throw new Error(`Duplicate server delegate ${item.id}`); ids.add(item.id); const tools = item.tools ?? []; checkTools(tools, available); delegates.push({ name: item.id, description: item.instructions ?? item.id, instructions: item.instructions, allowedTools: [...tools] }); visit(item.delegates ?? []); } };
  checkTools([...(bundle.tools ?? []), ...(bundle.allowedTools ?? [])], available); visit(bundle.delegates ?? []);
  return { ref: structuredClone(bundle.ref), bundle: structuredClone(bundle), delegates, agentConfig: { version: 1, id: bundle.ref.id, name: bundle.name, invocationModes: ['run', 'chat'], defaultInvocationMode: 'run', model: { provider: 'adaptive-agent-gateway', model: 'server-profile' }, systemInstructions: bundle.instructions, tools: [...(bundle.tools ?? [])], delegates: [] } };
}
function checkTools(tools: string[], available?: Set<string>): void { if (!available) return; const missing = tools.filter((tool) => !available.has(tool)); if (missing.length) throw new Error(`Server profile references non-executable tools: ${missing.join(', ')}`); }
