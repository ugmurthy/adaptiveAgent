import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { agentConfigurationFingerprint, inspectAgentSdkCatalog } from './index.js';

describe('agent SDK catalog inspection', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'agent-sdk-catalog-'));
    await mkdir(join(cwd, 'profiles', '.archive'), { recursive: true });
    await writeAgent(join(cwd, 'agent.json'), 'active');
    await writeFile(join(cwd, 'agent.settings.json'), JSON.stringify({ agents: { dirs: ['./profiles'] }, runtime: { mode: 'memory' } }));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('reports valid and archived profiles with stable configuration fingerprints', async () => {
    await writeAgent(join(cwd, 'profiles', 'worker.json'), 'worker', '${CATALOG_MODEL}');
    await writeAgent(join(cwd, 'profiles', '.archive', 'retired.json'), 'retired');

    const first = await inspectAgentSdkCatalog({ cwd, env: { CATALOG_MODEL: 'expanded-model' } });
    await writeAgent(join(cwd, 'profiles', 'worker.json'), 'worker', '${CATALOG_MODEL}', 'changed-secret');
    const second = await inspectAgentSdkCatalog({ cwd, env: { CATALOG_MODEL: 'expanded-model' } });
    const worker = first.agents.find((agent) => agent.id === 'worker');
    const retired = first.agents.find((agent) => agent.id === 'retired');
    const active = first.agents.find((agent) => agent.active);

    expect(worker).toMatchObject({ archived: false, validationState: 'valid', model: 'expanded-model', configPath: join(cwd, 'profiles', 'worker.json') });
    expect(retired).toMatchObject({ archived: true, validationState: 'valid' });
    expect(worker?.configurationFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(worker?.configurationFingerprint).toBe(second.agents.find((agent) => agent.id === 'worker')?.configurationFingerprint);
    expect(active?.configurationFingerprint).toBe(agentConfigurationFingerprint(first.config));
    expect(first.diagnostics).toEqual([]);
  });

  it('marks the selected profile archived when it is loaded from .archive', async () => {
    const archivedPath = join(cwd, 'profiles', '.archive', 'retired.json');
    await writeAgent(archivedPath, 'retired');
    await writeFile(join(cwd, 'agent.settings.json'), JSON.stringify({
      agent: { configPath: archivedPath, id: 'retired' },
      agents: { dirs: ['./profiles'] },
      runtime: { mode: 'memory' },
    }));

    const catalog = await inspectAgentSdkCatalog({ cwd, env: {} });

    expect(catalog.agents.find((agent) => agent.active)).toMatchObject({
      id: 'retired',
      archived: true,
      configPath: archivedPath,
    });
  });

  it('reports invalid JSON and marks every valid duplicate id', async () => {
    await writeFile(join(cwd, 'profiles', 'broken.json'), '{ not json');
    await writeAgent(join(cwd, 'profiles', 'duplicate.json'), 'active');
    await writeAgent(join(cwd, 'profiles', '.archive', 'duplicate.json'), 'active');

    const catalog = await inspectAgentSdkCatalog({ cwd, env: {} });
    const duplicates = catalog.agents.filter((agent) => agent.id === 'active');
    const invalid = catalog.diagnostics.find((diagnostic) => diagnostic.code === 'invalid-profile');
    const duplicate = catalog.diagnostics.find((diagnostic) => diagnostic.code === 'duplicate-agent-id');

    expect(duplicates).toHaveLength(3);
    expect(duplicates.every((agent) => agent.validationState === 'duplicate-id')).toBe(true);
    expect(invalid?.path).toBe(join(cwd, 'profiles', 'broken.json'));
    expect(invalid?.message).toBeTruthy();
    expect(duplicate?.relatedPaths).toHaveLength(2);
  });
});

async function writeAgent(path: string, id: string, model = 'test-model', apiKey?: string): Promise<void> {
  await writeFile(path, JSON.stringify({
    id,
    name: id,
    invocationModes: ['run'],
    defaultInvocationMode: 'run',
    model: { provider: 'test', model, ...(apiKey ? { apiKey } : {}) },
    tools: [],
  }));
}
