import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentSdk } from './index.js';
import { main } from './adaptive-agent.js';
import { prepareSkillDirectory } from './skill-handler-preparation.js';
import { testEnvironment } from './test-environment.js';

describe('skill handler preparation', () => {
  let tempDir: string;
  let skillDir: string;
  let cacheRoot: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'skill-handler-preparation-'));
    skillDir = join(tempDir, 'skills', 'custom-handler');
    cacheRoot = join(tempDir, 'cache');
    await writeSkillWithDependency(skillDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('bundles a skill-local package and reuses the cached standalone artifact', async () => {
    const first = await prepareSkillDirectory(skillDir, { cacheRoot });

    expect(first.mode).toBe('bundle');
    expect(first.cacheHit).toBe(false);
    expect(first.modulePath).toContain(cacheRoot);
    const firstModule = await import(pathToFileURL(first.modulePath).href);
    await expect(firstModule.execute({ text: 'hello' })).resolves.toEqual({ value: 'dependency:hello' });

    await rm(join(skillDir, 'node_modules'), { recursive: true, force: true });
    const second = await prepareSkillDirectory(skillDir, { cacheRoot });

    expect(second).toMatchObject({
      modulePath: first.modulePath,
      fingerprint: first.fingerprint,
      cacheHit: true,
    });
    const isolatedModule = await import(`${pathToFileURL(second.modulePath).href}?isolated=1`);
    await expect(isolatedModule.execute({ text: 'world' })).resolves.toEqual({ value: 'dependency:world' });
  });

  it('invalidates the artifact when skill source changes', async () => {
    const first = await prepareSkillDirectory(skillDir, { cacheRoot });
    await writeFile(
      join(skillDir, 'handler.ts'),
      `export async function execute(input: { text: string }) { return { value: 'changed:' + input.text }; }\n`,
    );

    const second = await prepareSkillDirectory(skillDir, { cacheRoot });

    expect(second.cacheHit).toBe(false);
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(second.modulePath).not.toBe(first.modulePath);
  });

  it('rebuilds a valid artifact when force is requested', async () => {
    const first = await prepareSkillDirectory(skillDir, { cacheRoot });
    const rebuilt = await prepareSkillDirectory(skillDir, { cacheRoot, force: true });

    expect(rebuilt.cacheHit).toBe(false);
    expect(rebuilt.modulePath).toBe(first.modulePath);
  });

  it('publishes one valid artifact when sidecars prepare the same skill concurrently', async () => {
    const prepared = await Promise.all(
      Array.from({ length: 4 }, () => prepareSkillDirectory(skillDir, { cacheRoot })),
    );

    expect(new Set(prepared.map((result) => result.modulePath))).toHaveLength(1);
    const module = await import(pathToFileURL(prepared[0].modulePath).href);
    await expect(module.execute({ text: 'concurrent' })).resolves.toEqual({ value: 'dependency:concurrent' });
  });

  it('supports materialized package mode for dependencies that must remain external', async () => {
    await writeFile(
      join(skillDir, 'package.json'),
      JSON.stringify({
        type: 'module',
        dependencies: { 'skill-dependency': '1.0.0' },
        adaptiveAgent: { handlerMode: 'package' },
      }),
    );

    const prepared = await prepareSkillDirectory(skillDir, { cacheRoot });

    expect(prepared.mode).toBe('package');
    expect(prepared.modulePath).toBe(await realpath(join(skillDir, 'handler.ts')));
  });

  it('reports a missing imported package with preparation guidance', async () => {
    await rm(join(skillDir, 'node_modules'), { recursive: true, force: true });

    await expect(prepareSkillDirectory(skillDir, { cacheRoot })).rejects.toThrow(
      'Ensure every imported package is installed in the skill or an enclosing project',
    );
  });

  it('automatically prepares handlers through AgentSdk creation for CLI and sidecar consumers', async () => {
    const sdk = await AgentSdk.create({
      cwd: tempDir,
      env: testEnvironment({
        HOME: tempDir,
        ADAPTIVE_AGENT_HOME: join(tempDir, 'home'),
      }),
      runtimeMode: 'memory',
      settingsConfig: { skills: { dirs: [join(tempDir, 'skills')] } },
      agentConfig: {
        id: 'host',
        name: 'Host',
        invocationModes: ['run'],
        defaultInvocationMode: 'run',
        model: { provider: 'ollama', model: 'test' },
        tools: [],
        delegates: ['custom-handler'],
      },
      modelAdapter: {
        async generate() {
          return { finishReason: 'stop', text: 'done' };
        },
      },
    });

    await sdk.close();
  });

  it('exposes explicit preparation through the binary CLI command', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(main(['skill', 'prepare', skillDir, '--output', 'json'])).resolves.toBe(0);

    const report = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as { skillName: string; modulePath: string };
    expect(report.skillName).toBe('custom-handler');
    expect(report.modulePath).toContain('skill-handlers');
  });
});

async function writeSkillWithDependency(skillDir: string): Promise<void> {
  await mkdir(join(skillDir, 'node_modules', 'skill-dependency'), { recursive: true });
  await writeFile(
    join(skillDir, 'SKILL.md'),
    `---
name: custom-handler
description: Custom handler with a package dependency
handler: handler.ts
---

Use the custom handler.
`,
  );
  await writeFile(
    join(skillDir, 'handler.ts'),
    `import { prefix } from 'skill-dependency';
export const name = 'custom_handler';
export async function execute(input: { text: string }) { return { value: prefix + input.text }; }
`,
  );
  await writeFile(
    join(skillDir, 'package.json'),
    JSON.stringify({ type: 'module', dependencies: { 'skill-dependency': '1.0.0' } }),
  );
  await writeFile(
    join(skillDir, 'node_modules', 'skill-dependency', 'package.json'),
    JSON.stringify({ name: 'skill-dependency', version: '1.0.0', type: 'module', exports: './index.js' }),
  );
  await writeFile(
    join(skillDir, 'node_modules', 'skill-dependency', 'index.js'),
    `export const prefix = 'dependency:';\n`,
  );
}
