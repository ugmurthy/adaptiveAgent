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

  it('rejects unknown options', () => {
    expect(() => parseCliArgs(['--unknown'])).toThrow('Unknown option');
  });
});
