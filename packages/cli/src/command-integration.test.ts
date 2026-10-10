import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import {
  GatewayService,
  InMemoryBillingStore,
  createJwtAuthenticator,
  startGatewayServer,
  validateRoutePolicy,
  type ProviderAdapter,
} from '@adaptive-agent/capability-gateway';

import { main } from './adaptive-agent.js';

const bunIt = typeof Bun === 'undefined' ? it.skip : it;

describe('CLI command integration', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'adaptive-agent-command-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('exposes explicit skill preparation through the binary CLI command', async () => {
    const skillDir = join(tempDir, 'custom-handler');
    await mkdir(join(skillDir, 'node_modules', 'skill-dependency'), { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), `---
name: custom-handler
description: Custom handler with a package dependency
handler: handler.ts
---

Use the custom handler.
`);
    await writeFile(join(skillDir, 'handler.ts'), `import { prefix } from 'skill-dependency';
export const name = 'custom_handler';
export async function execute(input: { text: string }) { return { value: prefix + input.text }; }
`);
    await writeFile(join(skillDir, 'package.json'), JSON.stringify({
      type: 'module', dependencies: { 'skill-dependency': '1.0.0' },
    }));
    await writeFile(join(skillDir, 'node_modules', 'skill-dependency', 'package.json'), JSON.stringify({
      name: 'skill-dependency', version: '1.0.0', type: 'module', exports: './index.js',
    }));
    await writeFile(join(skillDir, 'node_modules', 'skill-dependency', 'index.js'), `export const prefix = 'dependency:';\n`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(main(['skill', 'prepare', skillDir, '--output', 'json'])).resolves.toBe(0);

    const report = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as { skillName: string; modulePath: string };
    expect(report.skillName).toBe('custom-handler');
    expect(report.modulePath).toContain('skill-handlers');
  });

  bunIt('completes a memory-runtime gateway run with a local tool between model turns', async () => {
    const cliInputPath = join(tempDir, 'gateway-input.txt');
    await writeFile(cliInputPath, 'CLI-GATEWAY-CONTENT');
    const providerRequests: Parameters<ProviderAdapter['generate']>[0][] = [];
    const provider: ProviderAdapter = {
      provider: 'ollama',
      model: 'gateway-e2e-model',
      capabilities: { toolCalling: true, jsonOutput: true, streaming: true, usage: true },
      async generate(request) {
        return this.stream!(request, () => undefined);
      },
      async stream(request, onEvent) {
        providerRequests.push(request);
        const usage = {
          promptTokens: 4, completionTokens: 2, totalTokens: 6, estimatedCostUSD: 0.002,
          provider: 'ollama', model: 'gateway-e2e-model',
        };
        if (request.messages.some((message) => message.role === 'tool')) {
          onEvent({ type: 'text_delta', delta: 'gateway complete' });
          return { text: 'gateway complete', finishReason: 'stop', usage };
        }
        return {
          toolCalls: [{ id: 'local-tool-call', name: 'read_file', input: { path: cliInputPath } }],
          finishReason: 'tool_calls', usage,
        };
      },
    };
    const tierPolicy = {
      limits: { maxMessages: 32, maxOutputTokens: 4096, modelTimeoutMs: 5000 },
      targets: [{ provider: 'ollama', model: provider.model, maxConcurrency: 4 }],
    };
    const server = startGatewayServer({
      authenticator: createJwtAuthenticator({
        hmacSecret: 'phase-1-cli-gateway-integration-test-secret', issuer: 'cli-test', audience: 'capability-gateway',
      }),
      service: new GatewayService({
        routePolicy: validateRoutePolicy({
          version: 'policy-e2e',
          tiers: {
            low: structuredClone(tierPolicy), medium: structuredClone(tierPolicy),
            high: structuredClone(tierPolicy), 'xtra-high': structuredClone(tierPolicy),
          },
        }),
        billingStore: new InMemoryBillingStore(),
        adapterFactory: () => provider,
      }),
      hostname: '127.0.0.1', port: 0,
    });
    const previousToken = process.env.CLI_GATEWAY_TEST_TOKEN;
    try {
      const token = await new SignJWT({
        account_id: 'account-e2e', tenant_id: 'tenant-e2e',
        allowed_tiers: ['medium'], permitted_modes: ['gateway'],
      })
        .setProtectedHeader({ alg: 'HS256' }).setSubject('user-e2e')
        .setIssuer('cli-test').setAudience('capability-gateway').setExpirationTime('1h')
        .sign(new TextEncoder().encode('phase-1-cli-gateway-integration-test-secret'));
      process.env.CLI_GATEWAY_TEST_TOKEN = token;
      await writeFile(join(tempDir, 'agent.json'), JSON.stringify({
        id: 'gateway-cli-agent', name: 'gateway-cli-agent',
        invocationModes: ['chat', 'run'], defaultInvocationMode: 'chat',
        model: { provider: 'ollama', model: 'qwen3.5' }, tools: ['read_file'],
      }));
      await writeFile(join(tempDir, 'agent.settings.json'), JSON.stringify({
        runtime: { mode: 'memory' },
        gateway: { url: server.url, accessTokenEnv: 'CLI_GATEWAY_TEST_TOKEN' },
      }));
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const exitCode = await main([
        'run', 'Read the local gateway input file', '--cwd', tempDir,
        '--runtime', 'memory', '--inference-mode', 'gateway', '--tier', 'medium',
        '--inspect', '--output', 'json',
      ]);
      const cliOutput = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
        resolvedConfig: { inferenceMode: string; inferenceTier: string; runtimeMode: string };
        result: { status: string; output: string };
        inspection: { run: { executionContext: Record<string, unknown> }; eventTypes: Record<string, number> };
      };

      expect(exitCode).toBe(0);
      expect(cliOutput.resolvedConfig).toMatchObject({ inferenceMode: 'gateway', inferenceTier: 'medium', runtimeMode: 'memory' });
      expect(cliOutput.result).toMatchObject({ status: 'success', output: 'gateway complete' });
      expect(cliOutput.inspection.run.executionContext).toMatchObject({ inferenceMode: 'gateway', inferenceTier: 'medium', routePolicyRef: 'policy-e2e' });
      expect(cliOutput.inspection.eventTypes).toMatchObject({ 'tool.completed': 1, 'model.completed': 2 });
      expect(providerRequests).toHaveLength(2);
      expect(providerRequests[1]?.messages.some((message) => message.role === 'tool' && message.content.includes('CLI-GATEWAY-CONTENT'))).toBe(true);
      expect(JSON.stringify(cliOutput)).not.toContain(token);
    } finally {
      if (previousToken === undefined) delete process.env.CLI_GATEWAY_TEST_TOKEN;
      else process.env.CLI_GATEWAY_TEST_TOKEN = previousToken;
      await server.stop({ gracePeriodMs: 100 });
    }
  });
});
