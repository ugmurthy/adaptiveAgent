#!/usr/bin/env bun

import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

import { Database } from 'bun:sqlite';
import {
  createTypeSafeAgentSelectionClient,
  discoverAgentSdkAgents,
  loadTypeSafeAgentSelectionPolicy,
  selectAgentProfileWithTypeSafe,
  type AgentSdkCatalogAgent,
  type AgentSelectionResult,
  type TypeSafeAgentSelectionClient,
  type TypeSafeAgentSelectionPolicyConfig,
  type TypeSafeAgentSelectionResponse,
} from '../packages/agent-sdk/src/index.js';

type OutputFormat = 'table' | 'json' | 'jsonl';
type AttachmentType = 'image' | 'file' | 'audio';
type ContextQuality = 'exact' | 'current-catalog' | 'approximate-current-catalog';

interface StudySettings {
  env?: Record<string, string>;
  runtime?: { mode?: string; sqlitePath?: string };
  agentSelection?: {
    typesafe?: {
      model?: string;
      apiKeyEnv?: string;
      baseUrl?: string;
      timeoutMs?: number;
      policyPath?: string;
      policy?: TypeSafeAgentSelectionPolicyConfig;
    };
  };
}

interface HistoricalCase {
  runId: string;
  sessionId: string;
  objective: string;
  existingSelection?: string;
  selectionRunId?: string;
  candidates?: AgentSdkCatalogAgent[];
  attachments?: AttachmentSummary;
  contextQuality: ContextQuality;
  existingModelLatencyMs?: number;
  existingElapsedMs?: number;
  existingInputTokens?: number;
  existingOutputTokens?: number;
  existingEstimatedCostUSD?: number;
}

export interface AttachmentSummary {
  images: string[];
  files: string[];
  audio: string[];
}

export interface StudyResult {
  runId: string;
  sessionId?: string;
  repetition: number;
  objective: string;
  modalities: string;
  existingSelection?: string;
  jevSelection?: string;
  agreement?: boolean;
  confidence?: number;
  relevance?: number;
  margin?: number;
  accepted?: boolean;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUSD?: number;
  contextQuality: ContextQuality;
  existing?: {
    modelLatencyMs?: number;
    elapsedMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    estimatedCostUSD?: number;
  };
  cached: boolean;
  error?: string;
  state?: unknown;
  response?: unknown;
}

export interface RunStudyOptions {
  mode: 'prompt' | 'history';
  prompt?: string;
  attachmentTypes?: AttachmentType[];
  settingsPath: string;
  databasePath?: string;
  policyPath?: string;
  allowCurrentCatalog: boolean;
  sessionIds?: string[];
  limit?: number;
  repeat: number;
  inputPricePerMillion: number;
  cachePath?: string;
  refresh: boolean;
  showState: boolean;
  showResponse: boolean;
  evaluator?: TypeSafeAgentSelectionClient;
  clockMs?: () => number;
}

interface CachedEvaluation {
  selectedAgentId: string;
  confidence: number;
  relevance: number;
  probabilities: Record<string, number>;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
  response?: TypeSafeAgentSelectionResponse;
}

interface CacheEntry {
  key: string;
  value: CachedEvaluation;
}

const DEFAULT_INPUT_PRICE_PER_MILLION = 0.042;
const DEFAULT_CACHE_PATH = resolve(homedir(), '.adaptiveAgent', 'jev-routing-study-cache.jsonl');

