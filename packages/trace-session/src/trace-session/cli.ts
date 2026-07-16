import { inspect } from 'node:util';
import { dirname, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import readline from 'node:readline/promises';

import chalk from 'chalk';

import { createTracePostgresPool as createPostgresPool, resolveTracePostgresConfig, type TracePostgresConfig, type TracePostgresPool } from '../db.js';

import { USAGE, usageForArgs } from './constants.js';
import { cacheKey, isTerminalReport, parseCacheDuration, readCache, writeCache } from './cache.js';
import { aggregateSessionPerformance, listSessionlessRuns, listSessionPerformance, listSessions, loadUsageForTraceTargetWithTerminalState, traceSession } from './data.js';
import { buildTraceComparison } from './report.js';
import {
  renderDeleteEmptyGoalSessionsSql,
  renderSessionPerformanceList,
  renderSessionList,
  renderSessionlessRunList,
  renderTraceAggregate,
  renderTraceAggregateHtml,
  renderTraceHtml,
  renderTraceComparison,
  renderTraceComparisonHtml,
  renderTraceReport,
  renderUsageReport,
  traceTargetNotFoundMessage,
} from './render.js';
import type { CliOptions, MessageView, ReportView, SessionListItem, SessionPerformanceListItem, SessionUsageSummary, SessionlessRunListItem, TraceAggregateGroupBy, TraceAggregateReport, TraceListType, TraceReport } from './types.js';

export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    json: false,
    listSessions: false,
    listPerformance: false,
    listSessionless: false,
    deleteEmptyGoalSessions: false,
    usageOnly: false,
    includePlans: false,
    onlyDelegates: false,
    messages: false,
    reasoning: false,
    systemOnly: false,
    help: false,
  };
  const originalArgs = args;
  const normalizedArgs = args[0] === 'trace-session' ? args.slice(1) : [...args];
  const command = normalizedArgs.shift();
  const helpRequested = normalizedArgs.includes('--help') || normalizedArgs.includes('-h');

  if (!command) {
    throw new Error(`Missing command.\n\n${USAGE}`);
  }
  if (command === '--help' || command === '-h') {
    options.help = true;
    return options;
  }

  switch (command) {
    case 'view': {
      if (helpRequested && normalizedArgs[0]?.startsWith('-')) break;
      const target = requireCommandArgument('view target', normalizedArgs.shift());
      const id = requireCommandArgument(`${target} id`, normalizedArgs.shift());
      if (target === 'session') options.sessionId = id;
      else if (target === 'root-run') options.rootRunId = id;
      else if (target === 'run') options.runId = id;
      else throw new Error(`Invalid view target: ${target}. Expected session, root-run, or run.`);
      break;
    }
    case 'compare':
      if (!helpRequested) {
        options.compareRunIds = [
          requireCommandArgument('baseline run id', normalizedArgs.shift()),
          requireCommandArgument('candidate run id', normalizedArgs.shift()),
        ];
      }
      break;
    case 'list': {
      if (helpRequested && normalizedArgs[0]?.startsWith('-')) break;
      const target = requireCommandArgument('list target', normalizedArgs.shift());
      if (target === 'sessions') options.listSessions = true;
      else if (target === 'traces') options.listPerformance = true;
      else if (target === 'sessionless-runs') options.listSessionless = true;
      else throw new Error(`Invalid list target: ${target}. Expected sessions, traces, or sessionless-runs.`);
      break;
    }
    case 'aggregate': {
      if (helpRequested && normalizedArgs[0]?.startsWith('-')) break;
      const groupBy = requireCommandArgument('aggregate dimension', normalizedArgs.shift());
      if (!['model', 'status', 'day'].includes(groupBy)) throw new Error(`Invalid aggregate dimension: ${groupBy}. Expected model, status, or day.`);
      options.listPerformance = true;
      options.groupBy = groupBy as TraceAggregateGroupBy;
      break;
    }
    case 'usage': {
      options.usageOnly = true;
      if (helpRequested && normalizedArgs[0]?.startsWith('-')) break;
      const target = requireCommandArgument('usage target', normalizedArgs.shift());
      const id = requireCommandArgument(`${target} id`, normalizedArgs.shift());
      if (target === 'session') options.sessionId = id;
      else if (target === 'root-run') options.rootRunId = id;
      else if (target === 'run') options.runId = id;
      else throw new Error(`Invalid usage target: ${target}. Expected session, root-run, or run.`);
      break;
    }
    case 'maintenance': {
      if (helpRequested && normalizedArgs[0]?.startsWith('-')) break;
      const operation = requireCommandArgument('maintenance operation', normalizedArgs.shift());
      if (operation !== 'empty-goal-sql') throw new Error(`Invalid maintenance operation: ${operation}. Expected empty-goal-sql.`);
      options.deleteEmptyGoalSessions = true;
      break;
    }
    default:
      throw new Error(`Unknown command: ${command}\n\n${USAGE}`);
  }

  for (let index = 0; index < normalizedArgs.length; index += 1) {
    const arg = normalizedArgs[index]!;
    assertOptionApplies(command, arg, options);
    switch (arg) {
      case '--json':
        options.json = true;
        break;
      case '--html':
        options.htmlPath = requireValue(arg, normalizedArgs[++index]);
        break;
      case '--fresh': options.fresh = true; break;
      case '--no-cache': options.noCache = true; break;
      case '--cache-ttl': options.cacheTtl = parseCacheDuration(requireValue(arg, normalizedArgs[++index])); break;
      case '--messages':
        options.messages = true;
        break;
      case '--reasoning':
        options.reasoning = true;
        options.messages = true;
        break;
      case '--messages-view':
        options.messagesView = parseMessageView(requireValue(arg, normalizedArgs[++index]));
        options.messages = true;
        break;
      case '--system-only':
        options.systemOnly = true;
        options.messages = true;
        break;
      case '--report':
        options.view = parseReportView(requireValue(arg, normalizedArgs[++index]));
        if (options.view === 'messages') {
          options.messages = true;
        }
        break;
      case '--focus-run':
        options.focusRunId = requireValue(arg, normalizedArgs[++index]);
        break;
      case '--preview-chars':
        options.previewChars = parsePositiveInteger(requireValue(arg, normalizedArgs[++index]), arg);
        break;
      case '--goal':
        (options.goals ??= []).push(requireValue(arg, normalizedArgs[++index]));
        break;
      case '--goal-regex': {
        const value = requireValue(arg, normalizedArgs[++index]);
        try { options.goalRegex = new RegExp(value, 'i'); } catch { throw new Error(`Invalid --goal-regex value: ${value}.`); }
        break;
      }
      case '--has-goal': options.hasGoal = true; break;
      case '--no-goal': options.noGoal = true; break;
      case '--status': {
        const value = requireValue(arg, normalizedArgs[++index]);
        if (!['queued', 'planning', 'awaiting_approval', 'awaiting_subagent', 'running', 'interrupted', 'succeeded', 'failed', 'clarification_requested', 'replan_required', 'cancelled'].includes(value)) throw new Error(`Invalid --status value: ${value}.`);
        (options.statuses ??= []).push(value);
        break;
      }
      case '--limit': options.limit = parsePositiveInteger(requireValue(arg, normalizedArgs[++index]), arg); break;
      case '--since': options.since = parseListTimeBoundary(requireValue(arg, normalizedArgs[++index]), arg); break;
      case '--until': options.until = parseListTimeBoundary(requireValue(arg, normalizedArgs[++index]), arg); break;
      case '--type': {
        const value = requireValue(arg, normalizedArgs[++index]);
        if (!['run', 'chat', 'swarm', 'swarm-run'].includes(value)) throw new Error(`Invalid --type value: ${value}. Expected run, chat, swarm, or swarm-run.`);
        (options.types ??= []).push(value as TraceListType);
        break;
      }
      case '--swarm-role': {
        const value = requireValue(arg, normalizedArgs[++index]);
        if (!['coordinator', 'worker', 'quality', 'synthesizer'].includes(value)) throw new Error(`Invalid --swarm-role value: ${value}.`);
        options.swarmRole = value as CliOptions['swarmRole'];
        break;
      }
      case '--root-run':
        options.rootRunId = requireValue(arg, normalizedArgs[++index]);
        break;
      case '--include-plans':
        options.includePlans = true;
        break;
      case '--only-delegates':
        options.onlyDelegates = true;
        break;
      case '--config':
        options.configPath = requireValue(arg, normalizedArgs[++index]);
        break;
      case '--database-url':
        options.databaseUrl = requireValue(arg, normalizedArgs[++index]);
        break;
      case '--database-url-env':
        options.databaseUrlEnv = requireValue(arg, normalizedArgs[++index]);
        break;
      case '--pgssl':
        options.pgssl = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unexpected argument: ${arg}\n\n${usageForArgs(originalArgs)}`);
    }
  }

  if (options.help) return options;
  if (command === 'view' && options.sessionId === undefined && options.rootRunId === undefined && options.runId === undefined) throw new Error('View requires a target.');
  if (command === 'view' && options.rootRunId && !options.sessionId && normalizedArgs.includes('--root-run')) throw new Error('--root-run can only restrict a view session target.');
  if (options.hasGoal && options.noGoal) throw new Error('--has-goal and --no-goal cannot be combined.');
  if (options.noGoal && (options.goals?.length || options.goalRegex)) throw new Error('--no-goal cannot be combined with --goal or --goal-regex.');
  if (options.swarmRole && options.types?.length) {
    const requiredType: TraceListType = options.swarmRole === 'coordinator' ? 'swarm' : 'swarm-run';
    if (!options.types.includes(requiredType)) throw new Error(`--swarm-role ${options.swarmRole} requires --type ${requiredType}.`);
  }
  if (options.since && options.until) {
    const now = Date.now();
    if (resolveListTimeBoundary(options.since, now) > resolveListTimeBoundary(options.until, now)) {
      throw new Error('--since must be earlier than or equal to --until.');
    }
  }
  if (options.compareRunIds && options.compareRunIds[0] === options.compareRunIds[1]) throw new Error('compare requires two different run IDs.');
  return options;
}

export async function main(): Promise<void> {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usageForArgs(process.argv.slice(2)));
      return;
    }
    if (options.cacheTtl === undefined && process.env.TRACE_SESSION_CACHE_TTL !== undefined) {
      options.cacheTtl = parseCacheDuration(process.env.TRACE_SESSION_CACHE_TTL, 'TRACE_SESSION_CACHE_TTL');
    }
    if (process.env.TRACE_SESSION_CACHE === 'off' && options.noCache === undefined) options.noCache = true;

    const postgresConfig = await resolveTracePostgresConfig({
      configPath: options.configPath,
      databaseUrl: options.databaseUrl,
      databaseUrlEnv: options.databaseUrlEnv,
      ssl: options.pgssl,
    });

    if (options.compareRunIds) {
      const [baselineId, candidateId] = options.compareRunIds;
      const [baseline, candidate] = await runTraceComparisonWithPasswordRetry(postgresConfig,
        { ...options, compareRunIds: undefined, runId: baselineId, focusRunId: baselineId },
        { ...options, compareRunIds: undefined, runId: candidateId, focusRunId: candidateId });
      const comparison = buildTraceComparison(baseline, candidate, baselineId, candidateId);
      if (options.htmlPath) {
        const path = await writeTraceHtmlReport(options.htmlPath, renderTraceComparisonHtml(comparison));
        if (!options.json) { console.log(`Wrote trace comparison HTML report: ${path}`); return; }
      }
      console.log(renderTraceComparison(comparison, { json: options.json }));
      return;
    }

    if (options.listSessions || options.listPerformance || options.listSessionless || options.deleteEmptyGoalSessions) {
      if (options.listPerformance) {
        if (options.groupBy) {
          const aggregate = await runAggregateSessionPerformanceWithPasswordRetry(postgresConfig, options);
          if (options.htmlPath) {
            const path = await writeTraceHtmlReport(options.htmlPath, renderTraceAggregateHtml(aggregate));
            if (!options.json) { console.log(`Wrote trace aggregate HTML report: ${path}`); return; }
            console.error(chalk.gray(`Wrote trace aggregate HTML report: ${path}`));
          }
          console.log(renderTraceAggregate(aggregate, { json: options.json }));
          return;
        }
        const items = await runListSessionPerformanceWithPasswordRetry(postgresConfig, options);
        console.log(renderSessionPerformanceList(items, options));
        return;
      }

      if (options.listSessionless) {
        const runs = await runListSessionlessRunsWithPasswordRetry(postgresConfig);
        console.log(renderSessionlessRunList(runs, options));
        return;
      }

      const sessions = await runListSessionsWithPasswordRetry(postgresConfig, {
        ...options,
        recoverAgentRunSessionIds: !options.deleteEmptyGoalSessions,
      });
      console.log(options.deleteEmptyGoalSessions ? renderDeleteEmptyGoalSessionsSql(sessions, options) : renderSessionList(sessions, options));
      return;
    }

    if (options.usageOnly) {
      const usage = await runUsageWithPasswordRetry(postgresConfig, options);
      console.log(renderUsageReport(usage, options));
      return;
    }

    const report = await runTraceSessionWithPasswordRetry(postgresConfig, options);
    if (traceTargetNotFoundMessage(report)) {
      console.log(renderTraceReport(report, options));
      return;
    }
    if (options.htmlPath) {
      const htmlPath = await writeTraceHtmlReport(options.htmlPath, renderTraceHtml(report, options));
      const message = `Wrote trace HTML report: ${htmlPath}`;
      if (options.json) {
        console.error(chalk.gray(message));
      } else {
        console.log(message);
        return;
      }
    }
    console.log(renderTraceReport(report, options));
  } catch (error) {
    console.error(chalk.red(errorMessage(error)));
    process.exitCode = 1;
  }
}

async function writeTraceHtmlReport(htmlPath: string, html: string): Promise<string> {
  const resolvedPath = resolve(htmlPath);
  await mkdir(dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, html, 'utf8');
  return resolvedPath;
}

async function runTraceSessionWithPasswordRetry(
  config: TracePostgresConfig,
  options: CliOptions,
): Promise<TraceReport> {
  let pool = await createTraceSessionPostgresPool(config);
  let shouldEndPool = true;

  try {
    return await loadTraceReportWithCache(pool, config, options);
  } catch (error) {
    if (!isPostgresPasswordAuthFailure(error)) {
      throw error;
    }

    await pool.end();
    shouldEndPool = false;
    const password = await promptHidden('Postgres password: ');
    pool = createPostgresPool(config, { password });
    try {
      return await loadTraceReportWithCache(pool, config, options);
    } finally {
      await pool.end();
    }
  } finally {
    if (shouldEndPool) {
      await pool.end();
    }
  }
}

async function loadTraceReportWithCache(client: TracePostgresPool, config: TracePostgresConfig, options: CliOptions): Promise<TraceReport> {
  const key = cacheKey(config, options, 'trace');
  if (!options.noCache && !options.fresh) {
    const cached = await readCache(key, options.cacheTtl);
    if (cached) return cached as TraceReport;
  }
  const report = await traceSession(client, options);
  if (!options.noCache) await writeCache(key, report, isTerminalReport(report), options.cacheTtl).catch(() => undefined);
  return report;
}

async function runTraceComparisonWithPasswordRetry(config: TracePostgresConfig, baseline: CliOptions, candidate: CliOptions): Promise<[TraceReport, TraceReport]> {
  let pool = await createTraceSessionPostgresPool(config);
  let shouldEndPool = true;
  const load = () => Promise.all([loadTraceReportWithCache(pool, config, baseline), loadTraceReportWithCache(pool, config, candidate)]) as Promise<[TraceReport, TraceReport]>;
  try {
    return await load();
  } catch (error) {
    if (!isPostgresPasswordAuthFailure(error)) throw error;
    await pool.end();
    shouldEndPool = false;
    const password = await promptHidden('Postgres password: ');
    pool = createPostgresPool(config, { password });
    try { return await load(); } finally { await pool.end(); }
  } finally {
    if (shouldEndPool) await pool.end();
  }
}

async function runListSessionsWithPasswordRetry(
  config: TracePostgresConfig,
  options: { recoverAgentRunSessionIds?: boolean } = {},
): Promise<SessionListItem[]> {
  let pool = await createTraceSessionPostgresPool(config);
  let shouldEndPool = true;

  try {
    return await listSessions(pool, options);
  } catch (error) {
    if (!isPostgresPasswordAuthFailure(error)) {
      throw error;
    }

    await pool.end();
    shouldEndPool = false;
    const password = await promptHidden('Postgres password: ');
    pool = createPostgresPool(config, { password });
    try {
      return await listSessions(pool, options);
    } finally {
      await pool.end();
    }
  } finally {
    if (shouldEndPool) {
      await pool.end();
    }
  }
}

async function runListSessionPerformanceWithPasswordRetry(config: TracePostgresConfig, options: CliOptions): Promise<SessionPerformanceListItem[]> {
  let pool = await createTraceSessionPostgresPool(config);
  let shouldEndPool = true;

  try {
    return await listSessionPerformance(pool, options);
  } catch (error) {
    if (!isPostgresPasswordAuthFailure(error)) {
      throw error;
    }

    await pool.end();
    shouldEndPool = false;
    const password = await promptHidden('Postgres password: ');
    pool = createPostgresPool(config, { password });
    try {
      return await listSessionPerformance(pool, options);
    } finally {
      await pool.end();
    }
  } finally {
    if (shouldEndPool) {
      await pool.end();
    }
  }
}

async function runAggregateSessionPerformanceWithPasswordRetry(config: TracePostgresConfig, options: CliOptions): Promise<TraceAggregateReport> {
  let pool = await createTraceSessionPostgresPool(config);
  let shouldEndPool = true;
  const aggregateOptions = { ...options, groupBy: options.groupBy! };

  try {
    return await aggregateSessionPerformance(pool, aggregateOptions);
  } catch (error) {
    if (!isPostgresPasswordAuthFailure(error)) throw error;
    await pool.end();
    shouldEndPool = false;
    const password = await promptHidden('Postgres password: ');
    pool = createPostgresPool(config, { password });
    try {
      return await aggregateSessionPerformance(pool, aggregateOptions);
    } finally {
      await pool.end();
    }
  } finally {
    if (shouldEndPool) await pool.end();
  }
}

async function runListSessionlessRunsWithPasswordRetry(
  config: TracePostgresConfig,
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
    pool = createPostgresPool(config, { password });
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
  config: TracePostgresConfig,
  options: CliOptions,
): Promise<SessionUsageSummary> {
  const key = cacheKey(config, options, 'usage');
  if (!options.noCache && !options.fresh) {
    const cached = await readCache(key, options.cacheTtl);
    if (cached) return cached as SessionUsageSummary;
  }
  let pool = await createTraceSessionPostgresPool(config);
  let shouldEndPool = true;

  try {
    const loaded = await loadUsageForTraceTargetWithTerminalState(pool, options);
    if (!options.noCache) await writeCache(key, loaded.usage, loaded.terminal, options.cacheTtl).catch(() => undefined);
    return loaded.usage;
  } catch (error) {
    if (!isPostgresPasswordAuthFailure(error)) {
      throw error;
    }

    await pool.end();
    shouldEndPool = false;
    const password = await promptHidden('Postgres password: ');
    pool = createPostgresPool(config, { password });
    try {
      const loaded = await loadUsageForTraceTargetWithTerminalState(pool, options);
      if (!options.noCache) await writeCache(key, loaded.usage, loaded.terminal, options.cacheTtl).catch(() => undefined);
      return loaded.usage;
    } finally {
      await pool.end();
    }
  } finally {
    if (shouldEndPool) {
      await pool.end();
    }
  }
}

async function createTraceSessionPostgresPool(config: TracePostgresConfig): Promise<TracePostgresPool> {
  const connectionString = config.connectionString;
  const password = shouldPromptForPostgresPassword(connectionString) ? await promptHidden('Postgres password: ') : undefined;
  return createPostgresPool(config, { password });
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

function assertOptionApplies(command: string, option: string, options: CliOptions): void {
  const globalOptions = ['--database-url', '--database-url-env', '--config', '--pgssl', '--help', '-h'];
  const optionsByCommand: Record<string, string[]> = {
    view: ['--root-run', '--report', '--focus-run', '--messages', '--reasoning', '--messages-view', '--system-only', '--include-plans', '--only-delegates', '--preview-chars', '--json', '--html', '--fresh', '--no-cache', '--cache-ttl'],
    compare: ['--json', '--html', '--fresh', '--no-cache', '--cache-ttl'],
    list: options.listSessionless
      ? ['--json']
      : ['--goal', '--goal-regex', '--has-goal', '--no-goal', '--status', '--type', '--swarm-role', '--since', '--until', '--limit', '--preview-chars', '--json'],
    aggregate: ['--since', '--until', '--json', '--html'],
    usage: ['--json', '--fresh', '--no-cache', '--cache-ttl'],
    maintenance: ['--json'],
  };
  if (!globalOptions.includes(option) && !optionsByCommand[command]?.includes(option)) {
    throw new Error(`${option} is not available for the ${command} command.`);
  }
}

function requireCommandArgument(name: string, value: string | undefined): string {
  if (!value || value.startsWith('-')) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function requireValue(option: string, value: string | undefined): string {
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function parseReportView(value: string): ReportView {
  if (value === 'brief' || value === 'summary' || value === 'reliability' || value === 'operations' || value === 'overview' || value === 'output' || value === 'investigate' || value === 'policy' || value === 'performance' || value === 'milestones' || value === 'timeline' || value === 'delegates' || value === 'messages' || value === 'plans' || value === 'all') {
    return value;
  }
  throw new Error(`Invalid --report value: ${value}.`);
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

function parseListTimeBoundary(value: string, option: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${option} requires a duration or ISO timestamp.`);
  try {
    resolveListTimeBoundary(normalized);
  } catch {
    throw new Error(`${option} requires a duration such as 24h or 7d, or a valid ISO timestamp.`);
  }
  return normalized;
}

function resolveListTimeBoundary(value: string, now = Date.now()): number {
  const duration = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/i.exec(value);
  if (duration) {
    const multipliers: Record<string, number> = {
      ms: 1,
      s: 1_000,
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
      w: 604_800_000,
    };
    return now - Number(duration[1]) * multipliers[duration[2]!.toLowerCase()]!;
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid time boundary: ${value}`);
  return parsed;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return inspect(error);
}
