import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

import { inspectAgentSdkResolution, type RuntimeMode } from '../index.js';
import { getVersionInfo } from './version.js';

export type DoctorStatus = 'pass' | 'warn' | 'fail' | 'skip';
export type DoctorOutputFormat = 'pretty' | 'json' | 'jsonl';
export type DoctorProvider = 'openrouter' | 'ollama' | 'mistral' | 'mesh';

export interface DoctorOptions {
  cwd?: string;
  agent?: string;
  settings?: string;
  runtime?: RuntimeMode;
  provider?: DoctorProvider;
  model?: string;
  network?: boolean;
  providerCheck?: boolean;
  strict?: boolean;
  output?: DoctorOutputFormat;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorStatus;
  message: string;
  remedy?: string;
  details?: Record<string, unknown>;
}

export interface DoctorReport {
  command: 'doctor';
  version: string;
  commit?: string;
  platform: NodeJS.Platform;
  arch: string;
  cwd: string;
  checks: DoctorCheck[];
  summary: Record<DoctorStatus, number>;
}

const API_KEY_ENV: Partial<Record<DoctorProvider, string>> = {
  openrouter: 'OPENROUTER_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  mesh: 'MESH_API_KEY',
};

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const cwd = resolve(options.cwd ?? process.cwd());
  const checks: DoctorCheck[] = [];
  const version = getVersionInfo(env);

  checks.push({ id: 'cli.version', label: 'CLI version', status: 'pass', message: `${version.name} ${version.version}` });
  checks.push({ id: 'cli.executable', label: 'CLI executable', status: 'pass', message: process.argv[1] ?? 'adaptive-agent', details: { path: process.argv[1] } });
  checks.push(platformCheck());

  let inspection: Awaited<ReturnType<typeof inspectAgentSdkResolution>> | undefined;
  try {
    inspection = await inspectAgentSdkResolution({
      cwd,
      env,
      agentConfigPath: options.agent,
      settingsConfigPath: options.settings,
      runtimeMode: options.runtime,
      model: options.provider || options.model ? { ...(options.provider ? { provider: options.provider } : {}), ...(options.model ? { model: options.model } : {}) } : undefined,
    });
    checks.push({ id: 'config.settingsLookup', label: 'Settings lookup', status: 'pass', message: 'Settings resolved.' });
    checks.push({ id: 'config.agentLookup', label: 'Agent lookup', status: 'pass', message: `Agent ${inspection.config.agent.id} resolved.` });
    checks.push({ id: 'config.agentValidation', label: 'Agent validation', status: 'pass', message: 'Agent config is valid.' });
    checks.push(await workspaceCheck(inspection.config.workspaceRoot));
    checks.push({ id: 'config.agentSearchDirs', label: 'Agent search dirs', status: 'pass', message: `${inspection.config.agents.dirs.length} search dir(s) configured.`, details: { dirs: inspection.config.agents.dirs } });
    checks.push({ id: 'provider.config', label: 'Provider config', status: 'pass', message: `${inspection.config.model.provider}/${inspection.config.model.model}` });
    checks.push(providerApiKeyCheck(inspection.config.model.provider as DoctorProvider, env));
    checks.push({ id: 'runtime.mode', label: 'Runtime mode', status: 'pass', message: `${inspection.config.runtime.mode}`, details: inspection.config.runtime });
    checks.push(postgresEnvCheck(inspection.config.runtime.requestedMode, env));
    checks.push(postgresConnectionCheck(inspection.config.runtime.mode));
  } catch (error) {
    checks.push({
      id: 'config.agentValidation',
      label: 'Config validation',
      status: 'fail',
      message: error instanceof Error ? error.message : String(error),
      remedy: 'Run `adaptive-agent init` or pass --settings and --agent pointing to valid config files.',
    });
  }

  checks.push(await githubCheck(options));
  checks.push(providerReachabilityCheck(options.providerCheck ?? false, inspection?.config.model.provider as DoctorProvider | undefined));

  const summary = summarizeChecks(checks);
  return {
    command: 'doctor',
    version: version.version,
    commit: version.commit,
    platform: process.platform,
    arch: process.arch,
    cwd,
    checks,
    summary,
  };
}

export function renderDoctorReport(report: DoctorReport, output: DoctorOutputFormat = 'pretty'): string {
  if (output === 'json') return JSON.stringify(report, null, 2);
  if (output === 'jsonl') return [...report.checks.map((check) => JSON.stringify(check)), JSON.stringify({ command: 'doctor', summary: report.summary })].join('\n');
  const lines = [`Adaptive Agent doctor (${report.platform}-${report.arch})`, ''];
  for (const check of report.checks) {
    lines.push(`${statusLabel(check.status).padEnd(4)} ${check.id}: ${check.message}`);
    if (check.remedy && (check.status === 'warn' || check.status === 'fail')) lines.push(`     remedy: ${check.remedy}`);
  }
  lines.push('');
  lines.push(`summary: pass ${report.summary.pass ?? 0}, warn ${report.summary.warn ?? 0}, fail ${report.summary.fail ?? 0}, skip ${report.summary.skip ?? 0}`);
  return lines.join('\n');
}