export async function runStudy(options: RunStudyOptions): Promise<StudyResult[]> {
  if (options.mode === 'prompt' && (options.sessionIds?.length || options.limit !== undefined)) {
    throw new Error('--session-id and --limit are available only in history mode.');
  }
  const settingsPath = resolve(options.settingsPath);
  const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as StudySettings;
  const configured = settings.agentSelection?.typesafe ?? {};
  const env = { ...process.env, ...(settings.env ?? {}) };
  const model = configured.model ?? 'jev-latest';
  const policy = await loadTypeSafeAgentSelectionPolicy(
    process.cwd(),
    options.policyPath ?? configured.policyPath,
    options.policyPath ? undefined : configured.policy,
    env,
  );
  const currentCatalog = await discoverAgentSdkAgents({
    cwd: process.cwd(),
    settingsConfigPath: settingsPath,
    env,
  });
  const currentCandidates = currentCatalog.agents;
  let cases: HistoricalCase[];
  if (options.mode === 'prompt') {
    const objective = options.prompt?.trim();
    if (!objective) throw new Error('prompt mode requires a non-empty prompt.');
    cases = [{
      runId: 'prompt',
      objective,
      candidates: currentCandidates,
      attachments: attachmentSummary(options.attachmentTypes ?? []),
      contextQuality: 'current-catalog',
    }];
  } else {
    const databasePath = options.databasePath ?? resolveRuntimeSqlitePath(settings, env);
    cases = extractHistoricalCases(databasePath, {
      sessionIds: options.sessionIds,
      limit: options.limit,
    });
    cases = cases.map((item) => {
      if (item.candidates && item.attachments) return item;
      if (!options.allowCurrentCatalog) {
        throw new Error(`Run ${item.runId} has no exact linked selector context; rerun with --allow-current-catalog to permit an approximate replay.`);
      }
      return {
        ...item,
        candidates: currentCandidates,
        attachments: item.attachments ?? emptyAttachments(),
        contextQuality: 'approximate-current-catalog' as const,
      };
    });
  }

  const policyHash = hashJson(policy);
  const cachePath = options.cachePath ?? DEFAULT_CACHE_PATH;
  const cache = options.repeat === 1 ? await readCache(cachePath) : new Map<string, CachedEvaluation>();
  let client = options.evaluator;
  const clock = options.clockMs ?? (() => performance.now());
  const results: StudyResult[] = [];

  for (const item of cases) {
    const candidates = item.candidates!;
    const attachments = item.attachments!;
    const catalogHash = hashJson(candidates.map(safeCandidateForHash));
    const state = safeStudyState(item.objective, attachments, candidates);
    const keyBase = hashJson({
      case: item.runId === 'prompt' ? { prompt: item.objective, attachmentTypes: attachmentModalities(attachments) } : { runId: item.runId },
      model,
      policyHash,
      catalogHash,
    });
    for (let repetition = 1; repetition <= options.repeat; repetition += 1) {
      const cached = !options.refresh ? cache.get(keyBase) : undefined;
      try {
        const evaluation = cached ?? await evaluateCase(client ??= createLiveClient(configured, env), {
          objective: item.objective,
          candidates,
          attachments,
          model,
          policy,
          clock,
        });
        if (!cached && options.repeat === 1) {
          await appendCache(cachePath, { key: keyBase, value: evaluation });
          cache.set(keyBase, evaluation);
        }
        const margin = probabilityMargin(evaluation.probabilities);
        const accepted = evaluation.confidence >= (policy.minimumConfidence ?? 0.5)
          && evaluation.relevance >= (policy.minimumRelevance ?? 0.5);
        results.push({
          runId: item.runId,
          sessionId: item.sessionId,
          repetition,
          objective: item.objective,
          modalities: modalityMarker(attachments),
          existingSelection: item.existingSelection,
          jevSelection: evaluation.selectedAgentId,
          ...(item.existingSelection ? { agreement: item.existingSelection === evaluation.selectedAgentId } : {}),
          confidence: evaluation.confidence,
          relevance: evaluation.relevance,
          margin,
          accepted,
          latencyMs: evaluation.latencyMs,
          inputTokens: evaluation.inputTokens,
          outputTokens: evaluation.outputTokens,
          estimatedCostUSD: evaluation.inputTokens === undefined
            ? undefined
            : evaluation.inputTokens * options.inputPricePerMillion / 1_000_000,
          contextQuality: item.contextQuality,
          existing: existingMetrics(item),
          cached: Boolean(cached),
          ...(options.showState ? { state } : {}),
          ...(options.showResponse && evaluation.response ? { response: evaluation.response } : {}),
        });
      } catch (error) {
        results.push({
          runId: item.runId,
          sessionId: item.sessionId,
          repetition,
          objective: item.objective,
          modalities: modalityMarker(attachments),
          existingSelection: item.existingSelection,
          contextQuality: item.contextQuality,
          existing: existingMetrics(item),
          cached: false,
          error: error instanceof Error ? error.message : String(error),
          ...(options.showState ? { state } : {}),
        });
      }
    }
  }
  return results;
}

