import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { inspect } from 'node:util';
import readline from 'node:readline/promises';

import chalk from 'chalk';

import { loadGatewayConfig, type GatewayStoreConfig } from '../config.js';
import {
  createGatewayPostgresPool,
  resolveGatewayPostgresConnectionString,
  type GatewayPostgresPool,
} from '../postgres.js';

import { DEFAULT_TRACE_CONFIG_PATH, USAGE } from './constants.js';
import { listSessionlessRuns, listSessions, loadUsageForTraceTarget, traceSession } from './data.js';
import {
  renderDeleteEmptyGoalSessionsSql,
  renderSessionList,
  renderSessionlessRunList,
  renderTraceReport,
  renderUsageReport,
} from './render.js';
import type { CliOptions, MessageView, ReportView, SessionListItem, SessionUsageSummary, SessionlessRunListItem, TraceReport } from './types.js';

export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    json: false,
    listSessions: false,
    listSessionless: false,
    deleteEmptyGoalSessions: false,
    usageOnly: false,
    includePlans: false,
    onlyDelegates: false,
    messages: false,
    systemOnly: false,
    help: false,
  };
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    switch (arg) {
      case 'trace-session':
        if (positional.length === 0) {
          break;
        }
        positional.push(arg);
        break;
      case '--json':
        options.json = true;
        break;
      case '--ls':
        options.listSessions = true;
        break;
      case '--ls-sessionless':
        options.listSessionless = true;
        break;
      case '--delete':
        options.deleteEmptyGoalSessions = true;
        break;
      case '--usage':
        options.usageOnly = true;
        break;
      case '--messages':
        options.messages = true;
        break;
      case '--messages-view':
        options.messagesView = parseMessageView(requireValue(arg, args[++index]));
        options.messages = true;
        break;
      case '--system-only':
        options.systemOnly = true;
        options.messages = true;
        break;
      case '--view':
        options.view = parseReportView(requireValue(arg, args[++index]));
        if (options.view === 'messages') {
          options.messages = true;
        }
        break;
      case '--focus-run':
        options.focusRunId = requireValue(arg, args[++index]);
        break;
      case '--preview-chars':
        options.previewChars = parsePositiveInteger(requireValue(arg, args[++index]), arg);
        break;
      case '--root-run':
      case '--root-run-id':
        options.rootRunId = requireValue(arg, args[++index]);
        break;
      case '--run':
      case '--run-id':
        options.runId = requireValue(arg, args[++index]);
        break;
      case '--include-plans':
        options.includePlans = true;
        break;
      case '--only-delegates':
        options.onlyDelegates = true;
        break;
      case '--config':
      case '--config-path':
        options.configPath = requireValue(arg, args[++index]);
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        if (arg.startsWith('-')) {
          throw new Error(`Unknown option: ${arg}\n\n${USAGE}`);
        }
        positional.push(arg);
    }
  }

  if (positional.length > 1) {
    throw new Error(`Expected one session id, received: ${positional.join(', ')}\n\n${USAGE}`);
  }
  options.sessionId = positional[0];
  return options;
}

