import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadAgentConfigFile, loadAgentConfigs, loadGatewayConfig } from './config.js';

async function createTempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'gateway-config-test-'));
}

describe('gateway config loading', () => {
  const tempDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
    tempDirectories.length = 0;
  });

  it('loads valid gateway and agent configs', async () => {
    const workspace = await createTempWorkspace();
    tempDirectories.push(workspace);

    const gatewayConfigPath = join(workspace, 'gateway.json');
    const agentDirectory = join(workspace, 'agents');
    const agentConfigPath = join(agentDirectory, 'support-agent.json');

    await mkdir(agentDirectory, { recursive: true });
    await writeFile(
      gatewayConfigPath,
      JSON.stringify(
        {
          server: {
            host: '127.0.0.1',
            port: 3000,
            websocketPath: '/ws',
            healthPath: '/health',
          },
          auth: {
            provider: 'jwt',
            issuer: 'https://auth.example.com',
            audience: 'adaptive-agent-gateway',
          },
          channels: {
            defaults: {
              sessionConcurrency: 1,
            },
            list: [
              {
                id: 'webchat',
                name: 'Web Chat',
              },
            ],
          },
          bindings: [
            {
              match: {
                channelId: 'webchat',
              },
              agentId: 'support-agent',
            },
          ],
          defaultAgentId: 'support-agent',
          hooks: {
            modules: ['audit'],
            onAuthenticate: ['audit'],
          },
        },
        null,
        2,
      ),
    );
    await writeFile(
      agentConfigPath,
      JSON.stringify(
        {
          id: 'support-agent',
          name: 'Support Agent',
          invocationModes: ['chat', 'run'],
          defaultInvocationMode: 'chat',
          model: {
            provider: 'ollama',
            model: 'qwen3.5',
          },
          tools: ['read_file'],
          delegates: ['researcher'],
          routing: {
            allowedChannels: ['webchat'],
          },
        },
        null,
        2,
      ),
    );

    const loadedGatewayConfig = await loadGatewayConfig({ configPath: gatewayConfigPath });
    const loadedAgentConfigs = await loadAgentConfigs({ dir: agentDirectory });

    expect(loadedGatewayConfig.config.auth).toEqual({
      provider: 'jwt',
      settings: {
        issuer: 'https://auth.example.com',
        audience: 'adaptive-agent-gateway',
      },
    });
    expect(loadedGatewayConfig.config.hooks.onAuthenticate).toEqual(['audit']);
    expect(loadedAgentConfigs).toHaveLength(1);
    expect(loadedAgentConfigs[0]?.config).toMatchObject({
      id: 'support-agent',
      invocationModes: ['chat', 'run'],
      defaultInvocationMode: 'chat',
    });
  });

  it('reports actionable gateway validation errors', async () => {
    const workspace = await createTempWorkspace();
    tempDirectories.push(workspace);

    const gatewayConfigPath = join(workspace, 'gateway.json');
    await writeFile(
      gatewayConfigPath,
      JSON.stringify(
        {
          server: {
            host: '',
            port: 0,
            websocketPath: 'ws',
          },
        },
        null,
        2,
      ),
    );

    await expect(loadGatewayConfig({ configPath: gatewayConfigPath })).rejects.toThrowError(
      /server.host must be a non-empty string[\s\S]*server.port must be a positive integer[\s\S]*server.websocketPath must start with "\/"/,
    );
  });

  it('reports actionable agent validation errors', async () => {
    const workspace = await createTempWorkspace();
    tempDirectories.push(workspace);

    const agentConfigPath = join(workspace, 'broken-agent.json');
    await writeFile(
      agentConfigPath,
      JSON.stringify(
        {
          id: 'broken-agent',
          name: 'Broken Agent',
          invocationModes: ['chat'],
          defaultInvocationMode: 'run',
          model: {
            provider: 'ollama',
          },
        },
        null,
        2,
      ),
    );

    await expect(loadAgentConfigFile({ configPath: agentConfigPath })).rejects.toThrowError(
      /defaultInvocationMode must be included in invocationModes[\s\S]*model.model must be a non-empty string/,
    );
  });
});
