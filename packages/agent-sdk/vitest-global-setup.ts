import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default function setup(): () => void {
  const originalHome = process.env.HOME;
  const originalAdaptiveAgentHome = process.env.ADAPTIVE_AGENT_HOME;
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'adaptive-agent-sdk-test-home-')));

  process.env.HOME = home;
  process.env.ADAPTIVE_AGENT_HOME = join(home, '.adaptiveAgent');

  return () => {
    restoreEnvironmentVariable('HOME', originalHome);
    restoreEnvironmentVariable('ADAPTIVE_AGENT_HOME', originalAdaptiveAgentHome);
    rmSync(home, { recursive: true, force: true });
  };
}

function restoreEnvironmentVariable(name: 'HOME' | 'ADAPTIVE_AGENT_HOME', value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