export async function main(): Promise<void> {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(USAGE);
      return;
    }
    if (!options.listSessions && !options.listSessionless && !options.deleteEmptyGoalSessions && !options.sessionId && !options.rootRunId && !options.runId) {
      throw new Error(`Missing session id, --root-run, or --run.\n\n${USAGE}`);
    }
    if ((options.listSessions || options.listSessionless || options.deleteEmptyGoalSessions) && options.sessionId) {
      throw new Error(`--ls, --ls-sessionless, and --delete do not accept a session id.\n\n${USAGE}`);
    }
    if ((options.listSessions || options.listSessionless || options.deleteEmptyGoalSessions) && (options.rootRunId || options.runId)) {
      throw new Error(`--ls, --ls-sessionless, and --delete do not accept --root-run or --run.\n\n${USAGE}`);
    }
    if ([options.listSessions, options.listSessionless, options.deleteEmptyGoalSessions].filter(Boolean).length > 1) {
      throw new Error(`Choose only one of --ls, --ls-sessionless, or --delete.\n\n${USAGE}`);
    }
    if (options.sessionId && options.runId) {
      throw new Error(`--run cannot be combined with a session id. Use --root-run to restrict a session trace.\n\n${USAGE}`);
    }
    if (options.rootRunId && options.runId) {
      throw new Error(`Choose either --root-run or --run, not both.\n\n${USAGE}`);
    }
    if ((options.listSessions || options.listSessionless || options.deleteEmptyGoalSessions || options.usageOnly) && (options.messages || options.systemOnly)) {
      throw new Error(`--messages and --system-only can only be used when rendering a full trace.\n\n${USAGE}`);
    }
    if ((options.listSessions || options.listSessionless || options.deleteEmptyGoalSessions || options.usageOnly) && (options.view || options.messagesView || options.focusRunId)) {
      throw new Error(`--view, --messages-view, and --focus-run can only be used when rendering a full trace.\n\n${USAGE}`);
    }
    if ((options.listSessionless || options.deleteEmptyGoalSessions || options.usageOnly) && options.previewChars) {
      throw new Error(`--preview-chars can only be used with --ls or when rendering a full trace.\n\n${USAGE}`);
    }
    if (options.usageOnly && options.sessionId && options.rootRunId) {
      throw new Error(`--usage prints all linked root runs for a session and does not accept --root-run.\n\n${USAGE}`);
    }

    const loaded = await loadGatewayConfig({ configPath: expandConfigPath(options.configPath ?? DEFAULT_TRACE_CONFIG_PATH) });
    const storeConfig = loaded.config.stores;
    if (!storeConfig || storeConfig.kind !== 'postgres') {
      throw new Error(`trace-session requires gateway stores.kind = "postgres" in ${loaded.path}.`);
    }

    if (options.listSessions || options.listSessionless || options.deleteEmptyGoalSessions) {
      if (options.listSessionless) {
        const runs = await runListSessionlessRunsWithPasswordRetry(storeConfig);
        console.log(renderSessionlessRunList(runs, options));
        return;
      }

      const sessions = await runListSessionsWithPasswordRetry(storeConfig);
      console.log(options.deleteEmptyGoalSessions ? renderDeleteEmptyGoalSessionsSql(sessions, options) : renderSessionList(sessions, options));
      return;
    }

    if (options.usageOnly) {
      const usage = await runUsageWithPasswordRetry(storeConfig, options);
      console.log(renderUsageReport(usage, options));
      return;
    }

    const report = await runTraceSessionWithPasswordRetry(storeConfig, options);
    console.log(renderTraceReport(report, options));
  } catch (error) {
    console.error(chalk.red(errorMessage(error)));
    process.exitCode = 1;
  }
}

async function runTraceSessionWithPasswordRetry(
  config: Extract<GatewayStoreConfig, { kind: 'postgres' }>,
  options: CliOptions,
): Promise<TraceReport> {
  let pool = await createTraceSessionPostgresPool(config);
  let shouldEndPool = true;

  try {
    return await traceSession(pool, options);
  } catch (error) {
    if (!isPostgresPasswordAuthFailure(error)) {
      throw error;
    }

    await pool.end();
    shouldEndPool = false;
    const password = await promptHidden('Postgres password: ');
    pool = createGatewayPostgresPool(config, { password });
    try {
      return await traceSession(pool, options);
    } finally {
      await pool.end();
    }
  } finally {
    if (shouldEndPool) {
      await pool.end();
    }
  }
}

async function runListSessionsWithPasswordRetry(config: Extract<GatewayStoreConfig, { kind: 'postgres' }>): Promise<SessionListItem[]> {
  let pool = await createTraceSessionPostgresPool(config);
  let shouldEndPool = true;

  try {
    return await listSessions(pool);
  } catch (error) {
    if (!isPostgresPasswordAuthFailure(error)) {
      throw error;
    }

    await pool.end();
    shouldEndPool = false;
    const password = await promptHidden('Postgres password: ');
    pool = createGatewayPostgresPool(config, { password });
    try {
      return await listSessions(pool);
    } finally {
      await pool.end();
    }
  } finally {
    if (shouldEndPool) {
      await pool.end();
    }
  }
}

