import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveRuntimeTarget } from './runtime-settings.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'adaptive-runtime-settings-'));
  temporaryDirectories.push(path);
  return path;
}

async function settings(path: string, value: unknown): Promise<void> {
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

describe('resolveRuntimeTarget', () => {
  it('preserves explicit, environment, cwd, and home settings precedence', async () => {
    const cwd = await temporaryDirectory();
    const home = join(cwd, 'home');
    const explicit = join(cwd, 'explicit.json');
    const fromEnvironment = join(cwd, 'environment.json');
    await settings(join(home, 'agent.settings.json'), { runtime: { mode: 'memory' } });
    await settings(join(cwd, 'agent.settings.json'), { runtime: { mode: 'sqlite', sqlitePath: 'cwd.sqlite' } });
    await settings(fromEnvironment, { runtime: { mode: 'sqlite', sqlitePath: 'environment.sqlite' } });
    await settings(explicit, { runtime: { mode: 'sqlite', sqlitePath: 'explicit.sqlite' } });

    await expect(resolveRuntimeTarget({
      cwd,
      settingsPath: explicit,
      env: { ADAPTIVE_AGENT_HOME: home, ADAPTIVE_AGENT_SETTINGS: fromEnvironment },
    })).resolves.toMatchObject({ kind: 'sqlite', path: join(cwd, 'explicit.sqlite'), settingsPath: explicit });

    await expect(resolveRuntimeTarget({
      cwd,
      env: { ADAPTIVE_AGENT_HOME: home, ADAPTIVE_AGENT_SETTINGS: fromEnvironment },
    })).resolves.toMatchObject({ kind: 'sqlite', path: join(cwd, 'environment.sqlite'), settingsPath: fromEnvironment });

    await expect(resolveRuntimeTarget({ cwd, env: { ADAPTIVE_AGENT_HOME: home } }))
      .resolves.toMatchObject({ kind: 'sqlite', path: join(cwd, 'cwd.sqlite') });
  });

  it('applies settings.env before resolving PostgreSQL and relative SQLite targets', async () => {
    const cwd = await temporaryDirectory();
    await settings(join(cwd, 'agent.settings.json'), {
      env: { TRACE_SQLITE_PATH: 'var/runtime.sqlite' },
      runtime: { mode: 'sqlite', sqlitePath: '$TRACE_SQLITE_PATH' },
    });
    await expect(resolveRuntimeTarget({ cwd, env: {} }))
      .resolves.toMatchObject({ kind: 'sqlite', path: join(cwd, 'var/runtime.sqlite') });

    await settings(join(cwd, 'agent.settings.json'), {
      env: { DATABASE_URL: 'postgres://runtime.example/agent' },
      runtime: { mode: 'postgres' },
    });
    await expect(resolveRuntimeTarget({ cwd, env: {} })).resolves.toMatchObject({
      kind: 'postgres',
      requestedMode: 'postgres',
      effectiveMode: 'postgres',
      databaseUrl: 'postgres://runtime.example/agent',
    });
  });

  it('uses the home SQLite default and preserves memory and fallback semantics', async () => {
    const cwd = await temporaryDirectory();
    const home = join(cwd, 'adaptive-home');
    const sqliteSettings = join(cwd, 'sqlite.json');
    const memorySettings = join(cwd, 'memory.json');
    await settings(sqliteSettings, { runtime: { mode: 'sqlite' } });
    await settings(memorySettings, { runtime: { mode: 'memory' } });

    await expect(resolveRuntimeTarget({ cwd, settingsPath: sqliteSettings, env: { ADAPTIVE_AGENT_HOME: home } }))
      .resolves.toMatchObject({ kind: 'sqlite', path: join(home, 'runtime.sqlite') });
    await expect(resolveRuntimeTarget({ cwd, settingsPath: memorySettings, env: { ADAPTIVE_AGENT_HOME: home } }))
      .resolves.toMatchObject({ kind: 'memory', requestedMode: 'memory', effectiveMode: 'memory' });
    await expect(resolveRuntimeTarget({ cwd, env: { ADAPTIVE_AGENT_HOME: home } }))
      .resolves.toMatchObject({ kind: 'memory', requestedMode: 'postgres', effectiveMode: 'memory' });
  });

  it('uses only the injected environment for settings and runtime path expansion', async () => {
    const cwd = await temporaryDirectory();
    const injectedHome = join(cwd, 'injected-home');
    await settings(join(injectedHome, 'settings.json'), {
      runtime: { mode: 'sqlite', sqlitePath: '$AMBIENT_ONLY/runtime.sqlite' },
    });
    const previous = process.env.AMBIENT_ONLY;
    process.env.AMBIENT_ONLY = '/should-not-be-used';
    try {
      await expect(resolveRuntimeTarget({
        cwd,
        settingsPath: '~/settings.json',
        env: { HOME: injectedHome },
      })).resolves.toMatchObject({
        kind: 'sqlite',
        settingsPath: join(injectedHome, 'settings.json'),
        path: join(cwd, '$AMBIENT_ONLY/runtime.sqlite'),
      });
    } finally {
      if (previous === undefined) delete process.env.AMBIENT_ONLY;
      else process.env.AMBIENT_ONLY = previous;
    }
  });
});
