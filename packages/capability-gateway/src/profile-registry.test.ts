import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { DeclarativeProfileBundle } from '@adaptive-agent/gateway-protocol';
import { ProfileRegistry, profileBundleHash } from './profile-registry.js';
import { RemoteToolRegistry } from './remote-tools.js';
import type { GatewayPrincipal } from './auth.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe('ProfileRegistry', () => {
  test('hash-checks files, rejects transitive executable fields, and never exposes paths', async () => {
    const dir = await temporary();
    const bundle = profile('safe');
    bundle.ref.contentHash = profileBundleHash(bundle);
    await writeFile(resolve(dir, 'profile.json'), JSON.stringify(bundle));
    await manifest(dir, bundle);
    const registry = await ProfileRegistry.load(resolve(dir, 'manifest.json'), new RemoteToolRegistry());
    const principal: GatewayPrincipal = { subject: 's', accountId: 'a', tenantId: 't', allowedTiers: ['medium'], permittedModes: ['gateway'], expiresAtEpochSeconds: 9_999_999_999 };
    expect(JSON.stringify(registry.list(principal))).not.toContain(dir);
    expect(JSON.stringify(registry.get(bundle.ref, principal))).not.toContain(dir);

    const unsafe = { ...bundle, delegates: [{ id: 'delegate', delegates: [{ id: 'nested', handler: './evil.ts' }] }] };
    await writeFile(resolve(dir, 'profile.json'), JSON.stringify(unsafe));
    await expect(ProfileRegistry.load(resolve(dir, 'manifest.json'), new RemoteToolRegistry())).rejects.toThrow(/handler|field/i);
  });

  test('rejects a hash mismatch and keeps an unauthorized profile non-enumerable', async () => {
    const dir = await temporary();
    const bundle = profile('private');
    bundle.ref.contentHash = profileBundleHash(bundle);
    await writeFile(resolve(dir, 'profile.json'), JSON.stringify(bundle));
    await manifest(dir, bundle, ['high']);
    const registry = await ProfileRegistry.load(resolve(dir, 'manifest.json'), new RemoteToolRegistry());
    const principal: GatewayPrincipal = { subject: 's', accountId: 'a', tenantId: 't', allowedTiers: ['low'], permittedModes: ['gateway'], expiresAtEpochSeconds: 9_999_999_999 };
    expect(registry.list(principal)).toEqual([]);
    expect(() => registry.get(bundle.ref, principal)).toThrow();
    bundle.instructions = 'tampered';
    await writeFile(resolve(dir, 'profile.json'), JSON.stringify(bundle));
    await expect(ProfileRegistry.load(resolve(dir, 'manifest.json'), new RemoteToolRegistry())).rejects.toThrow(/hash mismatch/);
  });
});

function profile(id: string): DeclarativeProfileBundle { return { ref: { source: 'server', id, version: '1.0.0', contentHash: '' }, schemaVersion: '1', name: id, instructions: 'Declarative only', delegates: [{ id: 'delegate', instructions: 'Help' }] }; }
async function temporary(): Promise<string> { const path = await mkdtemp(resolve(tmpdir(), 'gateway-profile-')); directories.push(path); return path; }
async function manifest(dir: string, bundle: DeclarativeProfileBundle, allowedTiers = ['medium']): Promise<void> { await writeFile(resolve(dir, 'manifest.json'), JSON.stringify({ schemaVersion: 1, profiles: [{ id: bundle.ref.id, version: bundle.ref.version, contentHash: bundle.ref.contentHash, configPath: 'profile.json', allowedTiers, remoteCapabilities: ['model/generate'] }] })); }
