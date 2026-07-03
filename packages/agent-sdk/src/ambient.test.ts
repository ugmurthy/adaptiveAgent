import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadAmbientConfig, runAmbientStart, type AmbientAgentSdk } from './ambient.js';

describe('ambient supervisor', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ambient-sdk-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('loads ambient config with safety defaults and filesystem directories', async () => {
    const configPath = await writeAmbientConfig(tempDir);

    const config = await loadAmbientConfig(configPath, tempDir);

    expect(config.workspaceRoot).toBe(tempDir);
    expect(config.agentConfigPath).toBe(join(tempDir, 'agent.json'));
    expect(config.artifactsRoot).toBe(join(tempDir, 'artifacts', 'ambient'));
    expect(config.runtimeMode).toBe('memory');
    expect(config.interaction).toEqual({ approvalMode: 'reject', clarificationMode: 'fail' });
    expect(config.triggers[0]).toMatchObject({
      id: 'inbox',
      type: 'filesystem',
      inboxDir: join(tempDir, 'agent_inbox'),
      pendingDir: join(tempDir, 'agent_inbox', 'pending'),
      processingDir: join(tempDir, 'agent_inbox', 'processing'),
      processedDir: join(tempDir, 'agent_inbox', 'processed'),
      failedDir: join(tempDir, 'agent_inbox', 'failed'),
      pattern: '*.md',
      stabilityDelayMs: 0,
    });
  });

  it('passes bare agent names through to the Agent SDK resolver', async () => {
    const configPath = join(tempDir, 'ambient.config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        workspaceRoot: '.',
        agent: 'default-agent',
        triggers: [{ id: 'inbox', type: 'filesystem' }],
      }),
    );

    const config = await loadAmbientConfig(configPath, tempDir);

    expect(config.agentConfigPath).toBe('default-agent');
  });

  it('loads cron triggers with deterministic ledger and artifact settings', async () => {
    const configPath = await writeCronAmbientConfig(tempDir);

    const config = await loadAmbientConfig(configPath, tempDir);

    expect(config.triggers[0]).toMatchObject({
      id: 'daily-repo-summary',
      type: 'cron',
      schedule: '0 8 * * 1-5',
      timezone: 'UTC',
      goalFilePath: join(tempDir, 'tasks', 'daily-repo-summary.md'),
      artifactPath: 'artifacts/ambient/daily-repo-summary/{{yyyyMMdd}}',
      ledgerPath: join(tempDir, 'artifacts', 'ambient', '.ambient', 'daily-repo-summary.tasks.jsonl'),
      pollIntervalMs: 30_000,
      concurrency: 1,
      misfirePolicy: 'skip',
    });
  });

  it('explains missing ambient config paths relative to cwd', async () => {
    await expect(loadAmbientConfig('ambient.config.json', tempDir)).rejects.toThrow(
      `Ambient config not found: ${join(tempDir, 'ambient.config.json')}`,
    );
  });

  it('claims a pending markdown task, runs it, writes artifacts, and moves it to processed', async () => {
    const configPath = await writeAmbientConfig(tempDir);
    await mkdir(join(tempDir, 'agent_inbox', 'pending'), { recursive: true });
    await writeFile(join(tempDir, 'agent_inbox', 'pending', 'task.md'), 'Do the thing');

    const runRaw = vi.fn<AmbientAgentSdk['runRaw']>().mockResolvedValue({
      status: 'success',
      runId: 'run-1',
      output: 'done',
      stepsUsed: 1,
      usage: { promptTokens: 0, completionTokens: 0, estimatedCostUSD: 0 },
    });
    const close = vi.fn<AmbientAgentSdk['close']>().mockResolvedValue(undefined);

    const result = await runAmbientStart({
      configPath,
      cwd: tempDir,
      runOnce: true,
      output: 'json',
      createSdk: async () => ({ runRaw, close }),
    });

    expect(result.status).toBe('run_once');
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({ status: 'succeeded', runId: 'run-1', sessionId: expect.stringMatching(/^ambient:/) });
    expect(runRaw).toHaveBeenCalledWith('Do the thing', expect.objectContaining({ sessionId: result.tasks[0]?.sessionId }));
    expect(close).toHaveBeenCalledTimes(1);

    await expect(readdir(join(tempDir, 'agent_inbox', 'pending'))).resolves.toEqual([]);
    await expect(readdir(join(tempDir, 'agent_inbox', 'processing'))).resolves.toEqual([]);
    await expect(readdir(join(tempDir, 'agent_inbox', 'processed'))).resolves.toEqual(['task.md']);
    await expect(readFile(join(result.tasks[0]!.artifactDir, 'input.md'), 'utf-8')).resolves.toBe('Do the thing');
    await expect(readFile(join(result.tasks[0]!.artifactDir, 'run.json'), 'utf-8')).resolves.toContain('"runId": "run-1"');

    const ledger = await readFile(join(tempDir, 'agent_inbox', '.ambient', 'tasks.jsonl'), 'utf-8');
    expect(ledger.trim().split('\n').map((line) => JSON.parse(line).status)).toEqual(['claimed', 'running', 'succeeded']);
  });

  it('marks approval-requested runs as needing approval and moves the task to failed', async () => {
    const configPath = await writeAmbientConfig(tempDir);
    await mkdir(join(tempDir, 'agent_inbox', 'pending'), { recursive: true });
    await writeFile(join(tempDir, 'agent_inbox', 'pending', 'needs-approval.md'), 'Edit a file');

    const runRaw = vi.fn<AmbientAgentSdk['runRaw']>().mockResolvedValue({
      status: 'approval_requested',
      runId: 'run-approval',
      message: 'Approve edit_file?',
      toolName: 'edit_file',
    });

    const result = await runAmbientStart({
      configPath,
      cwd: tempDir,
      runOnce: true,
      output: 'json',
      createSdk: async () => ({ runRaw, close: async () => undefined }),
    });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      status: 'needs_approval',
      runId: 'run-approval',
      error: { message: 'Approve edit_file?', code: 'APPROVAL_REQUIRED' },
    });
    await expect(readdir(join(tempDir, 'agent_inbox', 'failed'))).resolves.toEqual(['needs-approval.md']);
  });

  it('runs a due cron occurrence with a deterministic session id and artifact path', async () => {
    const configPath = await writeCronAmbientConfig(tempDir);
    const runRaw = vi.fn<AmbientAgentSdk['runRaw']>().mockResolvedValue({
      status: 'success',
      runId: 'run-cron-1',
      output: 'done',
      stepsUsed: 1,
      usage: { promptTokens: 0, completionTokens: 0, estimatedCostUSD: 0 },
    });

    const result = await runAmbientStart({
      configPath,
      cwd: tempDir,
      runOnce: true,
      output: 'json',
      clock: () => new Date('2026-07-02T08:00:20.000Z'),
      createSdk: async () => ({ runRaw, close: async () => undefined }),
    });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      id: 'ambient:daily-repo-summary:2026-07-02T08:00:00+00:00',
      sessionId: 'ambient:daily-repo-summary:2026-07-02T08:00:00+00:00',
      scheduledAt: '2026-07-02T08:00:00+00:00',
      status: 'succeeded',
      runId: 'run-cron-1',
      artifactDir: join(tempDir, 'artifacts', 'ambient', 'daily-repo-summary', '20260702'),
    });
    expect(runRaw).toHaveBeenCalledWith('Summarize the repo every weekday morning.', expect.objectContaining({
      sessionId: 'ambient:daily-repo-summary:2026-07-02T08:00:00+00:00',
      context: {
        ambient: expect.objectContaining({
          taskId: 'ambient:daily-repo-summary:2026-07-02T08:00:00+00:00',
          triggerId: 'daily-repo-summary',
          triggerType: 'cron',
          sourceUri: 'cron:daily-repo-summary:2026-07-02T08:00:00+00:00',
          scheduledAt: '2026-07-02T08:00:00+00:00',
          goalFilePath: join(tempDir, 'tasks', 'daily-repo-summary.md'),
          artifactDir: join(tempDir, 'artifacts', 'ambient', 'daily-repo-summary', '20260702'),
        }),
      },
      metadata: {
        ambient: expect.objectContaining({
          sourceUri: 'cron:daily-repo-summary:2026-07-02T08:00:00+00:00',
        }),
      },
    }));
    await expect(readFile(join(result.tasks[0]!.artifactDir, 'input.md'), 'utf-8')).resolves.toBe('Summarize the repo every weekday morning.');
    await expect(readFile(join(result.tasks[0]!.artifactDir, 'run.json'), 'utf-8')).resolves.toContain('"runId": "run-cron-1"');

    const ledger = await readFile(join(tempDir, 'artifacts', 'ambient', '.ambient', 'daily-repo-summary.tasks.jsonl'), 'utf-8');
    expect(ledger.trim().split('\n').map((line) => JSON.parse(line).status)).toEqual(['claimed', 'running', 'succeeded']);
  });

  it('does not duplicate the same cron occurrence across restarts', async () => {
    const configPath = await writeCronAmbientConfig(tempDir);
    const runRaw = vi.fn<AmbientAgentSdk['runRaw']>().mockResolvedValue({
      status: 'success',
      runId: 'run-cron-dedupe',
      output: 'done',
      stepsUsed: 1,
      usage: { promptTokens: 0, completionTokens: 0, estimatedCostUSD: 0 },
    });
    const createSdk = async () => ({ runRaw, close: async () => undefined });
    const clock = () => new Date('2026-07-02T08:00:30.000Z');

    const first = await runAmbientStart({ configPath, cwd: tempDir, runOnce: true, output: 'json', clock, createSdk });
    const second = await runAmbientStart({ configPath, cwd: tempDir, runOnce: true, output: 'json', clock, createSdk });

    expect(first.tasks).toHaveLength(1);
    expect(second.tasks).toHaveLength(0);
    expect(runRaw).toHaveBeenCalledTimes(1);
  });

  it('does not start a new cron occurrence while a previous occurrence is still running after restart', async () => {
    const configPath = await writeCronAmbientConfig(tempDir);
    const ledgerPath = join(tempDir, 'artifacts', 'ambient', '.ambient', 'daily-repo-summary.tasks.jsonl');
    await mkdir(join(tempDir, 'artifacts', 'ambient', '.ambient'), { recursive: true });
    await writeFile(
      ledgerPath,
      `${JSON.stringify({
        id: 'ambient:daily-repo-summary:2026-07-02T07:00:00+00:00',
        triggerId: 'daily-repo-summary',
        triggerType: 'cron',
        sourceUri: 'cron:daily-repo-summary:2026-07-02T07:00:00+00:00',
        sessionId: 'ambient:daily-repo-summary:2026-07-02T07:00:00+00:00',
        runId: 'run-still-active',
        artifactDir: join(tempDir, 'artifacts', 'ambient', 'daily-repo-summary', '20260702-0700'),
        status: 'running',
        attempt: 1,
        detectedAt: '2026-07-02T07:00:00.000Z',
        updatedAt: '2026-07-02T07:00:00.000Z',
      })}\n`,
    );
    const runRaw = vi.fn<AmbientAgentSdk['runRaw']>();
    const inspect = vi.fn<NonNullable<AmbientAgentSdk['inspect']>>().mockResolvedValue({ run: { status: 'running' } as never, events: [] });

    const result = await runAmbientStart({
      configPath,
      cwd: tempDir,
      runOnce: true,
      output: 'json',
      clock: () => new Date('2026-07-02T08:00:30.000Z'),
      createSdk: async () => ({ runRaw, inspect, close: async () => undefined }),
    });

    expect(result.tasks).toHaveLength(0);
    expect(inspect).toHaveBeenCalledWith('run-still-active');
    expect(runRaw).not.toHaveBeenCalled();
  });
});

