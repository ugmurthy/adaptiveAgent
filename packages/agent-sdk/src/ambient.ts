import { createHash, randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { appendFile, copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { AgentDefaults, AgentRun, JsonObject, JsonValue, ModelAdapterConfig, RunResult, RunStatus } from '@adaptive-agent/core';

import type { AgentSdkOptions, AgentSdkRunOptions, ApprovalMode, ClarificationMode, RuntimeMode } from './config-types.js';
import { pathExists } from './sdk-utils.js';

export type AmbientTriggerType = 'filesystem' | 'cron';
export type AmbientCronMisfirePolicy = 'skip';
export type AmbientTaskStatus =
  | 'detected'
  | 'claimed'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'interrupted'
  | 'needs_approval'
  | 'needs_clarification';

export interface AmbientConfigFile {
  version?: 1;
  agent?: string | { configPath?: string };
  settings?: string | { configPath?: string };
  runtime?: { mode?: RuntimeMode };
  workspaceRoot?: string;
  artifactsRoot?: string;
  interaction?: { approvalMode?: ApprovalMode; clarificationMode?: ClarificationMode };
  defaults?: Partial<AgentDefaults>;
  triggers: AmbientTriggerConfig[];
}

export type AmbientTriggerConfig = AmbientFilesystemTriggerConfig | AmbientCronTriggerConfig;

export interface AmbientFilesystemTriggerConfig {
  id: string;
  type: 'filesystem';
  path?: string;
  inboxDir?: string;
  pattern?: string;
  pollIntervalMs?: number;
  stabilityDelayMs?: number;
}

export interface AmbientCronTriggerConfig {
  id: string;
  type: 'cron';
  schedule: string;
  timezone?: string;
  goalFile?: string;
  goal?: string;
  artifactPath?: string;
  pollIntervalMs?: number;
  concurrency?: number;
  misfirePolicy?: AmbientCronMisfirePolicy;
}

export interface ResolvedAmbientConfig {
  configPath: string;
  baseDir: string;
  workspaceRoot: string;
  artifactsRoot: string;
  agentConfigPath?: string;
  settingsConfigPath?: string;
  runtimeMode?: RuntimeMode;
  interaction: { approvalMode: ApprovalMode; clarificationMode: ClarificationMode };
  defaults?: Partial<AgentDefaults>;
  triggers: ResolvedAmbientTrigger[];
}

export type ResolvedAmbientTrigger = ResolvedAmbientFilesystemTrigger | ResolvedAmbientCronTrigger;

export interface ResolvedAmbientFilesystemTrigger {
  id: string;
  type: 'filesystem';
  inboxDir: string;
  pendingDir: string;
  processingDir: string;
  processedDir: string;
  failedDir: string;
  ledgerPath: string;
  pattern: string;
  pollIntervalMs: number;
  stabilityDelayMs: number;
}

export interface ResolvedAmbientCronTrigger {
  id: string;
  type: 'cron';
  schedule: string;
  timezone: string;
  goalFilePath?: string;
  goal?: string;
  artifactPath?: string;
  ledgerPath: string;
  pollIntervalMs: number;
  concurrency: 1;
  misfirePolicy: AmbientCronMisfirePolicy;
}

export interface AmbientTaskRecord {
  id: string;
  triggerId: string;
  triggerType: AmbientTriggerType;
  sourceUri: string;
  originalSourcePath?: string;
  processingPath?: string;
  finalSourcePath?: string;
  contentHash?: string;
  scheduledAt?: string;
  goalFilePath?: string;
  sessionId: string;
  runId?: string;
  artifactDir: string;
  status: AmbientTaskStatus;
  attempt: number;
  detectedAt: string;
  claimedAt?: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
  error?: { message: string; code?: string };
}

export interface AmbientAgentSdk {
  runRaw(goal: string, options?: AgentSdkRunOptions): Promise<RunResult>;
  inspect?(runId: string): Promise<{ run: AgentRun | null | undefined; events: unknown[] }>;
  close(): Promise<void>;
}

export interface AmbientStartOptions {
  configPath: string;
  cwd?: string;
  agentConfigPath?: string;
  settingsConfigPath?: string;
  runtimeMode?: RuntimeMode;
  provider?: ModelAdapterConfig['provider'];
  model?: string;
  approvalMode?: ApprovalMode;
  clarificationMode?: ClarificationMode;
  output?: 'pretty' | 'json' | 'jsonl';
  dryRun?: boolean;
  runOnce?: boolean;
  clock?: () => Date;
  signal?: AbortSignal;
  createSdk?: (options: AgentSdkOptions) => Promise<AmbientAgentSdk>;
  logger?: AmbientLogger;
}

export interface AmbientStartResult {
  status: 'dry_run' | 'run_once' | 'stopped';
  config: ResolvedAmbientConfig;
  sdkOptions: AgentSdkOptions;
  tasks: AmbientTaskRecord[];
}

export interface AmbientLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const DEFAULT_INBOX_DIR = 'agent_inbox';
const DEFAULT_ARTIFACTS_ROOT = 'artifacts/ambient';
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_STABILITY_DELAY_MS = 1_000;
const DEFAULT_CRON_TIMEZONE = 'UTC';
const DEFAULT_CRON_MISFIRE_POLICY: AmbientCronMisfirePolicy = 'skip';

interface ParsedCronField {
  values: Set<number>;
  wildcard: boolean;
}

interface ParsedCronSchedule {
  minute: ParsedCronField;
  hour: ParsedCronField;
  dayOfMonth: ParsedCronField;
  month: ParsedCronField;
  dayOfWeek: ParsedCronField;
}

interface CronOccurrence {
  id: string;
  scheduledAt: string;
  parts: TimeZoneParts;
}

interface TimeZoneParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
  offset: string;
}

const MONTH_NAME_VALUES = new Map<string, number>([
  ['JAN', 1],
  ['FEB', 2],
  ['MAR', 3],
  ['APR', 4],
  ['MAY', 5],
  ['JUN', 6],
  ['JUL', 7],
  ['AUG', 8],
  ['SEP', 9],
  ['OCT', 10],
  ['NOV', 11],
  ['DEC', 12],
]);

const WEEKDAY_NAME_VALUES = new Map<string, number>([
  ['SUN', 0],
  ['MON', 1],
  ['TUE', 2],
  ['WED', 3],
  ['THU', 4],
  ['FRI', 5],
  ['SAT', 6],
]);

export async function loadAmbientConfig(configPath: string, cwd = process.cwd()): Promise<ResolvedAmbientConfig> {
  const resolvedPath = resolve(cwd, configPath);
  const baseDir = dirname(resolvedPath);
  const parsed = parseJsonObject(await readAmbientConfigFile(resolvedPath, configPath, cwd), resolvedPath);

  const version = optionalNumber(parsed.version, 'version');
  if (version !== undefined && version !== 1) throw new Error(`Ambient config ${resolvedPath} has unsupported version: ${version}`);

  const workspaceRoot = resolveConfigPath(baseDir, optionalString(parsed.workspaceRoot, 'workspaceRoot') ?? '.');
  const artifactsRoot = resolveWorkspacePath(workspaceRoot, optionalString(parsed.artifactsRoot, 'artifactsRoot') ?? DEFAULT_ARTIFACTS_ROOT);
  const interaction = parseAmbientInteraction(parsed.interaction);
  const triggers = parseAmbientTriggers(parsed.triggers, workspaceRoot, artifactsRoot);
  const runtimeMode = parseRuntimeMode(parsed.runtime);

  return {
    configPath: resolvedPath,
    baseDir,
    workspaceRoot,
    artifactsRoot,
    ...optionalAgentConfigPathField(baseDir, parseConfigPath(parsed.agent, 'agent')),
    ...optionalSettingsPathField(baseDir, parseConfigPath(parsed.settings, 'settings')),
    ...(runtimeMode ? { runtimeMode } : {}),
    interaction,
    ...(parsed.defaults === undefined ? {} : { defaults: parseObject(parsed.defaults, 'defaults') as Partial<AgentDefaults> }),
    triggers,
  };
}

async function readAmbientConfigFile(resolvedPath: string, originalPath: string, cwd: string): Promise<string> {
  try {
    return await readFile(resolvedPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Ambient config not found: ${resolvedPath}. --config paths are resolved from ${cwd}; pass an absolute path or run the command from the config directory.`);
    }
    throw new Error(`Unable to read ambient config ${originalPath} (${resolvedPath}): ${errorMessage(error)}`);
  }
}

export function buildAmbientSdkOptions(config: ResolvedAmbientConfig, options: Partial<AmbientStartOptions> = {}): AgentSdkOptions {
  const approvalMode = options.approvalMode ?? config.interaction.approvalMode;
  const clarificationMode = options.clarificationMode ?? config.interaction.clarificationMode;

  return {
    cwd: config.workspaceRoot,
    agentConfigPath: options.agentConfigPath ?? config.agentConfigPath,
    settingsConfigPath: options.settingsConfigPath ?? config.settingsConfigPath,
    runtimeMode: options.runtimeMode ?? config.runtimeMode,
    model: options.provider || options.model
      ? {
          ...(options.provider ? { provider: options.provider } : {}),
          ...(options.model ? { model: options.model } : {}),
        }
      : undefined,
    settingsOverrides: {
      interaction: { approvalMode, clarificationMode },
      workspace: { overrideRoot: config.workspaceRoot, overrideShellCwd: config.workspaceRoot },
      ...(config.defaults ? { defaults: config.defaults } : {}),
    },
  };
}

export async function runAmbientStart(options: AmbientStartOptions): Promise<AmbientStartResult> {
  const config = await loadAmbientConfig(options.configPath, options.cwd);
  const sdkOptions = buildAmbientSdkOptions(config, options);
  if (options.dryRun) return { status: 'dry_run', config, sdkOptions, tasks: [] };

  const logger = options.logger ?? createAmbientLogger(options.output ?? 'pretty');
  const sdk = await (options.createSdk ?? createDefaultAgentSdk)(sdkOptions);
  const supervisor = new AmbientSupervisor(config, sdk, logger, options.signal, options.clock);

  try {
    return {
      status: options.runOnce ? 'run_once' : 'stopped',
      config,
      sdkOptions,
      tasks: await supervisor.start({ runOnce: options.runOnce === true }),
    };
  } finally {
    await sdk.close();
  }
}

class AmbientSupervisor {
  private readonly ledgers = new Map<string, AmbientLedger>();
  private readonly watchers: FSWatcher[] = [];
  private readonly intervals: Array<ReturnType<typeof setInterval>> = [];
  private readonly activeScans = new Set<string>();
  private readonly rescanRequested = new Set<string>();
  private readonly activeCronChecks = new Set<string>();
  private readonly activeWork = new Set<Promise<void>>();
  private readonly tasks: AmbientTaskRecord[] = [];
  private stopped = false;

  constructor(
    private readonly config: ResolvedAmbientConfig,
    private readonly sdk: AmbientAgentSdk,
    private readonly logger: AmbientLogger,
    private readonly signal: AbortSignal | undefined,
    private readonly clock: (() => Date) | undefined,
  ) {}

  async start(options: { runOnce: boolean }): Promise<AmbientTaskRecord[]> {
    await mkdir(this.config.artifactsRoot, { recursive: true });
    for (const trigger of this.config.triggers) {
      await this.prepareTrigger(trigger);
      if (trigger.type === 'filesystem') {
        await this.reconcileProcessing(trigger);
        this.scheduleScan(trigger);
      } else {
        await this.reconcileCron(trigger);
        this.scheduleCronCheck(trigger);
      }
    }

    if (options.runOnce) {
      await this.waitForActiveWork();
      return this.tasks;
    }

    this.startBackgroundTriggers();
    await this.waitForStopSignal();
    this.stopped = true;
    this.stopBackgroundTriggers();
    await this.waitForActiveWork();
    return this.tasks;
  }

  private async prepareTrigger(trigger: ResolvedAmbientTrigger): Promise<void> {
    if (trigger.type === 'filesystem') {
      await Promise.all([
        mkdir(trigger.pendingDir, { recursive: true }),
        mkdir(trigger.processingDir, { recursive: true }),
        mkdir(trigger.processedDir, { recursive: true }),
        mkdir(trigger.failedDir, { recursive: true }),
        mkdir(dirname(trigger.ledgerPath), { recursive: true }),
      ]);
      this.logger.info(`ambient trigger ${trigger.id}: watching ${trigger.pendingDir}`);
    } else {
      await mkdir(dirname(trigger.ledgerPath), { recursive: true });
      this.logger.info(`ambient trigger ${trigger.id}: scheduling ${trigger.schedule} ${trigger.timezone}`);
    }
    this.ledgers.set(trigger.id, new AmbientLedger(trigger.ledgerPath));
  }

  private async reconcileProcessing(trigger: ResolvedAmbientFilesystemTrigger): Promise<void> {
    const entries = await readdir(trigger.processingDir, { withFileTypes: true }).catch(() => []);
    if (entries.length === 0) return;

    const records = await this.ledger(trigger).loadLatest();
    const recordsByProcessingPath = new Map(
      [...records.values()]
        .filter((record): record is AmbientTaskRecord & { processingPath: string } => typeof record.processingPath === 'string')
        .map((record) => [record.processingPath, record]),
    );

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const processingPath = join(trigger.processingDir, entry.name);
      const record = recordsByProcessingPath.get(processingPath);
      if (!record) {
        const pendingPath = await uniqueDestinationPath(trigger.pendingDir, entry.name, randomUUID());
        await rename(processingPath, pendingPath).catch(() => undefined);
        this.logger.warn(`ambient trigger ${trigger.id}: requeued untracked processing file ${entry.name}`);
        continue;
      }

      if (record.status === 'claimed' && !record.runId) {
        const originalName = originalSourceName(record, entry.name);
        const pendingPath = await uniqueDestinationPath(trigger.pendingDir, originalName, record.id);
        await rename(processingPath, pendingPath).catch(() => undefined);
        await this.ledger(trigger).append({ ...record, processingPath: pendingPath, status: 'detected', updatedAt: new Date().toISOString() });
        this.logger.warn(`ambient trigger ${trigger.id}: requeued claimed task ${record.id}`);
        continue;
      }

      if (!record.runId || !this.sdk.inspect) continue;

      const inspected = await this.sdk.inspect(record.runId).catch(() => undefined);
      if (!inspected?.run) {
        const originalName = originalSourceName(record, entry.name);
        const pendingPath = await uniqueDestinationPath(trigger.pendingDir, originalName, record.id);
        await rename(processingPath, pendingPath).catch(() => undefined);
        await this.ledger(trigger).append({ ...record, processingPath: pendingPath, status: 'detected', updatedAt: new Date().toISOString() });
        this.logger.warn(`ambient trigger ${trigger.id}: requeued task ${record.id} because run ${record.runId} was not found`);
        continue;
      }

      const runStatus = inspected.run.status;
      const ambientStatus = runStatus ? ambientStatusFromRunStatus(runStatus) : undefined;
      if (!ambientStatus) continue;

      const finalDir = ambientStatus === 'succeeded' ? trigger.processedDir : trigger.failedDir;
      const finalSourcePath = await moveTaskFile(processingPath, finalDir, originalSourceName(record, entry.name), record.id);
      const updated = await this.ledger(trigger).append({
        ...record,
        finalSourcePath,
        status: ambientStatus,
        completedAt: inspected?.run?.completedAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...(inspected?.run?.errorMessage ? { error: { message: inspected.run.errorMessage, ...(inspected.run.errorCode ? { code: inspected.run.errorCode } : {}) } } : {}),
      });
      this.tasks.push(updated);
      this.logger.info(`ambient task ${record.id}: reconciled as ${ambientStatus}`);
    }
  }

  private async reconcileCron(trigger: ResolvedAmbientCronTrigger): Promise<void> {
    if (!this.sdk.inspect) return;
    const records = await this.ledger(trigger).loadLatest();
    for (const record of records.values()) {
      if (record.triggerType !== 'cron' || record.triggerId !== trigger.id || isTerminalAmbientStatus(record.status)) continue;
      if (!record.runId) {
        const failed = await this.ledger(trigger).append({
          ...record,
          status: 'failed',
          completedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          error: { message: 'Cron occurrence was claimed before a run started' },
        });
        this.tasks.push(failed);
        this.logger.warn(`ambient task ${record.id}: marked failed because no run was recorded`);
        continue;
      }
      const inspected = await this.sdk.inspect(record.runId).catch(() => undefined);
      if (!inspected?.run) {
        const failed = await this.ledger(trigger).append({
          ...record,
          status: 'failed',
          completedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          error: { message: `Run ${record.runId} was not found`, code: 'RUN_NOT_FOUND' },
        });
        this.tasks.push(failed);
        this.logger.warn(`ambient task ${record.id}: marked failed because run ${record.runId} was not found`);
        continue;
      }
      const runStatus = inspected?.run?.status;
      const ambientStatus = runStatus ? ambientStatusFromRunStatus(runStatus) : undefined;
      if (!ambientStatus) continue;
      const updated = await this.ledger(trigger).append({
        ...record,
        status: ambientStatus,
        completedAt: inspected?.run?.completedAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...(inspected?.run?.errorMessage ? { error: { message: inspected.run.errorMessage, ...(inspected.run.errorCode ? { code: inspected.run.errorCode } : {}) } } : {}),
      });
      this.tasks.push(updated);
      this.logger.info(`ambient task ${record.id}: reconciled as ${ambientStatus}`);
    }
  }

  private startBackgroundTriggers(): void {
    for (const trigger of this.config.triggers) {
      const interval = setInterval(() => {
        if (trigger.type === 'filesystem') this.scheduleScan(trigger);
        else this.scheduleCronCheck(trigger);
      }, trigger.pollIntervalMs);
      this.intervals.push(interval);
      if (trigger.type !== 'filesystem') continue;
      try {
        const watcher = watch(trigger.pendingDir, () => this.scheduleScan(trigger));
        this.watchers.push(watcher);
      } catch (error) {
        this.logger.warn(`ambient trigger ${trigger.id}: filesystem watch unavailable; polling only (${errorMessage(error)})`);
      }
    }
  }

  private stopBackgroundTriggers(): void {
    for (const interval of this.intervals) clearInterval(interval);
    for (const watcher of this.watchers) watcher.close();
  }

  private scheduleScan(trigger: ResolvedAmbientFilesystemTrigger): void {
    if (this.stopped) return;
    if (this.activeScans.has(trigger.id)) {
      this.rescanRequested.add(trigger.id);
      return;
    }

    const work = this.scanLoop(trigger)
      .catch((error) => this.logger.error(`ambient trigger ${trigger.id}: scan failed: ${errorMessage(error)}`))
      .finally(() => this.activeWork.delete(work));
    this.activeWork.add(work);
  }

  private async scanLoop(trigger: ResolvedAmbientFilesystemTrigger): Promise<void> {
    this.activeScans.add(trigger.id);
    try {
      do {
        this.rescanRequested.delete(trigger.id);
        await this.scanTrigger(trigger);
      } while (!this.stopped && this.rescanRequested.has(trigger.id));
    } finally {
      this.activeScans.delete(trigger.id);
    }
  }

  private async scanTrigger(trigger: ResolvedAmbientFilesystemTrigger): Promise<void> {
    const entries = await readdir(trigger.pendingDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (this.stopped) return;
      if (!entry.isFile() || !matchesPattern(entry.name, trigger.pattern)) continue;
      await this.processPendingFile(trigger, join(trigger.pendingDir, entry.name));
    }
  }

  private scheduleCronCheck(trigger: ResolvedAmbientCronTrigger): void {
    if (this.stopped) return;
    if (this.activeCronChecks.has(trigger.id)) return;

    const work = this.checkCronTrigger(trigger)
      .catch((error) => this.logger.error(`ambient trigger ${trigger.id}: cron check failed: ${errorMessage(error)}`))
      .finally(() => this.activeWork.delete(work));
    this.activeWork.add(work);
  }

  private async checkCronTrigger(trigger: ResolvedAmbientCronTrigger): Promise<void> {
    this.activeCronChecks.add(trigger.id);
    try {
      const occurrence = currentCronOccurrence(trigger, this.now());
      if (!occurrence) return;
      if (await this.shouldSkipCronOccurrence(trigger, occurrence.id)) return;
      await this.processCronOccurrence(trigger, occurrence);
    } finally {
      this.activeCronChecks.delete(trigger.id);
    }
  }

  private async shouldSkipCronOccurrence(trigger: ResolvedAmbientCronTrigger, taskId: string): Promise<boolean> {
    const records = await this.ledger(trigger).loadLatest();
    if (records.has(taskId)) return true;
    for (const record of records.values()) {
      if (record.triggerType === 'cron' && record.triggerId === trigger.id && !isTerminalAmbientStatus(record.status)) return true;
    }
    return false;
  }

  private async processCronOccurrence(trigger: ResolvedAmbientCronTrigger, occurrence: CronOccurrence): Promise<void> {
    const goal = await readCronGoal(trigger);
    const now = new Date().toISOString();
    const taskId = occurrence.id;
    const sessionId = taskId;
    const contentHash = sha256(`${trigger.id}\n${trigger.schedule}\n${occurrence.scheduledAt}\n${goal}`);
    const artifactDir = resolveCronArtifactDir(this.config, trigger, occurrence);
    let record: AmbientTaskRecord = {
      id: taskId,
      triggerId: trigger.id,
      triggerType: trigger.type,
      sourceUri: `cron:${trigger.id}:${occurrence.scheduledAt}`,
      ...(trigger.goalFilePath ? { originalSourcePath: trigger.goalFilePath, goalFilePath: trigger.goalFilePath } : {}),
      contentHash,
      scheduledAt: occurrence.scheduledAt,
      sessionId,
      artifactDir,
      status: 'claimed',
      attempt: 1,
      detectedAt: now,
      claimedAt: now,
      updatedAt: now,
    };
    record = await this.ledger(trigger).append(record);
    this.logger.info(`ambient task ${taskId}: claimed cron occurrence ${occurrence.scheduledAt}`);

    try {
      await mkdir(artifactDir, { recursive: true });
      await writeFile(join(artifactDir, 'input.md'), goal);
      await writeJson(join(artifactDir, 'ambient-task.json'), record as unknown as JsonValue);

      record = await this.ledger(trigger).append({ ...record, status: 'running', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      const ambientContext = buildAmbientContext(record);
      const result = await this.sdk.runRaw(goal, {
        sessionId,
        context: { ambient: ambientContext },
        metadata: { ambient: ambientContext },
      });
      await writeJson(join(artifactDir, 'run.json'), result as unknown as JsonValue);

      const status = ambientStatusFromRunResult(result);
      const completed: AmbientTaskRecord = {
        ...record,
        runId: result.runId,
        status,
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...(result.status === 'failure' ? { error: { message: result.error, code: result.code } } : {}),
        ...(result.status === 'approval_requested' ? { error: { message: result.message, code: 'APPROVAL_REQUIRED' } } : {}),
        ...(result.status === 'clarification_requested' ? { error: { message: result.message, code: 'CLARIFICATION_REQUIRED' } } : {}),
      };
      record = await this.ledger(trigger).append(completed);
      this.tasks.push(record);
      this.logger.info(`ambient task ${taskId}: ${status} run=${result.runId}`);
    } catch (error) {
      await mkdir(artifactDir, { recursive: true });
      await writeJson(join(artifactDir, 'error.json'), { message: errorMessage(error) });
      const failed = await this.ledger(trigger).append({
        ...record,
        status: 'failed',
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        error: { message: errorMessage(error) },
      });
      this.tasks.push(failed);
      this.logger.error(`ambient task ${taskId}: failed: ${errorMessage(error)}`);
    }
  }

  private async processPendingFile(trigger: ResolvedAmbientFilesystemTrigger, pendingPath: string): Promise<void> {
    const stable = await waitForStableFile(pendingPath, trigger.stabilityDelayMs);
    if (!stable) return;

    const originalName = basename(pendingPath);
    const content = await readFile(pendingPath, 'utf-8').catch(() => undefined);
    if (content === undefined) return;

    const contentHash = sha256(content);
    const taskId = createTaskId(trigger.id, originalName, contentHash);
    const processingPath = join(trigger.processingDir, `${stripExtension(originalName)}.${taskId}.${Date.now()}${extname(originalName)}`);

    try {
      await rename(pendingPath, processingPath);
    } catch {
      return;
    }

    const now = new Date().toISOString();
    const sessionId = `ambient:${taskId}`;
    const artifactDir = join(this.config.artifactsRoot, taskId);
    let record: AmbientTaskRecord = {
      id: taskId,
      triggerId: trigger.id,
      triggerType: trigger.type,
      sourceUri: pathToFileURL(processingPath).href,
      originalSourcePath: pendingPath,
      processingPath,
      contentHash,
      sessionId,
      artifactDir,
      status: 'claimed',
      attempt: 1,
      detectedAt: now,
      claimedAt: now,
      updatedAt: now,
    };
    record = await this.ledger(trigger).append(record);
    this.logger.info(`ambient task ${taskId}: claimed ${originalName}`);

    try {
      await mkdir(artifactDir, { recursive: true });
      await copyFile(processingPath, join(artifactDir, 'input.md'));
      await writeJson(join(artifactDir, 'ambient-task.json'), record as unknown as JsonValue);

      record = await this.ledger(trigger).append({ ...record, status: 'running', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      const ambientContext = buildAmbientContext(record);
      const result = await this.sdk.runRaw(content, {
        sessionId,
        context: { ambient: ambientContext },
        metadata: { ambient: ambientContext },
      });
      await writeJson(join(artifactDir, 'run.json'), result as unknown as JsonValue);

      const status = ambientStatusFromRunResult(result);
      const finalDir = status === 'succeeded' ? trigger.processedDir : trigger.failedDir;
      const finalSourcePath = await moveTaskFile(processingPath, finalDir, originalName, taskId);
      const completed: AmbientTaskRecord = {
        ...record,
        runId: result.runId,
        finalSourcePath,
        status,
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...(result.status === 'failure' ? { error: { message: result.error, code: result.code } } : {}),
        ...(result.status === 'approval_requested' ? { error: { message: result.message, code: 'APPROVAL_REQUIRED' } } : {}),
        ...(result.status === 'clarification_requested' ? { error: { message: result.message, code: 'CLARIFICATION_REQUIRED' } } : {}),
      };
      record = await this.ledger(trigger).append(completed);
      this.tasks.push(record);
      this.logger.info(`ambient task ${taskId}: ${status} run=${result.runId}`);
    } catch (error) {
      await mkdir(artifactDir, { recursive: true });
      await writeJson(join(artifactDir, 'error.json'), { message: errorMessage(error) });
      const finalSourcePath = await moveTaskFile(processingPath, trigger.failedDir, originalName, taskId);
      const failed = await this.ledger(trigger).append({
        ...record,
        finalSourcePath,
        status: 'failed',
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        error: { message: errorMessage(error) },
      });
      this.tasks.push(failed);
      this.logger.error(`ambient task ${taskId}: failed: ${errorMessage(error)}`);
    }
  }

  private ledger(trigger: ResolvedAmbientTrigger): AmbientLedger {
    const ledger = this.ledgers.get(trigger.id);
    if (!ledger) throw new Error(`Ambient ledger not prepared for trigger ${trigger.id}`);
    return ledger;
  }

  private now(): Date {
    return this.clock?.() ?? new Date();
  }

  private async waitForActiveWork(): Promise<void> {
    while (this.activeWork.size > 0) {
      await Promise.allSettled([...this.activeWork]);
    }
  }

  private async waitForStopSignal(): Promise<void> {
    if (this.signal?.aborted) return;
    await new Promise<void>((resolveStop) => {
      this.signal?.addEventListener('abort', () => resolveStop(), { once: true });
    });
  }
}

class AmbientLedger {
  constructor(private readonly path: string) {}

  async append(record: AmbientTaskRecord): Promise<AmbientTaskRecord> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(record)}\n`);
    return record;
  }

  async loadLatest(): Promise<Map<string, AmbientTaskRecord>> {
    if (!(await pathExists(this.path))) return new Map();
    const content = await readFile(this.path, 'utf-8');
    const records = new Map<string, AmbientTaskRecord>();
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const record = JSON.parse(trimmed) as AmbientTaskRecord;
        if (record.id) records.set(record.id, record);
      } catch {
        // Ignore malformed historical ledger lines so one bad append does not block startup.
      }
    }
    return records;
  }
}

