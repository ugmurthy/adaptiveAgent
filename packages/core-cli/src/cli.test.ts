import { describe, expect, it } from 'vitest';

import { parseCliArgs } from './cli.js';

describe('parseCliArgs', () => {
  it('parses global flags and run positionals', () => {
    expect(parseCliArgs(['--agent', './agent.json', '--events', '--auto-approve', 'run', 'summarize', 'repo'])).toMatchObject({
      agentConfigPath: './agent.json',
      autoApprove: true,
      command: 'run',
      events: true,
      positionals: ['summarize', 'repo'],
    });
  });

  it('allows default invocation mode positionals when no command is provided', () => {
    const parsed = parseCliArgs(['summarize', 'repo']);
    expect(parsed.command).toBeUndefined();
    expect(parsed.positionals).toEqual(['summarize', 'repo']);
  });

  it('parses repeated skill directories and runtime mode', () => {
    expect(parseCliArgs(['--skills-dir', './skills-a', '--skills-dir', './skills-b', '--runtime', 'postgres', 'config'])).toMatchObject({
      command: 'config',
      runtimeMode: 'postgres',
      skillsDirs: ['./skills-a', './skills-b'],
    });
  });

  it('parses recovery command aliases and continuation options', () => {
    expect(
      parseCliArgs([
        'continueRun',
        'run-1',
        '--strategy',
        'hybrid_snapshot_then_step',
        '--provider',
        'openrouter',
        '--model',
        'qwen/qwen3.5',
        '--metadata-json',
        '{"source":"cli"}',
        '--require-approval',
      ]),
    ).toMatchObject({
      command: 'continueRun',
      positionals: ['run-1'],
      continuationStrategy: 'hybrid_snapshot_then_step',
      continuationProvider: 'openrouter',
      continuationModel: 'qwen/qwen3.5',
      continuationMetadata: { source: 'cli' },
      requireContinuationApproval: true,
    });
  });

  it('rejects unsupported continuation strategies', () => {
    expect(() => parseCliArgs(['create-continuation-run', 'run-1', '--strategy', 'latest_snapshot'])).toThrow(
      '--strategy must be hybrid_snapshot_then_step',
    );
  });

  it('rejects unknown options', () => {
    expect(() => parseCliArgs(['--unknown'])).toThrow('Unknown option');
  });
});
