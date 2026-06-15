import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Pool, type PoolConfig } from 'pg';

import { inspectAgentSdkResolution, type RuntimeMode } from '../index.js';
import { getVersionInfo } from './version.js';

export type DoctorStatus = 'pass' | 'warn' | 'fail' | 'skip';
export type DoctorOutputFormat = 'pretty' | 'json' | 'jsonl';
export type DoctorProvider = 'openrouter' | 'ollama' | 'mistral' | 'mesh';

export interface DoctorPostgresClient {
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
}

export type DoctorPostgresClientFactory = (env: NodeJS.ProcessEnv) => DoctorPostgresClient | Promise<DoctorPostgresClient>;

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
  postgresClientFactory?: DoctorPostgresClientFactory;
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

const PROVIDER_BASE_URL: Record<DoctorProvider, string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  ollama: 'http://localhost:11434/v1',
  mistral: 'https://api.mistral.ai/v1',
  mesh: 'https://api.meshapi.ai/v1',
};

const DEFAULT_REACHABILITY_TIMEOUT_MS = 5_000;

type DoctorModelConfig = Awaited<ReturnType<typeof inspectAgentSdkResolution>>['config']['model'];

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
    checks.push(await postgresConnectionCheck(inspection.config.runtime.mode, env, options.postgresClientFactory));
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
  checks.push(await providerReachabilityCheck(options.providerCheck ?? false, inspection?.config.model, options));

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

async function postgresConnectionCheck(runtime: RuntimeMode, env: NodeJS.ProcessEnv, clientFactory: DoctorPostgresClientFactory = createPostgresDoctorClient): Promise<DoctorCheck> {
  if (runtime !== 'postgres') return { id: 'runtime.postgresConnection', label: 'Postgres connection', status: 'skip', message: 'Runtime is not postgres.' };
  let client: DoctorPostgresClient | undefined;
  try {
    client = await clientFactory(env);
    await client.query('select 1');
    return { id: 'runtime.postgresConnection', label: 'Postgres connection', status: 'pass', message: 'Postgres accepted a select 1 probe.' };
  } catch (error) {
    return {
      id: 'runtime.postgresConnection',
      label: 'Postgres connection',
      status: 'fail',
      message: error instanceof Error ? error.message : String(error),
      remedy: 'Check DATABASE_URL, database availability, and PGSSL if TLS is required.',
    };
  } finally {
    await client?.end().catch(() => undefined);
  }
}

function createPostgresDoctorClient(env: NodeJS.ProcessEnv): DoctorPostgresClient {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set.');
  const config: PoolConfig = {
    connectionString: env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: DEFAULT_REACHABILITY_TIMEOUT_MS,
    idleTimeoutMillis: DEFAULT_REACHABILITY_TIMEOUT_MS,
    query_timeout: DEFAULT_REACHABILITY_TIMEOUT_MS,
    statement_timeout: DEFAULT_REACHABILITY_TIMEOUT_MS,
    ssl: readBooleanEnv(env.PGSSL) ? { rejectUnauthorized: false } : undefined,
  };
  return new Pool(config) as unknown as DoctorPostgresClient;
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

async function providerReachabilityCheck(enabled: boolean, modelConfig: DoctorModelConfig | undefined, options: DoctorOptions): Promise<DoctorCheck> {
  if (!enabled) return { id: 'provider.reachability', label: 'Provider reachability', status: 'skip', message: 'Use --provider-check to check provider reachability.' };
  if (!modelConfig) return { id: 'provider.reachability', label: 'Provider reachability', status: 'skip', message: 'Provider config was not resolved.' };
  const provider = modelConfig.provider as DoctorProvider;
  const keyEnv = API_KEY_ENV[provider];
  if (keyEnv && !modelConfig.apiKey) {
    return { id: 'provider.reachability', label: 'Provider reachability', status: 'skip', message: `${keyEnv} is not set; provider reachability was not attempted.` };
  }

  const baseUrl = (modelConfig.baseUrl ?? PROVIDER_BASE_URL[provider]).replace(/\/+$/, '');
  const url = `${baseUrl}/models`;
  const headers: Record<string, string> = {};
  if (modelConfig.apiKey) headers.Authorization = `Bearer ${modelConfig.apiKey}`;

  try {
    const response = await fetchWithTimeout(options.fetch ?? fetch, url, { method: 'GET', headers });
    if (response.ok) {
      if (provider === 'ollama') return ollamaModelAvailabilityCheck(response, modelConfig.model);
      await discardResponseBody(response);
      return { id: 'provider.reachability', label: 'Provider reachability', status: 'pass', message: `${provider} API is reachable.`, details: { url, status: response.status } };
    }
    await discardResponseBody(response);
    const authFailed = response.status === 401 || response.status === 403;
    return {
      id: 'provider.reachability',
      label: 'Provider reachability',
      status: authFailed ? 'fail' : 'warn',
      message: `${provider} returned HTTP ${response.status}.`,
      remedy: authFailed ? `Check ${keyEnv ?? 'provider credentials'}.` : `Check network access to ${new URL(url).host} and provider status.`,
      details: { url, status: response.status },
    };
  } catch (error) {
    return {
      id: 'provider.reachability',
      label: 'Provider reachability',
      status: 'warn',
      message: error instanceof Error ? error.message : String(error),
      remedy: provider === 'ollama' ? `Start Ollama and run: ollama pull ${modelConfig.model}` : `Check network access to ${new URL(url).host} and provider status.`,
      details: { url },
    };
  }
}

async function discardResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function ollamaModelAvailabilityCheck(response: Response, model: string): Promise<DoctorCheck> {
  let availableModels: string[] = [];
  try {
    availableModels = extractModelNames(await response.json());
  } catch {
    return { id: 'provider.reachability', label: 'Provider reachability', status: 'pass', message: 'Ollama is reachable.' };
  }

  if (!availableModels.length || availableModels.some((candidate) => modelNamesMatch(candidate, model))) {
    return { id: 'provider.reachability', label: 'Provider reachability', status: 'pass', message: availableModels.length ? `Ollama is reachable and model ${model} is available.` : 'Ollama is reachable.' };
  }

  return {
    id: 'provider.reachability',
    label: 'Provider reachability',
    status: 'warn',
    message: `Ollama is reachable, but model ${model} was not found.`,
    remedy: `ollama pull ${model}`,
    details: { availableModels },
  };
}

function extractModelNames(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const entries = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : [];
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const model = entry as Record<string, unknown>;
    return [model.id, model.name, model.model].filter((name): name is string => typeof name === 'string' && Boolean(name.trim()));
  });
}

function modelNamesMatch(candidate: string, expected: string): boolean {
  if (candidate === expected) return true;
  return stripLatestTag(candidate) === stripLatestTag(expected);
}

function stripLatestTag(value: string): string {
  return value.endsWith(':latest') ? value.slice(0, -':latest'.length) : value;
}

async function fetchWithTimeout(fetchImpl: typeof fetch, input: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_REACHABILITY_TIMEOUT_MS);
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function readBooleanEnv(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes';
}

function summarizeChecks(checks: DoctorCheck[]): Record<DoctorStatus, number> {
  return checks.reduce((summary, check) => ({ ...summary, [check.status]: (summary[check.status] ?? 0) + 1 }), { pass: 0, warn: 0, fail: 0, skip: 0 } as Record<DoctorStatus, number>);
}

function statusLabel(status: DoctorStatus): string {
  if (status === 'pass') return 'ok';
  return status;
}