export function extractHistoricalCases(
  databasePath: string,
  selection: { sessionIds?: string[]; limit?: number } = {},
): HistoricalCase[] {
  if (!existsSync(databasePath)) throw new Error(`SQLite runtime database does not exist: ${databasePath}`);
  if (selection.sessionIds?.length && selection.limit !== undefined) {
    throw new Error('--session-id and --limit cannot be used together.');
  }
  const database = new Database(databasePath, { readonly: true, strict: true });
  database.exec('PRAGMA query_only=ON');
  try {
    let rows: RunRow[];
    if (selection.sessionIds?.length) {
      rows = selection.sessionIds.flatMap((sessionId) => {
        const matches = database.query(`
          SELECT id, session_id, record_json
          FROM agent_runs
          WHERE session_id = ?
            AND (${ROUTED_RUN_PREDICATE})
          ORDER BY created_at DESC
        `).all(sessionId) as RunRow[];
        if (matches.length > 0) return matches;
        const exists = database.query('SELECT 1 FROM agent_runs WHERE session_id = ? LIMIT 1').get(sessionId);
        if (!exists) throw new Error(`Session ${sessionId} was not found in the SQLite runtime.`);
        throw new Error(`Session ${sessionId} has no persisted agent-selection runs.`);
      });
    } else if (selection.limit !== undefined) {
      rows = database.query(`
        WITH recent_sessions AS (
          SELECT session_id, MAX(created_at) AS latest_created_at
          FROM agent_runs
          WHERE session_id IS NOT NULL
            AND session_id <> ''
            AND (${ROUTED_RUN_PREDICATE})
          GROUP BY session_id
          ORDER BY latest_created_at DESC
          LIMIT ?
        )
        SELECT runs.id, runs.session_id, runs.record_json
        FROM agent_runs AS runs
        JOIN recent_sessions ON recent_sessions.session_id = runs.session_id
        WHERE ${ROUTED_RUN_PREDICATE.replaceAll('record_json', 'runs.record_json')}
        ORDER BY recent_sessions.latest_created_at DESC, runs.created_at DESC
      `).all(selection.limit) as RunRow[];
    } else {
      rows = database.query(`
        SELECT id, session_id, record_json
        FROM agent_runs
        WHERE session_id IS NOT NULL
          AND session_id <> ''
          AND (${ROUTED_RUN_PREDICATE})
        ORDER BY created_at DESC
      `).all() as RunRow[];
    }
    return rows.map((row) => extractHistoricalCase(database, row));
  } finally {
    database.close();
  }
}

async function evaluateCase(
  client: TypeSafeAgentSelectionClient,
  args: {
    objective: string;
    candidates: AgentSdkCatalogAgent[];
    attachments: AttachmentSummary;
    model: string;
    policy: TypeSafeAgentSelectionPolicyConfig;
    clock: () => number;
  },
): Promise<CachedEvaluation> {
  let response: TypeSafeAgentSelectionResponse | undefined;
  const capturingClient: TypeSafeAgentSelectionClient = {
    async evaluate(request) {
      response = await client.evaluate(request);
      return response;
    },
  };
  const started = args.clock();
  const selection = await selectAgentProfileWithTypeSafe(capturingClient, {
    originalObjective: args.objective,
    candidates: args.candidates,
    workspaceRoot: '<redacted>',
    attachments: args.attachments,
    sessionId: 'jev-routing-study',
  }, args.model, {
    ...args.policy,
    minimumConfidence: 0,
    minimumRelevance: 0,
  });
  const latencyMs = args.clock() - started;
  return evaluationFromSelection(selection, latencyMs, response);
}

