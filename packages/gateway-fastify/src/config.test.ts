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
            requestLogger: true,
            requestLogging: 'warn',
            requestLoggingDestination: 'file',
          },
          stores: {
            kind: 'postgres',
            urlEnv: 'DATABASE_URL',
            ssl: false,
          },
          agentRuntimeLogging: {
            enabled: true,
            level: 'debug',
            destination: 'both',
            filePath: 'data/gateway/logs/custom-agent-runtime.log',
          },
          auth: {
            provider: 'jwt',
            issuer: 'https://auth.example.com',
            audience: 'adaptive-agent-gateway',
          },
          transcript: {
            recentMessageWindow: 4,
            summaryTriggerWindow: 4,
            summaryMaxMessages: 8,
            summaryLineMaxLength: 120,
          },
          cron: {
            enabled: true,
            schedulerLeaseMs: 60_000,
            maxConcurrentJobs: 2,
            fileSync: {
              enabled: true,
              dir: 'data/gateway/cron-jobs',
              intervalMs: 30_000,
            },
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
          workspaceRoot: '$HOME/.adaptiveAgent',
          systemInstructions:
            'You are the support manager. Delegate focused research to delegate.researcher and synthesize the final answer yourself.',
          tools: ['read_file'],
          delegates: ['researcher'],
          defaults: {
            injectToolManifest: false,
            researchPolicy: 'gaia',
            toolBudgets: {
              'web_research.search': {
                maxCalls: 3,
                maxConsecutiveCalls: 2,
                checkpointAfter: 2,
                onExhausted: 'ask_model',
              },
            },
          },
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
    expect(loadedGatewayConfig.config.transcript).toEqual({
      recentMessageWindow: 4,
      summaryTriggerWindow: 4,
      summaryMaxMessages: 8,
      summaryLineMaxLength: 120,
    });
    expect(loadedGatewayConfig.config.cron).toEqual({
      enabled: true,
      schedulerLeaseMs: 60_000,
      maxConcurrentJobs: 2,
      fileSync: {
        enabled: true,
        dir: 'data/gateway/cron-jobs',
        intervalMs: 30_000,
      },
    });
    expect(loadedGatewayConfig.config.server.requestLogger).toBe(true);
    expect(loadedGatewayConfig.config.server.requestLogging).toBe('warn');
    expect(loadedGatewayConfig.config.server.requestLoggingDestination).toBe('file');
    expect(loadedGatewayConfig.config.stores).toEqual({
      kind: 'postgres',
      urlEnv: 'DATABASE_URL',
      ssl: false,
      autoMigrate: undefined,
      connectionString: undefined,
    });
    expect(loadedGatewayConfig.config.agentRuntimeLogging).toEqual({
      enabled: true,
      level: 'debug',
      destination: 'both',
      filePath: 'data/gateway/logs/custom-agent-runtime.log',
    });
    expect(loadedGatewayConfig.config.hooks.onAuthenticate).toEqual(['audit']);
    expect(loadedAgentConfigs).toHaveLength(1);
    expect(loadedAgentConfigs[0]?.config).toMatchObject({
      id: 'support-agent',
      invocationModes: ['chat', 'run'],
      defaultInvocationMode: 'chat',
      workspaceRoot: '$HOME/.adaptiveAgent',
      systemInstructions:
        'You are the support manager. Delegate focused research to delegate.researcher and synthesize the final answer yourself.',
      delegates: ['researcher'],
      defaults: {
        injectToolManifest: false,
        researchPolicy: 'gaia',
        toolBudgets: {
          'web_research.search': {
            maxCalls: 3,
            maxConsecutiveCalls: 2,
            checkpointAfter: 2,
            onExhausted: 'ask_model',
          },
        },
      },
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

  it('accepts boolean request logging values for backward compatibility', async () => {
    const workspace = await createTempWorkspace();
    tempDirectories.push(workspace);

    const gatewayConfigPath = join(workspace, 'gateway.json');
    await writeFile(
      gatewayConfigPath,
      JSON.stringify(
        {
          server: {
            host: '127.0.0.1',
            port: 3000,
            websocketPath: '/ws',
            requestLogging: true,
          },
          bindings: [],
          hooks: {
            failurePolicy: 'warn',
            modules: [],
            onAuthenticate: [],
            onSessionResolve: [],
            beforeRoute: [],
            beforeInboundMessage: [],
            beforeRunStart: [],
            afterRunResult: [],
            onAgentEvent: [],
            beforeOutboundFrame: [],
            onDisconnect: [],
            onError: [],
          },
        },
        null,
        2,
      ),
    );

    const loadedGatewayConfig = await loadGatewayConfig({ configPath: gatewayConfigPath });

    expect(loadedGatewayConfig.config.server.requestLogging).toBe(true);
  });

  it('defaults requestLogger to off when omitted', async () => {
    const workspace = await createTempWorkspace();
    tempDirectories.push(workspace);

    const gatewayConfigPath = join(workspace, 'gateway.json');
    await writeFile(
      gatewayConfigPath,
      JSON.stringify(
        {
          server: {
            host: '127.0.0.1',
            port: 3000,
            websocketPath: '/ws',
          },
          bindings: [],
          hooks: {
            failurePolicy: 'warn',
            modules: [],
            onAuthenticate: [],
            onSessionResolve: [],
            beforeRoute: [],
            beforeInboundMessage: [],
            beforeRunStart: [],
            afterRunResult: [],
            onAgentEvent: [],
            beforeOutboundFrame: [],
            onDisconnect: [],
            onError: [],
          },
        },
        null,
        2,
      ),
    );

    const loadedGatewayConfig = await loadGatewayConfig({ configPath: gatewayConfigPath });

    expect(loadedGatewayConfig.config.server.requestLogger).toBeUndefined();
  });

  it('defaults cron file sync to enabled when the object is present', async () => {
    const workspace = await createTempWorkspace();
    tempDirectories.push(workspace);

    const gatewayConfigPath = join(workspace, 'gateway.json');
    await writeFile(
      gatewayConfigPath,
      JSON.stringify(
        {
          server: {
            host: '127.0.0.1',
            port: 3000,
            websocketPath: '/ws',
          },
          cron: {
            enabled: true,
            schedulerLeaseMs: 60_000,
            maxConcurrentJobs: 1,
            fileSync: {
              dir: 'data/gateway/cron-jobs',
            },
          },
        },
        null,
        2,
      ),
    );

    const loadedGatewayConfig = await loadGatewayConfig({ configPath: gatewayConfigPath });

    expect(loadedGatewayConfig.config.cron?.fileSync).toEqual({
      enabled: true,
      dir: 'data/gateway/cron-jobs',
      intervalMs: 60_000,
    });
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

  it('reports invalid research policy and budget config values', async () => {
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
          defaultInvocationMode: 'chat',
          model: {
            provider: 'ollama',
            model: 'qwen3.5',
          },
          tools: [],
          delegates: [],
          defaults: {
            researchPolicy: 'wild',
            toolBudgets: {
              'web_research.search': {
                maxCalls: -1,
                onExhausted: 'explode',
              },
            },
          },
        },
        null,
        2,
      ),
    );

    await expect(loadAgentConfigFile({ configPath: agentConfigPath })).rejects.toThrowError(
      /defaults.researchPolicy must be one of: none, light, standard, deep, gaia[\s\S]*defaults.toolBudgets.web_research.search.maxCalls must be a non-negative integer[\s\S]*defaults.toolBudgets.web_research.search.onExhausted must be one of: fail, continue_with_warning, ask_model/,
    );
  });
});
