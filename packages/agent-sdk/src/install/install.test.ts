import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderDoctorReport, runDoctor } from './doctor.js';
import { compareSemver, resolveAssetName } from './github-release.js';
import { renderInitReport, runInit } from './init.js';
import { runUpdate, updateExitCode } from './update.js';
import { renderVersion } from './version.js';
import { findChecksum, verifySha256File } from './checksum.js';

const execFile = promisify(execFileCallback);

describe('install workflow helpers', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'adaptive-agent-install-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('renders a stable version first line', () => {
    expect(renderVersion({ name: 'adaptive-agent', version: '0.1.0', commit: 'a1b2c3d4', target: 'darwin-arm64', repository: 'https://github.com/ugmurthy/adaptiveAgent' }).split('\n')[0]).toBe('adaptive-agent 0.1.0+a1b2c3d4');
  });

  it('parses and verifies checksums', async () => {
    const path = join(tempDir, 'asset.tar.gz');
    await writeFile(path, 'archive');
    const hash = createHash('sha256').update('archive').digest('hex');

    expect(findChecksum(`${hash}  asset.tar.gz\n`, 'asset.tar.gz')?.hash).toBe(hash);
    await expect(verifySha256File(path, `${hash}  asset.tar.gz\n`, 'asset.tar.gz')).resolves.toBe(hash);
    await expect(verifySha256File(path, `${'0'.repeat(64)}  asset.tar.gz\n`, 'asset.tar.gz')).rejects.toThrow('Checksum mismatch');
  });

  it('resolves update asset names and compares semver', () => {
    expect(resolveAssetName('v0.2.0', 'darwin', 'arm64')).toBe('adaptive-agent-v0.2.0-darwin-arm64.tar.gz');
    expect(resolveAssetName('0.2.0', 'win32', 'x64')).toBe('adaptive-agent-v0.2.0-windows-x64.zip');
    expect(compareSemver('0.2.0', '0.2.0-preview.1')).toBe(1);
    expect(compareSemver('0.1.0+a1b2c3d4', '0.2.0')).toBe(-1);
  });

  it('dry-runs init without creating files or directories', async () => {
    const homeDir = join(tempDir, 'home');
    const report = await runInit({ homeDir, cwd: tempDir, dryRun: true, yes: true, env: {} });

    expect(report.actions.every((action) => action.status === 'would_create')).toBe(true);
    await expect(readFile(join(homeDir, 'agent.settings.json'), 'utf8')).rejects.toThrow();
  });

  it('defaults init home to ~/.adaptiveAgent, not the raw home directory', async () => {
    const report = await runInit({ cwd: tempDir, dryRun: true, yes: true, env: {} });

    expect(report.homeDir.endsWith('/.adaptiveAgent')).toBe(true);
  });

  it('generates safe first-run config by default', async () => {
    const homeDir = join(tempDir, 'home');
    const report = await runInit({ homeDir, cwd: tempDir, yes: true, env: { OPENROUTER_API_KEY: 'secret' } });
    const agent = JSON.parse(await readFile(report.defaultAgentPath, 'utf8'));

    expect(report.provider).toBe('openrouter');
    expect(agent.model).toEqual({ provider: 'openrouter', model: 'qwen/qwen3.5-27b', apiKeyEnv: 'OPENROUTER_API_KEY' });
    expect(agent.workspaceRoot).toBe('.');
    expect(agent.tools).toEqual(['read_file', 'list_directory', 'web_search', 'read_web_page']);
    expect(renderInitReport(report)).toContain('adaptive-agent run "Hello, confirm you are working"');
  });

  it('generates coding profile tools when requested', async () => {
    const report = await runInit({ homeDir: join(tempDir, 'home'), cwd: tempDir, provider: 'mesh', profile: 'coding', yes: true, env: {} });
    const agent = JSON.parse(await readFile(report.defaultAgentPath, 'utf8'));

    expect(agent.model).toEqual({ provider: 'mesh', model: 'qwen/qwen3.5-27b', apiKeyEnv: 'MESH_API_KEY' });
    expect(agent.tools).toContain('write_file');
    expect(agent.tools).toContain('shell_exec');
  });

  it('doctor reports missing provider api key with a remedy and skips network by default', async () => {
    const init = await runInit({ homeDir: join(tempDir, 'home'), cwd: tempDir, provider: 'openrouter', yes: true, env: {} });
    const report = await runDoctor({ cwd: tempDir, settings: init.settingsPath, agent: init.defaultAgentPath, env: {} });
    const apiKey = report.checks.find((check) => check.id === 'provider.apiKey');
    const network = report.checks.find((check) => check.id === 'network.github');

    expect(apiKey).toMatchObject({ status: 'fail', remedy: 'Run: export OPENROUTER_API_KEY=<your-key>' });
    expect(network).toMatchObject({ status: 'skip' });
    expect(JSON.parse(renderDoctorReport(report, 'json')).command).toBe('doctor');
  });

  it('doctor checks GitHub only when network is enabled', async () => {
    const init = await runInit({ homeDir: join(tempDir, 'home'), cwd: tempDir, provider: 'ollama', yes: true, env: {} });
    const fetch = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof globalThis.fetch;

    const report = await runDoctor({ cwd: tempDir, settings: init.settingsPath, agent: init.defaultAgentPath, network: true, env: {}, fetch });

    expect(fetch).toHaveBeenCalledWith('https://github.com/ugmurthy/adaptiveAgent/releases/latest', { method: 'HEAD' });
    expect(report.checks.find((check) => check.id === 'network.github')).toMatchObject({ status: 'pass' });
  });

  it('doctor checks Postgres connection when runtime resolves to postgres', async () => {
    const init = await runInit({ homeDir: join(tempDir, 'home'), cwd: tempDir, provider: 'ollama', yes: true, env: {} });
    await writeFile(init.settingsPath, JSON.stringify({ runtime: { mode: 'postgres' } }));
    const query = vi.fn(async () => ({ rows: [{ value: 1 }] }));
    const end = vi.fn(async () => undefined);
    const postgresClientFactory = vi.fn(() => ({ query, end }));

    const report = await runDoctor({
      cwd: tempDir,
      settings: init.settingsPath,
      agent: init.defaultAgentPath,
      env: { DATABASE_URL: 'postgres://user:pass@localhost:5432/adaptive_agent' },
      postgresClientFactory,
    });

    expect(postgresClientFactory).toHaveBeenCalledWith(expect.objectContaining({ DATABASE_URL: 'postgres://user:pass@localhost:5432/adaptive_agent' }));
    expect(query).toHaveBeenCalledWith('select 1');
    expect(end).toHaveBeenCalled();
    expect(report.checks.find((check) => check.id === 'runtime.postgresConnection')).toMatchObject({ status: 'pass' });
  });

  it('doctor checks provider reachability when provider-check is enabled', async () => {
    const init = await runInit({ homeDir: join(tempDir, 'home'), cwd: tempDir, provider: 'mesh', yes: true, env: { MESH_API_KEY: 'mesh-key' } });
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('github.com')) return new Response('', { status: 200 });
      return Response.json({ data: [] });
    }) as unknown as typeof globalThis.fetch;

    const report = await runDoctor({ cwd: tempDir, settings: init.settingsPath, agent: init.defaultAgentPath, providerCheck: true, env: { MESH_API_KEY: 'mesh-key' }, fetch });

    expect(fetch).toHaveBeenCalledWith('https://api.meshapi.ai/v1/models', expect.objectContaining({ method: 'GET', headers: { Authorization: 'Bearer mesh-key' } }));
    expect(report.checks.find((check) => check.id === 'provider.reachability')).toMatchObject({ status: 'pass', message: 'mesh API is reachable.' });
  });

  it('doctor warns when Ollama is reachable but the configured model is missing', async () => {
    const init = await runInit({ homeDir: join(tempDir, 'home'), cwd: tempDir, provider: 'ollama', yes: true, env: {} });
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('github.com')) return new Response('', { status: 200 });
      return Response.json({ data: [{ id: 'mistral:latest' }] });
    }) as unknown as typeof globalThis.fetch;

    const report = await runDoctor({ cwd: tempDir, settings: init.settingsPath, agent: init.defaultAgentPath, providerCheck: true, env: {}, fetch });

    expect(report.checks.find((check) => check.id === 'provider.reachability')).toMatchObject({
      status: 'warn',
      remedy: 'ollama pull llama3.2',
    });
  });

  it('reports update availability with --check exit code', async () => {
    const fetch = vi.fn(async () => Response.json([{ tag_name: 'v0.2.0', draft: false, prerelease: false }])) as unknown as typeof globalThis.fetch;

    const report = await runUpdate({ check: true, env: { ADAPTIVE_AGENT_VERSION: '0.1.0' }, platform: 'darwin', arch: 'arm64', currentExecutablePath: join(tempDir, 'adaptive-agent'), fetch });

    expect(report).toMatchObject({ status: 'update_available', targetVersion: '0.2.0', assetName: 'adaptive-agent-v0.2.0-darwin-arm64.tar.gz' });
    expect(updateExitCode(report, true)).toBe(10);
  });

  it('reports up-to-date with --check exit code', async () => {
    const fetch = vi.fn(async () => Response.json([{ tag_name: 'v0.1.0', draft: false, prerelease: false }])) as unknown as typeof globalThis.fetch;

    const report = await runUpdate({ check: true, env: { ADAPTIVE_AGENT_VERSION: '0.1.0' }, platform: 'darwin', arch: 'arm64', currentExecutablePath: join(tempDir, 'adaptive-agent'), fetch });

    expect(report.status).toBe('up_to_date');
    expect(updateExitCode(report, true)).toBe(11);
  });

  it('fails closed on update checksum mismatch', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('checksums.txt')) return new Response(`${'0'.repeat(64)}  adaptive-agent-v0.2.0-darwin-arm64.tar.gz\n`);
      return new Response('archive');
    }) as unknown as typeof globalThis.fetch;

    const report = await runUpdate({ targetVersion: 'v0.2.0', env: { ADAPTIVE_AGENT_VERSION: '0.1.0' }, platform: 'darwin', arch: 'arm64', currentExecutablePath: join(tempDir, 'adaptive-agent'), fetch });

    expect(report.status).toBe('failed');
    expect(report.error).toContain('Checksum mismatch');
  });

  it('downloads, verifies, extracts, and replaces a macOS binary', async () => {
    const pkgDir = join(tempDir, 'pkg');
    const binDir = join(tempDir, 'bin');
    const archivePath = join(tempDir, 'adaptive-agent-v0.2.0-darwin-arm64.tar.gz');
    const installPath = join(binDir, 'adaptive-agent');
    await mkdir(pkgDir);
    await mkdir(binDir);
    await writeFile(join(pkgDir, 'adaptive-agent'), '#!/usr/bin/env sh\necho adaptive-agent 0.2.0\n');
    await chmod(join(pkgDir, 'adaptive-agent'), 0o755);
    await writeFile(installPath, '#!/usr/bin/env sh\necho adaptive-agent 0.1.0\n');
    await chmod(installPath, 0o755);
    await execFile('tar', ['-czf', archivePath, '-C', pkgDir, 'adaptive-agent']);
    const archive = await readFile(archivePath);
    const hash = createHash('sha256').update(archive).digest('hex');
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('checksums.txt')) return new Response(`${hash}  adaptive-agent-v0.2.0-darwin-arm64.tar.gz\n`);
      return new Response(archive);
    }) as unknown as typeof globalThis.fetch;

    const report = await runUpdate({ targetVersion: 'v0.2.0', baseUrl: 'https://assets.example/v0.2.0', env: { ADAPTIVE_AGENT_VERSION: '0.1.0' }, platform: 'darwin', arch: 'arm64', currentExecutablePath: installPath, fetch });

    expect(report.status).toBe('updated');
    expect(await readFile(installPath, 'utf8')).toContain('0.2.0');
  });
});