function extractHistoricalCase(database: Database, row: RunRow): HistoricalCase {
  const record = parseObject(row.record_json, `agent_runs.record_json for ${row.id}`);
  const metadata = objectValue(record.metadata);
  const taskPreparation = objectValue(metadata.taskPreparation);
  const selection = objectValue(metadata.agentSelection);
  const objective = stringValue(taskPreparation.originalObjective) ?? stringValue(record.goal);
  if (!objective) throw new Error(`Run ${row.id} has no metadata.taskPreparation.originalObjective or goal.`);
  const selectionRunId = stringValue(selection.selectionRunId);
  let existingSelection = stringValue(selection.selectedAgentId);
  let candidates: AgentSdkCatalogAgent[] | undefined;
  let attachments: AttachmentSummary | undefined;
  let contextQuality: ContextQuality = 'approximate-current-catalog';
  let existingModelLatencyMs: number | undefined;
  let existingElapsedMs: number | undefined;
  let existingInputTokens: number | undefined;
  let existingOutputTokens: number | undefined;
  let existingEstimatedCostUSD: number | undefined;

  if (selectionRunId) {
    const selectorRow = database.query('SELECT record_json, created_at, updated_at FROM agent_runs WHERE id = ?').get(selectionRunId) as SelectorRunRow | null;
    if (selectorRow) {
      const selector = parseObject(selectorRow.record_json, `selector run ${selectionRunId}`);
      const input = objectValue(selector.input);
      candidates = historicalCandidates(input.candidates);
      attachments = historicalAttachments(input.attachments);
      if (candidates && attachments) contextQuality = 'exact';
      if (!existingSelection) existingSelection = stringValue(objectValue(selector.result).selectedAgentId);
      existingElapsedMs = elapsedMs(
        stringValue(selector.createdAt) ?? selectorRow.created_at,
        stringValue(selector.completedAt) ?? selectorRow.updated_at,
      );
      const usage = objectValue(selector.usage);
      existingInputTokens = numberValue(usage.promptTokens) ?? numberValue(usage.inputTokens);
      existingOutputTokens = numberValue(usage.completionTokens) ?? numberValue(usage.outputTokens);
      existingEstimatedCostUSD = numberValue(usage.estimatedCostUSD);
      const event = database.query(`
        SELECT payload_json FROM agent_events
        WHERE run_id = ? AND event_type = 'model.completed'
        ORDER BY seq DESC LIMIT 1
      `).get(selectionRunId) as { payload_json: string } | null;
      if (event) existingModelLatencyMs = numberValue(parseObject(event.payload_json, `model.completed for ${selectionRunId}`).durationMs);
    }
  }

  return {
    runId: row.id,
    sessionId: row.session_id,
    objective,
    existingSelection,
    selectionRunId,
    candidates,
    attachments,
    contextQuality,
    existingModelLatencyMs,
    existingElapsedMs,
    existingInputTokens,
    existingOutputTokens,
    existingEstimatedCostUSD,
  };
}

function historicalCandidates(value: unknown): AgentSdkCatalogAgent[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const candidates: AgentSdkCatalogAgent[] = [];
  for (const entry of value) {
    const candidate = objectValue(entry);
    const id = stringValue(candidate.id);
    const name = stringValue(candidate.name);
    const invocationModes = Array.isArray(candidate.invocationModes)
      ? candidate.invocationModes.filter((item): item is 'chat' | 'run' => item === 'chat' || item === 'run')
      : [];
    if (!id || !name || invocationModes.length === 0) return undefined;
    const defaultInvocationMode = candidate.defaultInvocationMode === 'chat' ? 'chat' : 'run';
    candidates.push({
      id,
      name,
      ...(stringValue(candidate.description) ? { description: stringValue(candidate.description)! } : {}),
      configPath: '<historical>',
      path: '<historical>',
      active: false,
      archived: false,
      configurationFingerprint: '<historical>',
      validationState: 'valid',
      invocationModes,
      defaultInvocationMode,
      tools: stringArray(candidate.tools),
      delegates: stringArray(candidate.delegates),
      ...(isRecord(candidate.capabilities) ? { capabilities: candidate.capabilities } : {}),
    } as AgentSdkCatalogAgent);
  }
  return candidates;
}

function historicalAttachments(value: unknown): AttachmentSummary | undefined {
  if (!isRecord(value)) return undefined;
  if (!Array.isArray(value.images) || !Array.isArray(value.files) || !Array.isArray(value.audio)) return undefined;
  return {
    images: value.images.map(() => '<redacted-image>'),
    files: value.files.map(() => '<redacted-file>'),
    audio: value.audio.map(() => '<redacted-audio>'),
  };
}

