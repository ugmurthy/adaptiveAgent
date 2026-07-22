import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentProfileRef } from '@adaptive-agent/service-sdk';
import { agentProfileResolutionPolicy, AllowlistedAgentRegistry, type AgentProfileResolutionPolicy } from './registry.js';

describe('allowlisted agent profile resolution', () => {
  let directory: string;
  let configHash: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'service-registry-'));
    const config = JSON.stringify({
      id: 'agent',
      name: 'Agent',
      invocationModes: ['chat', 'run'],
      defaultInvocationMode: 'run',
      model: { provider: 'ollama', model: 'qwen3.5' },
      tools: ['read_file'],
    });
    configHash = createHash('sha256').update(config).digest('hex');
    await writeFile(join(directory, 'agent.json'), config);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('uses exact resolution by default', async () => {
    const registry = await loadRegistry();

    await expect(registry.resolvePinned(profile('2', configHash), 'run')).resolves.toMatchObject({ entry: { version: '2' } });
    await expect(registry.resolvePinned(profile('1', 'old-hash'), 'run')).rejects.toThrow('under exact resolution policy');
  });

  it('accepts only explicitly compatible pinned revisions under compatible policy', async () => {
    const registry = await loadRegistry('compatible', [{ version: '1', contentHash: 'old-hash' }]);

    await expect(registry.resolvePinned(profile('1', 'old-hash'), 'run')).resolves.toMatchObject({ entry: { version: '2', contentHash: configHash } });
    await expect(registry.resolvePinned(profile('1', 'different-hash'), 'run')).rejects.toThrow('under compatible resolution policy');
  });

  it('uses the active same-ID profile under latest policy', async () => {
    const registry = await loadRegistry('latest');

    await expect(registry.resolvePinned(profile('1', 'old-hash'), 'run')).resolves.toMatchObject({ entry: { version: '2', contentHash: configHash } });
  });

  it('validates profile content hashes eagerly', async () => {
    const registry = await loadRegistry();
    await writeFile(join(directory, 'agent.json'), '{"id":"agent","changed":true}');

    const failures = await registry.validationFailures();
    expect(failures).toHaveLength(1);
    expect(failures[0]?.entry.id).toBe('agent');
    expect(failures[0]?.error).toEqual(expect.objectContaining({ message: 'Agent agent content hash does not match registry' }));
    await expect(registry.validate()).rejects.toThrow(
      /Agent registry validation failed for 1 profile\(s\):[\s\S]*Agent agent content hash does not match registry/,
    );
  });

  it('does not advertise or resolve agents that require shell_exec', async () => {
    const config = JSON.stringify({
      id: 'agent',
      name: 'Agent',
      invocationModes: ['run'],
      defaultInvocationMode: 'run',
      model: { provider: 'ollama', model: 'qwen3.5' },
      tools: ['read_file', 'shell_exec'],
    });
    configHash = createHash('sha256').update(config).digest('hex');
    await writeFile(join(directory, 'agent.json'), config);
    const registry = await loadRegistry();
    const rejected: Array<{ id: string; error: unknown }> = [];

    await expect(registry.resolve('agent', 'run')).rejects.toThrow('cannot use shell_exec');
    await expect(registry.list((entry, error) => rejected.push({ id: entry.id, error }))).resolves.toEqual([]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.id).toBe('agent');
    expect(rejected[0]?.error).toEqual(expect.objectContaining({ message: 'Agent agent cannot use shell_exec in the shared service worker' }));
  });

  it('parses the configured policy and rejects unsafe typos', () => {
    expect(agentProfileResolutionPolicy(undefined)).toBe('exact');
    expect(agentProfileResolutionPolicy('compatible')).toBe('compatible');
    expect(agentProfileResolutionPolicy('latest')).toBe('latest');
    expect(() => agentProfileResolutionPolicy('newest')).toThrow('must be exact, compatible, or latest');
  });

  async function loadRegistry(
    policy: AgentProfileResolutionPolicy = 'exact',
    resumeCompatibleWith?: Array<{ version: string; contentHash: string }>,
  ): Promise<AllowlistedAgentRegistry> {
    await writeFile(join(directory, 'registry.json'), JSON.stringify({
      agents: [{
        id: 'agent',
        configPath: './agent.json',
        version: '2',
        contentHash: configHash,
        allowedWorkloads: ['run'],
        resumeCompatibleWith,
      }],
    }));
    return AllowlistedAgentRegistry.load(join(directory, 'registry.json'), policy);
  }
});

function profile(version: string, contentHash: string): AgentProfileRef {
  return { agentId: 'agent', version, contentHash };
}