function parseJsonObject(content: string, label: string): Record<string, unknown> {
  try {
    return parseObject(JSON.parse(content) as unknown, label);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Ambient config ${label} must be valid JSON: ${error.message}`);
    throw error;
  }
}

async function createDefaultAgentSdk(options: AgentSdkOptions): Promise<AmbientAgentSdk> {
  const { createAgentSdk } = await import('./index.js');
  return createAgentSdk(options);
}

function parseObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function parseConfigPath(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return nonEmptyString(value, label);
  const object = parseObject(value, label);
  return optionalString(object.configPath, `${label}.configPath`);
}

function optionalAgentConfigPathField(baseDir: string, value: string | undefined): { agentConfigPath?: string } {
  if (!value) return {};
  return { agentConfigPath: isBareAgentName(value) ? value : resolveConfigPath(baseDir, value) };
}

function optionalSettingsPathField(baseDir: string, value: string | undefined): { settingsConfigPath?: string } {
  return value ? { settingsConfigPath: resolveConfigPath(baseDir, value) } : {};
}

function isBareAgentName(value: string): boolean {
  return !isAbsolute(value) && !/[\\/]/.test(value) && extname(value) === '';
}

function parseRuntimeMode(value: unknown): RuntimeMode | undefined {
  if (value === undefined) return undefined;
  const object = parseObject(value, 'runtime');
  const mode = optionalString(object.mode, 'runtime.mode');
  if (mode === undefined) return undefined;
  if (mode !== 'memory' && mode !== 'postgres') throw new Error(`runtime.mode must be memory or postgres`);
  return mode;
}

function parseAmbientInteraction(value: unknown): { approvalMode: ApprovalMode; clarificationMode: ClarificationMode } {
  if (value === undefined) return { approvalMode: 'reject', clarificationMode: 'fail' };
  const object = parseObject(value, 'interaction');
  const approvalMode = optionalString(object.approvalMode, 'interaction.approvalMode') ?? 'reject';
  const clarificationMode = optionalString(object.clarificationMode, 'interaction.clarificationMode') ?? 'fail';
  if (!['manual', 'auto', 'reject'].includes(approvalMode)) throw new Error('interaction.approvalMode must be manual, auto, or reject');
  if (!['interactive', 'fail'].includes(clarificationMode)) throw new Error('interaction.clarificationMode must be interactive or fail');
  return { approvalMode: approvalMode as ApprovalMode, clarificationMode: clarificationMode as ClarificationMode };
}

function parseAmbientTriggers(value: unknown, workspaceRoot: string, artifactsRoot: string): ResolvedAmbientTrigger[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('triggers must be a non-empty array');
  const ids = new Set<string>();
  return value.map((entry, index) => {
    const object = parseObject(entry, `triggers[${index}]`);
    const id = nonEmptyString(object.id, `triggers[${index}].id`);
    if (ids.has(id)) throw new Error(`Duplicate ambient trigger id: ${id}`);
    ids.add(id);
    const type = nonEmptyString(object.type, `triggers[${index}].type`);
    if (type === 'filesystem') return parseFilesystemTrigger(object, index, id, workspaceRoot);
    if (type === 'cron') return parseCronTrigger(object, index, id, workspaceRoot, artifactsRoot);
    throw new Error(`triggers[${index}].type must be filesystem or cron`);
  });
}

function parseFilesystemTrigger(object: Record<string, unknown>, index: number, id: string, workspaceRoot: string): ResolvedAmbientFilesystemTrigger {
  const inboxDir = resolveWorkspacePath(workspaceRoot, optionalString(object.inboxDir, `triggers[${index}].inboxDir`) ?? optionalString(object.path, `triggers[${index}].path`) ?? DEFAULT_INBOX_DIR);
  const pattern = optionalString(object.pattern, `triggers[${index}].pattern`) ?? '*.md';
  const pollIntervalMs = optionalPositiveInteger(object.pollIntervalMs, `triggers[${index}].pollIntervalMs`) ?? DEFAULT_POLL_INTERVAL_MS;
  const stabilityDelayMs = optionalNonNegativeInteger(object.stabilityDelayMs, `triggers[${index}].stabilityDelayMs`) ?? DEFAULT_STABILITY_DELAY_MS;
  return {
    id,
    type: 'filesystem',
    inboxDir,
    pendingDir: join(inboxDir, 'pending'),
    processingDir: join(inboxDir, 'processing'),
    processedDir: join(inboxDir, 'processed'),
    failedDir: join(inboxDir, 'failed'),
    ledgerPath: join(inboxDir, '.ambient', 'tasks.jsonl'),
    pattern,
    pollIntervalMs,
    stabilityDelayMs,
  };
}

function parseCronTrigger(object: Record<string, unknown>, index: number, id: string, workspaceRoot: string, artifactsRoot: string): ResolvedAmbientCronTrigger {
  const schedule = nonEmptyString(object.schedule, `triggers[${index}].schedule`);
  parseCronSchedule(schedule, `triggers[${index}].schedule`);
  const timezone = optionalString(object.timezone, `triggers[${index}].timezone`) ?? DEFAULT_CRON_TIMEZONE;
  validateTimeZone(timezone, `triggers[${index}].timezone`);
  const goalFile = optionalString(object.goalFile, `triggers[${index}].goalFile`);
  const goal = optionalString(object.goal, `triggers[${index}].goal`);
  if (!goalFile && !goal) throw new Error(`triggers[${index}] cron triggers require goalFile or goal`);
  if (goalFile && goal) throw new Error(`triggers[${index}] cron triggers accept goalFile or goal, not both`);
  const artifactPath = optionalString(object.artifactPath, `triggers[${index}].artifactPath`);
  const pollIntervalMs = optionalPositiveInteger(object.pollIntervalMs, `triggers[${index}].pollIntervalMs`) ?? DEFAULT_POLL_INTERVAL_MS;
  const concurrency = optionalPositiveInteger(object.concurrency, `triggers[${index}].concurrency`) ?? 1;
  if (concurrency !== 1) throw new Error(`triggers[${index}].concurrency currently supports only 1`);
  const misfirePolicy = optionalString(object.misfirePolicy, `triggers[${index}].misfirePolicy`) ?? DEFAULT_CRON_MISFIRE_POLICY;
  if (misfirePolicy !== 'skip') throw new Error(`triggers[${index}].misfirePolicy must be skip`);
  return {
    id,
    type: 'cron',
    schedule,
    timezone,
    ...(goalFile ? { goalFilePath: resolveWorkspacePath(workspaceRoot, goalFile) } : {}),
    ...(goal ? { goal } : {}),
    ...(artifactPath ? { artifactPath } : {}),
    ledgerPath: join(artifactsRoot, '.ambient', `${safePathSegment(id)}.tasks.jsonl`),
    pollIntervalMs,
    concurrency: 1,
    misfirePolicy,
  };
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return nonEmptyString(value, label);
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  const parsed = optionalNumber(value, label);
  if (parsed === undefined) return undefined;
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function optionalNonNegativeInteger(value: unknown, label: string): number | undefined {
  const parsed = optionalNumber(value, label);
  if (parsed === undefined) return undefined;
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}

function resolveConfigPath(baseDir: string, value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(baseDir, value);
}

function resolveWorkspacePath(workspaceRoot: string, value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(workspaceRoot, value);
}

function ambientStatusFromRunResult(result: RunResult): AmbientTaskStatus {
  if (result.status === 'success') return 'succeeded';
  if (result.status === 'approval_requested') return 'needs_approval';
  if (result.status === 'clarification_requested') return 'needs_clarification';
  return result.code === 'INTERRUPTED' ? 'interrupted' : 'failed';
}

function ambientStatusFromRunStatus(status: RunStatus): AmbientTaskStatus | undefined {
  if (status === 'succeeded') return 'succeeded';
  if (status === 'failed' || status === 'replan_required' || status === 'cancelled') return 'failed';
  if (status === 'interrupted') return 'interrupted';
  if (status === 'awaiting_approval') return 'needs_approval';
  if (status === 'clarification_requested') return 'needs_clarification';
  return undefined;
}

function buildAmbientContext(record: AmbientTaskRecord): JsonObject {
  const context: JsonObject = {
    taskId: record.id,
    triggerId: record.triggerId,
    triggerType: record.triggerType,
    sourceUri: record.sourceUri,
    artifactDir: record.artifactDir,
  };
  if (record.processingPath) context.sourcePath = record.processingPath;
  if (record.originalSourcePath) context.originalSourcePath = record.originalSourcePath;
  if (record.contentHash) context.contentHash = record.contentHash;
  if (record.scheduledAt) context.scheduledAt = record.scheduledAt;
  if (record.goalFilePath) context.goalFilePath = record.goalFilePath;
  return context;
}

async function readCronGoal(trigger: ResolvedAmbientCronTrigger): Promise<string> {
  if (trigger.goal !== undefined) return trigger.goal;
  if (!trigger.goalFilePath) throw new Error(`Cron trigger ${trigger.id} is missing goalFile`);
  try {
    return await readFile(trigger.goalFilePath, 'utf-8');
  } catch (error) {
    throw new Error(`Unable to read cron goalFile ${trigger.goalFilePath}: ${errorMessage(error)}`);
  }
}

function resolveCronArtifactDir(config: ResolvedAmbientConfig, trigger: ResolvedAmbientCronTrigger, occurrence: CronOccurrence): string {
  if (!trigger.artifactPath) return join(config.artifactsRoot, safePathSegment(occurrence.id));
  return resolveWorkspacePath(config.workspaceRoot, renderAmbientTemplate(trigger.artifactPath, trigger, occurrence));
}

function renderAmbientTemplate(template: string, trigger: ResolvedAmbientCronTrigger, occurrence: CronOccurrence): string {
  const { parts } = occurrence;
  const replacements: Record<string, string> = {
    taskId: safePathSegment(occurrence.id),
    occurrenceId: occurrence.id,
    triggerId: trigger.id,
    scheduledAt: occurrence.scheduledAt,
    yyyy: String(parts.year),
    MM: pad2(parts.month),
    dd: pad2(parts.day),
    HH: pad2(parts.hour),
    mm: pad2(parts.minute),
    yyyyMMdd: `${parts.year}${pad2(parts.month)}${pad2(parts.day)}`,
  };
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key: string) => replacements[key] ?? match);
}

function currentCronOccurrence(trigger: ResolvedAmbientCronTrigger, now: Date): CronOccurrence | undefined {
  const schedule = parseCronSchedule(trigger.schedule, `cron trigger ${trigger.id}.schedule`);
  const parts = getTimeZoneParts(now, trigger.timezone);
  if (!cronScheduleMatches(schedule, parts)) return undefined;
  const scheduledAt = `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}T${pad2(parts.hour)}:${pad2(parts.minute)}:00${parts.offset}`;
  return { id: `ambient:${trigger.id}:${scheduledAt}`, scheduledAt, parts };
}

function cronScheduleMatches(schedule: ParsedCronSchedule, parts: TimeZoneParts): boolean {
  if (!schedule.minute.values.has(parts.minute)) return false;
  if (!schedule.hour.values.has(parts.hour)) return false;
  if (!schedule.month.values.has(parts.month)) return false;

  const dayOfMonthMatches = schedule.dayOfMonth.values.has(parts.day);
  const dayOfWeekMatches = schedule.dayOfWeek.values.has(parts.weekday);
  if (schedule.dayOfMonth.wildcard && schedule.dayOfWeek.wildcard) return true;
  if (schedule.dayOfMonth.wildcard) return dayOfWeekMatches;
  if (schedule.dayOfWeek.wildcard) return dayOfMonthMatches;
  return dayOfMonthMatches || dayOfWeekMatches;
}

function parseCronSchedule(schedule: string, label: string): ParsedCronSchedule {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`${label} must use five fields: minute hour day-of-month month day-of-week`);
  return {
    minute: parseCronField(fields[0]!, 0, 59, `${label}.minute`),
    hour: parseCronField(fields[1]!, 0, 23, `${label}.hour`),
    dayOfMonth: parseCronField(fields[2]!, 1, 31, `${label}.dayOfMonth`),
    month: parseCronField(fields[3]!, 1, 12, `${label}.month`, MONTH_NAME_VALUES),
    dayOfWeek: parseCronField(fields[4]!, 0, 7, `${label}.dayOfWeek`, WEEKDAY_NAME_VALUES, normalizeCronDayOfWeek),
  };
}

function parseCronField(rawField: string, min: number, max: number, label: string, names = new Map<string, number>(), normalize: (value: number) => number = (value) => value): ParsedCronField {
  const values = new Set<number>();
  const raw = rawField.trim();
  const wildcard = raw === '*' || raw === '?';
  for (const segment of raw.split(',')) {
    if (segment.length === 0) throw new Error(`${label} contains an empty segment`);
    const pieces = segment.split('/');
    if (pieces.length > 2) throw new Error(`${label} has an invalid step expression: ${segment}`);
    const rangePart = pieces[0]!;
    const step = pieces[1] === undefined ? 1 : parseCronStep(pieces[1], label);
    const [start, end] = parseCronRange(rangePart, min, max, label, names);
    for (let value = start; value <= end; value += step) values.add(normalize(value));
  }
  if (values.size === 0) throw new Error(`${label} must select at least one value`);
  return { values, wildcard };
}

function parseCronRange(raw: string, min: number, max: number, label: string, names: Map<string, number>): [number, number] {
  if (raw === '*' || raw === '?') return [min, max];
  const pieces = raw.split('-');
  if (pieces.length === 1) {
    const value = parseCronValue(pieces[0]!, min, max, label, names);
    return [value, value];
  }
  if (pieces.length !== 2 || pieces[0] === '' || pieces[1] === '') throw new Error(`${label} has an invalid range: ${raw}`);
  const start = parseCronValue(pieces[0]!, min, max, label, names);
  const end = parseCronValue(pieces[1]!, min, max, label, names);
  if (start > end) throw new Error(`${label} range start must be <= range end: ${raw}`);
  return [start, end];
}

function parseCronStep(raw: string, label: string): number {
  const step = Number(raw);
  if (!Number.isInteger(step) || step <= 0) throw new Error(`${label} step must be a positive integer`);
  return step;
}

function parseCronValue(raw: string, min: number, max: number, label: string, names: Map<string, number>): number {
  const named = names.get(raw.toUpperCase());
  const value = named ?? Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} value must be an integer from ${min} to ${max}: ${raw}`);
  return value;
}