function createLiveClient(configured: NonNullable<NonNullable<StudySettings['agentSelection']>['typesafe']>, env: NodeJS.ProcessEnv): TypeSafeAgentSelectionClient {
  const apiKeyEnv = configured.apiKeyEnv ?? 'TYPESAFE_API_KEY';
  const apiKey = env[apiKeyEnv];
  if (!apiKey) throw new Error(`TypeSafe routing study requires environment variable "${apiKeyEnv}".`);
  return createTypeSafeAgentSelectionClient({
    apiKey,
    baseUrl: configured.baseUrl,
    timeoutMs: configured.timeoutMs,
  });
}

function resolveRuntimeSqlitePath(settings: StudySettings, env: NodeJS.ProcessEnv): string {
  if (settings.runtime?.mode && settings.runtime.mode !== 'sqlite') {
    throw new Error(`history mode requires a SQLite runtime, but settings.runtime.mode is "${settings.runtime.mode}".`);
  }
  const configured = settings.runtime?.sqlitePath ?? env.ADAPTIVE_AGENT_SQLITE_PATH ?? '~/.adaptiveAgent/runtime.sqlite';
  const expanded = configured
    .replace(/^~(?=$|\/)/, homedir())
    .replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, braced: string, plain: string) => env[braced ?? plain] ?? '');
  return resolve(process.cwd(), expanded);
}

function evaluationFromSelection(selection: AgentSelectionResult, latencyMs: number, response?: TypeSafeAgentSelectionResponse): CachedEvaluation {
  if (selection.confidence === undefined || selection.relevance === undefined || !selection.probabilities || !selection.selectionModel) {
    throw new Error('TypeSafe selector did not return study metrics.');
  }
  return {
    selectedAgentId: selection.selectedAgentId,
    confidence: selection.confidence,
    relevance: selection.relevance,
    probabilities: selection.probabilities,
    model: selection.selectionModel,
    inputTokens: selection.usage?.inputTokens,
    outputTokens: selection.usage?.outputTokens,
    latencyMs,
    response,
  };
}

function safeStudyState(objective: string, attachments: AttachmentSummary, candidates: AgentSdkCatalogAgent[]): unknown {
  return {
    objective,
    attachments: {
      types: attachmentModalities(attachments),
      counts: { images: attachments.images.length, files: attachments.files.length, audio: attachments.audio.length },
    },
    candidates: candidates.map(safeCandidateForHash),
  };
}

function safeCandidateForHash(candidate: AgentSdkCatalogAgent): unknown {
  return {
    id: candidate.id,
    name: candidate.name,
    description: candidate.description ?? '',
    invocationModes: candidate.invocationModes,
    defaultInvocationMode: candidate.defaultInvocationMode,
    tools: candidate.tools,
    delegates: candidate.delegates,
    capabilities: candidate.capabilities ?? {},
  };
}

function attachmentSummary(types: AttachmentType[]): AttachmentSummary {
  return {
    images: types.filter((type) => type === 'image').map(() => '<redacted-image>'),
    files: types.filter((type) => type === 'file').map(() => '<redacted-file>'),
    audio: types.filter((type) => type === 'audio').map(() => '<redacted-audio>'),
  };
}

function emptyAttachments(): AttachmentSummary {
  return { images: [], files: [], audio: [] };
}

function attachmentModalities(attachments: AttachmentSummary): AttachmentType[] {
  return [
    ...(attachments.images.length ? ['image' as const] : []),
    ...(attachments.files.length ? ['file' as const] : []),
    ...(attachments.audio.length ? ['audio' as const] : []),
  ];
}

export function modalityMarker(attachments: AttachmentSummary): string {
  const marker = [
    ...(attachments.images.length ? ['I'] : []),
    ...(attachments.audio.length ? ['A'] : []),
    ...(attachments.files.length ? ['F'] : []),
  ].join('');
  return marker || '-';
}

function probabilityMargin(probabilities: Record<string, number>): number | undefined {
  const sorted = Object.values(probabilities).filter(Number.isFinite).sort((a, b) => b - a);
  if (sorted.length === 0) return undefined;
  return sorted[0]! - (sorted[1] ?? 0);
}