async function writeAmbientConfig(dir: string): Promise<string> {
  const path = join(dir, 'ambient.config.json');
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      workspaceRoot: '.',
      runtime: { mode: 'memory' },
      agent: './agent.json',
      triggers: [
        {
          id: 'inbox',
          type: 'filesystem',
          path: './agent_inbox',
          stabilityDelayMs: 0,
        },
      ],
    }),
  );
  return path;
}

async function writeCronAmbientConfig(dir: string, triggerOverrides: Record<string, unknown> = {}): Promise<string> {
  await mkdir(join(dir, 'tasks'), { recursive: true });
  await writeFile(join(dir, 'tasks', 'daily-repo-summary.md'), 'Summarize the repo every weekday morning.');
  const path = join(dir, 'ambient.config.json');
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      workspaceRoot: '.',
      runtime: { mode: 'memory' },
      agent: './agent.json',
      triggers: [
        {
          id: 'daily-repo-summary',
          type: 'cron',
          schedule: '0 8 * * 1-5',
          timezone: 'UTC',
          goalFile: './tasks/daily-repo-summary.md',
          artifactPath: 'artifacts/ambient/daily-repo-summary/{{yyyyMMdd}}',
          ...triggerOverrides,
        },
      ],
    }),
  );
  return path;
}