function normalizeCronDayOfWeek(value: number): number {
  return value === 7 ? 0 : value;
}

function validateTimeZone(timezone: string, label: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0));
  } catch {
    throw new Error(`${label} must be a valid IANA timezone`);
  }
}

function getTimeZoneParts(date: Date, timezone: string): TimeZoneParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const formatted = new Map(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const partsWithoutOffset = {
    year: parseTimeZonePart(formatted, 'year', timezone),
    month: parseTimeZonePart(formatted, 'month', timezone),
    day: parseTimeZonePart(formatted, 'day', timezone),
    hour: parseTimeZonePart(formatted, 'hour', timezone),
    minute: parseTimeZonePart(formatted, 'minute', timezone),
    second: parseTimeZonePart(formatted, 'second', timezone),
    weekday: parseWeekdayPart(formatted.get('weekday') ?? '', timezone),
  };
  return { ...partsWithoutOffset, offset: formatTimeZoneOffset(date, partsWithoutOffset) };
}

function parseTimeZonePart(parts: Map<string, string>, key: string, timezone: string): number {
  const value = Number(parts.get(key));
  if (!Number.isInteger(value)) throw new Error(`Unable to read ${key} for timezone ${timezone}`);
  return value;
}

function parseWeekdayPart(value: string, timezone: string): number {
  const weekday = WEEKDAY_NAME_VALUES.get(value.slice(0, 3).toUpperCase());
  if (weekday === undefined) throw new Error(`Unable to read weekday for timezone ${timezone}`);
  return weekday;
}