function existingMetrics(item: HistoricalCase): StudyResult['existing'] | undefined {
  const result = {
    modelLatencyMs: item.existingModelLatencyMs,
    elapsedMs: item.existingElapsedMs,
    inputTokens: item.existingInputTokens,
    outputTokens: item.existingOutputTokens,
    estimatedCostUSD: item.existingEstimatedCostUSD,
  };
  return Object.values(result).some((value) => value !== undefined) ? result : undefined;
}

async function readCache(path: string): Promise<Map<string, CachedEvaluation>> {
  const entries = new Map<string, CachedEvaluation>();
  if (!existsSync(path)) return entries;
  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as CacheEntry;
      if (entry.key && entry.value) entries.set(entry.key, entry.value);
    } catch {
      // Ignore an interrupted final append; prior JSONL entries remain usable.
    }
  }
  return entries;
}

async function appendCache(path: string, entry: CacheEntry): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

function elapsedMs(start: string, end: string): number | undefined {
  const value = Date.parse(end) - Date.parse(start);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseObject(json: string, label: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed)) throw new Error(`${label} is not a JSON object.`);
  return parsed;
}

function objectValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

const ROUTED_RUN_PREDICATE = `
  json_extract(record_json, '$.metadata.agentSelection.selectedAgentId') IS NOT NULL
  OR json_extract(record_json, '$.metadata.agentSelection.selectionRunId') IS NOT NULL
`;

interface RunRow { id: string; session_id: string; record_json: string }
interface SelectorRunRow { record_json: string; created_at: string; updated_at: string }

interface CliOptions extends Omit<RunStudyOptions, 'mode' | 'settingsPath' | 'repeat' | 'inputPricePerMillion' | 'allowCurrentCatalog' | 'refresh' | 'showState' | 'showResponse'> {
  mode: 'prompt' | 'history';
  settingsPath: string;
  repeat: number;
  inputPricePerMillion: number;
  allowCurrentCatalog: boolean;
  refresh: boolean;
  showState: boolean;
  showResponse: boolean;
  output: OutputFormat;
}

function parseCli(argv: string[]): CliOptions {
  if (argv[0] === '--help') {
    printHelp();
    process.exit(0);
  }
  const mode = argv.shift();
  if (mode !== 'prompt' && mode !== 'history') throw new Error('Usage: jev-routing-study <prompt|history> [options]');
  const options: CliOptions = {
    mode,
    settingsPath: './agent.settings.json',
    allowCurrentCatalog: true,
    repeat: 1,
    inputPricePerMillion: DEFAULT_INPUT_PRICE_PER_MILLION,
    refresh: false,
    showState: false,
    showResponse: false,
    output: 'table',
    attachmentTypes: [],
    sessionIds: [],
  };
  const promptParts: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const value = () => {
      const next = argv[++index];
      if (!next) throw new Error(`${arg} requires a value.`);
      return next;
    };
    switch (arg) {
      case '--settings': options.settingsPath = value(); break;
      case '--database': options.databasePath = value(); break;
      case '--policy': options.policyPath = value(); break;
      case '--cache': options.cachePath = value(); break;
      case '--session-id': options.sessionIds!.push(value()); break;
      case '--limit': options.limit = positiveInteger(value(), '--limit'); break;
      case '--attachment-type': {
        for (const type of value().split(',')) {
          if (type !== 'image' && type !== 'file' && type !== 'audio') throw new Error(`Unsupported attachment type "${type}".`);
          options.attachmentTypes!.push(type);
        }
        break;
      }
      case '--repeat': options.repeat = positiveInteger(value(), '--repeat'); break;
      case '--input-price-per-million': options.inputPricePerMillion = nonNegativeNumber(value(), arg); break;
      case '--output': {
        const output = value();
        if (output !== 'table' && output !== 'json' && output !== 'jsonl') throw new Error(`Unsupported output "${output}".`);
        options.output = output;
        break;
      }
      case '--allow-current-catalog': options.allowCurrentCatalog = true; break;
      case '--no-allow-current-catalog': options.allowCurrentCatalog = false; break;
      case '--refresh': options.refresh = true; break;
      case '--show-state': options.showState = true; break;
      case '--show-response': options.showResponse = true; break;
      case '--help': printHelp(); process.exit(0);
      default:
        if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}.`);
        promptParts.push(arg);
    }
  }
  if (mode === 'prompt') {
    options.prompt = promptParts.join(' ');
    if (options.sessionIds?.length || options.limit !== undefined) {
      throw new Error('--session-id and --limit are available only in history mode.');
    }
  } else if (promptParts.length) {
    throw new Error('history mode does not accept a prompt.');
  }
  if (options.sessionIds?.length && options.limit !== undefined) {
    throw new Error('--session-id and --limit cannot be used together.');
  }
  return options;
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer.`);
  return parsed;
}