export function doctorExitCode(report: DoctorReport, strict = false): number {
  if ((report.summary.fail ?? 0) > 0) return 1;
  if (strict && (report.summary.warn ?? 0) > 0) return 1;
  return 0;
}

function platformCheck(): DoctorCheck {
  const supported = (process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32') && (process.arch === 'arm64' || process.arch === 'x64');
  return supported
    ? { id: 'platform.supported', label: 'Platform', status: 'pass', message: `${process.platform}-${process.arch} is supported.` }
    : { id: 'platform.supported', label: 'Platform', status: 'fail', message: `${process.platform}-${process.arch} is not supported.`, remedy: 'Use darwin/linux arm64/x64 or windows x64.' };
}

async function workspaceCheck(workspaceRoot: string): Promise<DoctorCheck> {
  try {
    await access(workspaceRoot);
    return { id: 'config.workspaceRoot', label: 'Workspace root', status: 'pass', message: workspaceRoot };
  } catch {
    return { id: 'config.workspaceRoot', label: 'Workspace root', status: 'fail', message: `${workspaceRoot} does not exist.`, remedy: 'Run `adaptive-agent init --cwd <existing-directory>` or update workspaceRoot.' };
  }
}

function providerApiKeyCheck(provider: DoctorProvider, env: NodeJS.ProcessEnv): DoctorCheck {
  const keyEnv = API_KEY_ENV[provider];
  if (!keyEnv) return { id: 'provider.apiKey', label: 'Provider API key', status: 'pass', message: `${provider} does not require an API key env var.` };
  if (env[keyEnv]) return { id: 'provider.apiKey', label: 'Provider API key', status: 'pass', message: `${keyEnv} is set.` };
  return { id: 'provider.apiKey', label: 'Provider API key', status: 'fail', message: `${keyEnv} is not set.`, remedy: `Run: export ${keyEnv}=<your-key>` };
}

function postgresEnvCheck(runtime: RuntimeMode, env: NodeJS.ProcessEnv): DoctorCheck {
  if (runtime !== 'postgres') return { id: 'runtime.postgresEnv', label: 'Postgres env', status: 'skip', message: 'Runtime is not postgres.' };
  if (env.DATABASE_URL) return { id: 'runtime.postgresEnv', label: 'Postgres env', status: 'pass', message: 'DATABASE_URL is set.' };
  return { id: 'runtime.postgresEnv', label: 'Postgres env', status: 'fail', message: 'DATABASE_URL is not set.', remedy: 'Set DATABASE_URL or use --runtime memory.' };
}

function postgresConnectionCheck(runtime: RuntimeMode): DoctorCheck {
  if (runtime !== 'postgres') return { id: 'runtime.postgresConnection', label: 'Postgres connection', status: 'skip', message: 'Runtime is not postgres.' };
  return { id: 'runtime.postgresConnection', label: 'Postgres connection', status: 'skip', message: 'Connection check is not implemented in v0.1 doctor.' };
}

async function githubCheck(options: DoctorOptions): Promise<DoctorCheck> {
  if (!options.network && !options.providerCheck) return { id: 'network.github', label: 'GitHub network', status: 'skip', message: 'Use --network or --provider-check to check GitHub reachability.' };
  try {
    const fetchImpl = options.fetch ?? fetch;
    const response = await fetchImpl('https://github.com/ugmurthy/adaptiveAgent/releases/latest', { method: 'HEAD' });
    if (response.ok || response.status === 302) return { id: 'network.github', label: 'GitHub network', status: 'pass', message: 'GitHub releases are reachable.' };
    return { id: 'network.github', label: 'GitHub network', status: 'warn', message: `GitHub returned HTTP ${response.status}.`, remedy: 'Check network access to github.com.' };
  } catch (error) {
    return { id: 'network.github', label: 'GitHub network', status: 'warn', message: error instanceof Error ? error.message : String(error), remedy: 'Check network access to github.com.' };
  }
}

function providerReachabilityCheck(enabled: boolean, provider?: DoctorProvider): DoctorCheck {
  if (!enabled) return { id: 'provider.reachability', label: 'Provider reachability', status: 'skip', message: 'Use --provider-check to check provider reachability.' };
  return { id: 'provider.reachability', label: 'Provider reachability', status: 'skip', message: provider ? `${provider} reachability is not called by v0.1 doctor.` : 'Provider config was not resolved.' };
}

function summarizeChecks(checks: DoctorCheck[]): Record<DoctorStatus, number> {
  return checks.reduce((summary, check) => ({ ...summary, [check.status]: (summary[check.status] ?? 0) + 1 }), { pass: 0, warn: 0, fail: 0, skip: 0 } as Record<DoctorStatus, number>);
}

function statusLabel(status: DoctorStatus): string {
  if (status === 'pass') return 'ok';
  return status;
}