function formatTimeZoneOffset(date: Date, parts: Omit<TimeZoneParts, 'offset'>): string {
  const localAsUtcMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return formatOffsetMinutes(Math.round((localAsUtcMs - date.getTime()) / 60_000));
}

function formatOffsetMinutes(totalMinutes: number): string {
  const sign = totalMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(totalMinutes);
  return `${sign}${pad2(Math.floor(absolute / 60))}:${pad2(absolute % 60)}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function isTerminalAmbientStatus(status: AmbientTaskStatus): boolean {
  return status === 'succeeded'
    || status === 'failed'
    || status === 'interrupted'
    || status === 'needs_approval'
    || status === 'needs_clarification';
}

function originalSourceName(record: AmbientTaskRecord, fallbackName: string): string {
  return basename(record.originalSourcePath ?? fallbackName);
}

async function waitForStableFile(path: string, delayMs: number): Promise<boolean> {
  const before = await stat(path).catch(() => undefined);
  if (!before?.isFile()) return false;
  if (delayMs > 0) await Bun.sleep(delayMs);
  const after = await stat(path).catch(() => undefined);
  return Boolean(after?.isFile() && before.size === after.size && before.mtimeMs === after.mtimeMs);
}

function matchesPattern(fileName: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern === '*.md') return extname(fileName).toLowerCase() === '.md';
  const regex = new RegExp(`^${pattern.split('*').map(escapeRegex).join('.*')}$`);
  return regex.test(fileName);
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function createTaskId(triggerId: string, fileName: string, contentHash: string): string {
  return safePathSegment(`${triggerId}-${stripExtension(fileName)}-${contentHash.slice(0, 12)}`);
}

function stripExtension(fileName: string): string {
  const extension = extname(fileName);
  return extension ? fileName.slice(0, -extension.length) : fileName;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function moveTaskFile(sourcePath: string, destinationDir: string, originalName: string, taskId: string): Promise<string> {
  const destinationPath = await uniqueDestinationPath(destinationDir, originalName, taskId);
  await rename(sourcePath, destinationPath).catch(async (error) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
  return destinationPath;
}

async function uniqueDestinationPath(destinationDir: string, originalName: string, taskId: string): Promise<string> {
  await mkdir(destinationDir, { recursive: true });
  const extension = extname(originalName);
  const stem = stripExtension(originalName);
  const candidates = [
    join(destinationDir, originalName),
    join(destinationDir, `${stem}.${taskId}${extension}`),
  ];
  for (const candidate of candidates) {
    if (!(await pathExists(candidate))) return candidate;
  }
  return join(destinationDir, `${stem}.${taskId}.${Date.now()}${extension}`);
}

async function writeJson(path: string, value: JsonValue): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function createAmbientLogger(output: 'pretty' | 'json' | 'jsonl'): AmbientLogger {
  if (output !== 'pretty') return { info: () => undefined, warn: () => undefined, error: () => undefined };
  return {
    info: (message) => console.error(message),
    warn: (message) => console.error(`warning: ${message}`),
    error: (message) => console.error(`error: ${message}`),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