function nonNegativeNumber(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${flag} must be a non-negative number.`);
  return parsed;
}

function printHelp(): void {
  console.log(`TypeSafe JEV routing study

Usage:
  bun run scripts/jev-routing-study.ts prompt [options] <prompt>
  bun run scripts/jev-routing-study.ts history [options]

Options:
  --settings <path>                 Settings file (default: ./agent.settings.json)
  --database <path>                 Override the resolved SQLite runtime path
  --policy <path>                   Override the configured TypeSafe policy
  --attachment-type <type>          image, file, or audio; repeatable
  --session-id <id>                 Replay routed runs in one session; repeatable
  --limit <n>                       Replay the latest n routed non-null sessions
  --[no-]allow-current-catalog      Permit approximate history replay (default: enabled)
  --input-price-per-million <usd>   Estimated JEV input price (default: 0.042)
  --repeat <count>                  Repeat each evaluation (paid calls; cache disabled)
  --cache <path>                    JSONL cache path
  --refresh                         Bypass cached evaluations
  --show-state                      Include the path-free JEV state
  --show-response                   Include the API response (not monetary cost or latency)
  --output <table|json|jsonl>       Output format (default: table)`);
}

function render(results: StudyResult[], output: OutputFormat): void {
  if (output === 'json') {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  if (output === 'jsonl') {
    for (const result of results) console.log(JSON.stringify(result));
    return;
  }
  const rows = results.map((result) => ({
    session: result.repetition > 1
      ? `${short(result.sessionId ?? '-', 12)}#${result.repetition}`
      : short(result.sessionId ?? '-', 12),
    objective: short(result.objective.replace(/\s+/g, ' '), 42),
    modalities: result.modalities,
    existing: result.existingSelection ?? '-',
    jev: result.jevSelection ?? 'ERROR',
    agree: result.agreement === undefined ? '-' : result.agreement ? 'yes' : 'NO',
    conf: decimal(result.confidence),
    rel: decimal(result.relevance),
    margin: decimal(result.margin),
    latency: `${formatMs(result.existing?.modelLatencyMs)}/${formatMs(result.latencyMs)}`,
    elapsed: formatMs(result.existing?.elapsedMs),
    tokens: `${formatTokens(result.existing?.inputTokens, result.existing?.outputTokens)}/${formatTokens(result.inputTokens, result.outputTokens)}`,
    estCost: `${formatCost(result.existing?.estimatedCostUSD)}/${formatCost(result.estimatedCostUSD)}`,
    context: result.contextQuality === 'approximate-current-catalog' ? 'approx' : result.contextQuality,
    status: result.error ? short(result.error, 28) : result.accepted ? (result.cached ? 'cached' : 'accepted') : 'LOW',
  }));
  console.table(rows);
  console.error('JEV latency is client wall-clock time; JEV cost is estimated from input tokens only. API responses do not provide monetary cost or server latency.');
}

function short(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}

function decimal(value: number | undefined): string {
  return value === undefined ? '-' : value.toFixed(3);
}

function formatMs(value: number | undefined): string {
  return value === undefined ? '-' : `${Math.round(value)}ms`;
}

function formatTokens(input: number | undefined, output: number | undefined): string {
  return input === undefined ? '-' : `${input}/${output ?? 0}`;
}

function formatCost(value: number | undefined): string {
  return value === undefined ? '-' : `$${value.toFixed(8)}`;
}

if (import.meta.main) {
  try {
    const options = parseCli(process.argv.slice(2));
    if (options.repeat > 1) {
      console.error(`WARNING: --repeat ${options.repeat} makes repeated paid JEV calls for every case; cache reads and writes are disabled.`);
    }
    render(await runStudy(options), options.output);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
