import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import {
  INFERENCE_TIERS,
  type DeclarativeProfileBundle,
  type InferenceTier,
  type ProfileRef,
  type ProfileSummary,
  validateDeclarativeProfileBundle,
} from '@adaptive-agent/gateway-protocol';
import { GatewayError } from './errors.js';
import type { GatewayPrincipal } from './auth.js';
import type { RemoteToolRegistry } from './remote-tools.js';

export interface ProfileManifest {
  schemaVersion: 1;
  profiles: Array<{
    id: string;
    version: string;
    contentHash: string;
    configPath: string;
    allowedTiers: InferenceTier[];
    remoteCapabilities: string[];
  }>;
}

interface Entry { bundle: DeclarativeProfileBundle; summary: ProfileSummary }

/** SHA-256 of canonical JSON after replacing ref.contentHash with an empty string. */
export function profileBundleHash(bundle: DeclarativeProfileBundle): string {
  const input = structuredClone(bundle);
  input.ref.contentHash = '';
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
}

export class ProfileRegistry {
  private readonly entries = new Map<string, Entry>();

  static async load(path: string, remoteTools: RemoteToolRegistry): Promise<ProfileRegistry> {
    const registry = new ProfileRegistry();
    const raw = await Bun.file(path).json() as unknown;
    const manifest = validateManifest(raw);
    for (const item of manifest.profiles) {
      const key = `${item.id}\0${item.version}\0${item.contentHash}`;
      if (registry.entries.has(key)) throw new Error(`duplicate profile ${item.id}@${item.version}`);
      const source = await Bun.file(resolve(dirname(path), item.configPath)).json() as unknown;
      rejectSourceFields(source);
      const bundle = validateDeclarativeProfileBundle(source);
      const expected: ProfileRef = { source: 'server', id: item.id, version: item.version, contentHash: item.contentHash };
      if (!sameRef(bundle.ref, expected) || bundle.schemaVersion !== '1') throw new Error(`profile identity mismatch for ${item.id}@${item.version}`);
      if (profileBundleHash(bundle) !== item.contentHash) throw new Error(`profile content hash mismatch for ${item.id}@${item.version}`);
      validateUniqueDelegates(bundle);
      const capabilities = new Set(['model/generate', ...remoteTools.capabilities()]);
      for (const capability of item.remoteCapabilities) if (!capabilities.has(capability)) throw new Error(`unresolved capability ${capability}`);
      validateDelegateTools(bundle);
      for (const capability of bundle.capabilities ?? []) {
        if (!item.remoteCapabilities.includes(capability)) throw new Error(`unresolved capability ${capability}`);
      }
      registry.entries.set(key, {
        bundle: structuredClone(bundle),
        summary: { ref: expected, name: bundle.name, allowedTiers: [...item.allowedTiers], remoteCapabilities: [...item.remoteCapabilities] },
      });
    }
    return registry;
  }

  schemaVersions(): string[] { return this.entries.size ? ['1'] : []; }
  list(principal: GatewayPrincipal, schemaVersion?: string): ProfileSummary[] {
    if (schemaVersion && schemaVersion !== '1') return [];
    return [...this.entries.values()].filter((entry) => visible(entry, principal)).map((entry) => structuredClone(entry.summary));
  }
  get(ref: ProfileRef, principal: GatewayPrincipal): DeclarativeProfileBundle {
    const entry = ref.source === 'server' ? this.entries.get(keyOf(ref)) : undefined;
    if (!entry || !visible(entry, principal)) throw new GatewayError('capability_not_entitled');
    return structuredClone(entry.bundle);
  }
  policy(refs: ProfileRef[], principal: GatewayPrincipal): { tiers: InferenceTier[]; capabilities: string[] } {
    const server = refs.filter((ref) => ref.source === 'server').map((ref) => {
      const entry = this.entries.get(keyOf(ref));
      if (!entry || !visible(entry, principal)) throw new GatewayError('capability_not_entitled');
      return entry;
    });
    const tiers = principal.allowedTiers.filter((tier) => server.every((entry) => entry.summary.allowedTiers.includes(tier)));
    const capabilities = server.length
      ? server[0]!.summary.remoteCapabilities.filter((capability) => server.every((entry) => entry.summary.remoteCapabilities.includes(capability)))
      : [];
    return { tiers, capabilities };
  }
}

function validateManifest(value: unknown): ProfileManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('profile manifest must be an object');
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || !Array.isArray(record.profiles) || Object.keys(record).some((key) => !['schemaVersion', 'profiles'].includes(key))) throw new Error('invalid profile manifest schema');
  for (const entry of record.profiles) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('invalid profile manifest entry');
    const item = entry as Record<string, unknown>;
    const keys = ['id', 'version', 'contentHash', 'configPath', 'allowedTiers', 'remoteCapabilities'];
    if (Object.keys(item).some((key) => !keys.includes(key)) || keys.some((key) => item[key] === undefined)) throw new Error('invalid profile manifest entry fields');
    if (![item.id, item.version, item.contentHash, item.configPath].every((field) => typeof field === 'string' && field.length > 0)) throw new Error('invalid profile manifest identity');
    if (!Array.isArray(item.allowedTiers) || item.allowedTiers.some((tier) => !INFERENCE_TIERS.includes(tier as InferenceTier)) || !Array.isArray(item.remoteCapabilities) || item.remoteCapabilities.some((capability) => typeof capability !== 'string')) throw new Error('invalid profile policy');
  }
  return value as ProfileManifest;
}
function visible(entry: Entry, principal: GatewayPrincipal): boolean { return principal.permittedModes.includes('gateway') && entry.summary.allowedTiers.some((tier) => principal.allowedTiers.includes(tier)); }
function keyOf(ref: ProfileRef): string { return `${ref.id}\0${ref.version}\0${ref.contentHash}`; }
function sameRef(a: ProfileRef, b: ProfileRef): boolean { return a.source === b.source && a.id === b.id && a.version === b.version && a.contentHash === b.contentHash; }
function canonicalJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`; if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`; return JSON.stringify(value); }
function rejectSourceFields(value: unknown, at = 'profile'): void { if (!value || typeof value !== 'object') return; for (const [key, child] of Object.entries(value as Record<string, unknown>)) { if (/(handler|script|command|module|credential|secret|api.?key|token|password)/i.test(key)) throw new Error(`${at}.${key} is forbidden`); rejectSourceFields(child, `${at}.${key}`); } }
function validateDelegateTools(bundle: DeclarativeProfileBundle): void { const declared = new Set([...(bundle.tools ?? []), ...(bundle.allowedTools ?? [])]); const visit = (delegates: NonNullable<DeclarativeProfileBundle['delegates']>) => { for (const delegate of delegates) { for (const tool of delegate.tools ?? []) if (!declared.has(tool)) throw new Error(`unresolved tool ${tool}`); visit(delegate.delegates ?? []); } }; visit(bundle.delegates ?? []); }
function validateUniqueDelegates(bundle: DeclarativeProfileBundle): void { const seen = new Set<string>(); const ancestors = new Set<object>(); const visit = (delegates: NonNullable<DeclarativeProfileBundle['delegates']>) => { for (const delegate of delegates) { if (ancestors.has(delegate)) throw new Error(`delegate cycle ${delegate.id}`); if (seen.has(delegate.id)) throw new Error(`duplicate delegate ${delegate.id}`); seen.add(delegate.id); ancestors.add(delegate); visit(delegate.delegates ?? []); ancestors.delete(delegate); } }; visit(bundle.delegates ?? []); }
