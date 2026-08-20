import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type {
  DeclarativeProfileBundle,
  GatewayClient,
  ModelGenerateParams,
  ProfileRef,
  RunAuthorizeParams,
} from '@adaptive-agent/gateway-client';
import { createAgentSdk } from './index.js';
import {
  resolveProfileNamespace,
  resolveServerProfile,
} from './server-profiles.js';
import { testEnvironment } from './test-environment.js';

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('server profile resolution', () => {
  it('uses an exact cached pin offline and never substitutes a newer version', async () => {
    const cachePath = await temporaryDirectory();
    const oldBundle = await bundle('assistant', '1.0.0', 'Old instructions');
    const newerBundle = await bundle('assistant', '2.0.0', 'New instructions');
    const client = profileClient(oldBundle);

    const downloaded = await resolveServerProfile('server:assistant', { client, cachePath });
    expect(downloaded.ref).toEqual(oldBundle.ref);

    const offline = await resolveServerProfile(oldBundle.ref, { cachePath });
    expect(offline.bundle.instructions).toBe('Old instructions');

    const newerClient = profileClient(newerBundle);
    const pinned = await resolveServerProfile(oldBundle.ref, { client: newerClient, cachePath });
    expect(pinned.bundle.instructions).toBe('Old instructions');
    expect(newerClient.listProfiles).not.toHaveBeenCalled();
    expect(newerClient.getProfile).not.toHaveBeenCalled();
  });

  it('rejects ambiguity, missing exact cache, unavailable tools, and executable data', async () => {
    await expect(resolveProfileNamespace('assistant', true, true)).rejects.toThrow(/Ambiguous profile/);
    await expect(resolveServerProfile({
      source: 'server',
      id: 'missing',
      version: '1',
      contentHash: 'a'.repeat(64),
    }, { cachePath: await temporaryDirectory() })).rejects.toThrow(/not cached/);

    const toolBundle = await bundle('tools', '1', 'Use tools', { tools: ['not_installed'] });
    await expect(resolveServerProfile('server:tools', {
      client: profileClient(toolBundle),
      cachePath: await temporaryDirectory(),
      executableTools: ['read_file'],
    })).rejects.toThrow(/non-executable tools/);

    const unsafe = await bundle('unsafe', '1', 'Unsafe') as DeclarativeProfileBundle & { handler?: string };
    unsafe.handler = './downloaded.js';
    const client = profileClient(unsafe);
    await expect(resolveServerProfile('server:unsafe', {
      client,
      cachePath: await temporaryDirectory(),
    })).rejects.toThrow(/handler|prohibited/);
  });

  it('creates an SDK from server:<id> and persists the exact profile pin', async () => {
    const value = await bundle('integrated', '1.2.3', 'Server instructions');
    const profiles = profileClient(value);
    const authorizeRun = vi.fn(async (params: RunAuthorizeParams) => ({
      permitId: 'profile-permit',
      inferenceMode: 'gateway' as const,
      inferenceTier: params.requestedTier,
      routePolicyVersion: 'profile-policy',
      remoteCapabilities: [],
      expiresAt: '9999-12-31T23:59:59.999Z',
    }));
    const generateModel = vi.fn(async (params: ModelGenerateParams) => ({
      callId: params.invocation.callId,
      traceId: 'profile-trace',
      text: 'profile result',
      finishReason: 'stop' as const,
      usage: {
        provider: 'test',
        model: 'profile-model',
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        cost: 0,
      },
      routePolicyVersion: 'profile-policy',
      timings: { gatewayDurationMs: 1, providerDurationMs: 1, routeAttempts: 1 },
    }));
    const gatewayClient = { ...profiles, authorizeRun, generateModel } as unknown as GatewayClient;
    const sdk = await createAgentSdk({
      agentConfigPath: 'server:integrated',
      gatewayClient,
      profileCachePath: await temporaryDirectory(),
      runtimeMode: 'memory',
      env: testEnvironment(),
    });

    try {
      const result = await sdk.runRaw('Use the selected profile');
      const inspection = await sdk.inspect(result.runId);
      expect(result).toMatchObject({ status: 'success', output: 'profile result' });
      expect(sdk.config.agent).toMatchObject({ id: 'integrated', systemInstructions: 'Server instructions' });
      expect(authorizeRun).toHaveBeenCalledWith(expect.objectContaining({ profileRefs: [value.ref] }));
      expect(inspection.run?.executionContext).toMatchObject({ profileRefs: [value.ref] });
    } finally {
      await sdk.close();
    }
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(resolve(tmpdir(), 'agent-profile-cache-'));
  directories.push(path);
  return path;
}

async function bundle(
  id: string,
  version: string,
  instructions: string,
  extra: Partial<DeclarativeProfileBundle> = {},
): Promise<DeclarativeProfileBundle> {
  const value: DeclarativeProfileBundle = {
    ref: { source: 'server', id, version, contentHash: '' },
    schemaVersion: '1',
    name: id,
    instructions,
    ...extra,
  };
  const { createHash } = await import('node:crypto');
  const canonical = (input: unknown): string => Array.isArray(input)
    ? `[${input.map(canonical).join(',')}]`
    : input && typeof input === 'object'
      ? `{${Object.entries(input as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
      : JSON.stringify(input);
  value.ref.contentHash = createHash('sha256').update(canonical(value)).digest('hex');
  return value;
}

function profileClient(value: DeclarativeProfileBundle): Pick<GatewayClient, 'listProfiles' | 'getProfile'> & {
  listProfiles: ReturnType<typeof vi.fn>;
  getProfile: ReturnType<typeof vi.fn>;
} {
  return {
    listProfiles: vi.fn(async () => [{
      ref: value.ref,
      name: value.name,
      allowedTiers: ['medium'],
      remoteCapabilities: [],
    }]),
    getProfile: vi.fn(async (ref: ProfileRef) => {
      expect(ref).toEqual(value.ref);
      return value;
    }),
  };
}