async function runListSessionlessRunsWithPasswordRetry(
  config: Extract<GatewayStoreConfig, { kind: 'postgres' }>,
): Promise<SessionlessRunListItem[]> {
  let pool = await createTraceSessionPostgresPool(config);
  let shouldEndPool = true;

  try {
    return await listSessionlessRuns(pool);
  } catch (error) {
    if (!isPostgresPasswordAuthFailure(error)) {
      throw error;
    }

    await pool.end();
    shouldEndPool = false;
    const password = await promptHidden('Postgres password: ');
    pool = createGatewayPostgresPool(config, { password });
    try {
      return await listSessionlessRuns(pool);
    } finally {
      await pool.end();
    }
  } finally {
    if (shouldEndPool) {
      await pool.end();
    }
  }
}

async function runUsageWithPasswordRetry(
  config: Extract<GatewayStoreConfig, { kind: 'postgres' }>,
  options: CliOptions,
): Promise<SessionUsageSummary> {
  let pool = await createTraceSessionPostgresPool(config);
  let shouldEndPool = true;

  try {
    return await loadUsageForTraceTarget(pool, options);
  } catch (error) {
    if (!isPostgresPasswordAuthFailure(error)) {
      throw error;
    }

    await pool.end();
    shouldEndPool = false;
    const password = await promptHidden('Postgres password: ');
    pool = createGatewayPostgresPool(config, { password });
    try {
      return await loadUsageForTraceTarget(pool, options);
    } finally {
      await pool.end();
    }
  } finally {
    if (shouldEndPool) {
      await pool.end();
    }
  }
}

async function loadUsageForTraceTarget(client: PostgresClient, options: CliOptions): Promise<SessionUsageSummary> {
  const { rootRunIds } = await resolveTraceTarget(client, options);
  return loadSessionUsage(client, rootRunIds);
}

async function createTraceSessionPostgresPool(config: Extract<GatewayStoreConfig, { kind: 'postgres' }>): Promise<GatewayPostgresPool> {
  const connectionString = resolveGatewayPostgresConnectionString(config);
  const password = shouldPromptForPostgresPassword(connectionString) ? await promptHidden('Postgres password: ') : undefined;
  return createGatewayPostgresPool(config, { password });
}

function isPostgresPasswordAuthFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const maybeError = error as { code?: unknown; message?: unknown };
  return maybeError.code === '28P01'
    || (typeof maybeError.message === 'string' && maybeError.message.includes('password authentication failed'));
}

function shouldPromptForPostgresPassword(connectionString: string): boolean {
  if (process.env.PGPASSWORD) {
    return false;
  }

  try {
    const url = new URL(connectionString);
    return Boolean(url.username) && !url.password && process.stdin.isTTY;
  } catch {
    return false;
  }
}

async function promptHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      return await rl.question(prompt);
    } finally {
      rl.close();
      process.stdin.pause();
    }
  }

  process.stderr.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return await new Promise<string>((resolvePassword, reject) => {
    let password = '';

    const cleanup = (): void => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write('\n');
    };

    const onData = (chunk: Buffer): void => {
      const value = chunk.toString('utf8');
      for (const char of value) {
        if (char === '\u0003') {
          cleanup();
          reject(new Error('Password prompt cancelled.'));
          return;
        }
        if (char === '\r' || char === '\n') {
          cleanup();
          resolvePassword(password);
          return;
        }
        if (char === '\u007f' || char === '\b') {
          password = password.slice(0, -1);
          continue;
        }
        password += char;
      }
    };

    process.stdin.on('data', onData);
  });
}

function expandConfigPath(configPath: string): string {
  if (configPath === '~') {
    return homedir();
  }
  if (configPath.startsWith('~/')) {
    return resolve(homedir(), configPath.slice(2));
  }
  return configPath;
}

function requireValue(option: string, value: string | undefined): string {
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function parseReportView(value: string): ReportView {
  if (value === 'overview' || value === 'milestones' || value === 'timeline' || value === 'delegates' || value === 'messages' || value === 'plans' || value === 'all') {
    return value;
  }
  throw new Error(`Invalid --view value: ${value}. Expected one of overview, milestones, timeline, delegates, messages, plans, or all.`);
}

function parseMessageView(value: string): MessageView {
  if (value === 'compact' || value === 'delta' || value === 'full') {
    return value;
  }
  throw new Error(`Invalid --messages-view value: ${value}. Expected one of compact, delta, or full.`);
}

function parsePositiveInteger(value: string, option: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} requires a positive integer.`);
  }
  return parsed;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return inspect(error);
}
