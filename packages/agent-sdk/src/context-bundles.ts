import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import { isUuid, type ContextRef, type JsonValue, type RunStatus } from '@adaptive-agent/core';

export interface ContextBundle {
  schemaVersion: 1;
  name: string;
  description?: string;
  refs: ContextRef[];
}

export type ContextBundleInput =
  | { kind: 'ref'; ref: ContextRef }
  | { kind: 'bundle'; name: string };

export interface ProjectContextBundle {
  bundle: ContextBundle;
  scope: 'project';
  projectRoot: string;
  path: string;
  digest: string;
}

export interface ContextBundleAudit {
  name: string;
  scope: 'project';
  digest: string;
  expandedRefs: ContextRef[];
}

export interface ContextBundleExpansion {
  refs: ContextRef[];
  bundles: ContextBundleAudit[];
}

export interface CreateContextBundleOptions {
  cwd?: string;
  name: string;
  description?: string;
  refs: ContextRef[];
  force?: boolean;
  dryRun?: boolean;
}

export interface DeleteContextBundleOptions {
  cwd?: string;
  name: string;
  dryRun?: boolean;
}

export interface ContextBundleMutationResult {
  record: ProjectContextBundle;
  dryRun: boolean;
  status: 'created' | 'overwritten' | 'deleted';
}

const RUN_STATUSES: readonly RunStatus[] = [
  'queued',
  'planning',
  'awaiting_approval',
  'awaiting_subagent',
  'running',
  'interrupted',
  'succeeded',
  'failed',
  'clarification_requested',
  'replan_required',
  'cancelled',
];

const BUNDLE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function projectContextBundleDirectory(cwd = process.cwd()): string {
  return resolve(cwd, '.adaptiveAgent', 'context-bundles');
}

export async function createProjectContextBundle(options: CreateContextBundleOptions): Promise<ContextBundleMutationResult> {
  const projectRoot = resolve(options.cwd ?? process.cwd());
  const name = validateContextBundleName(options.name);
  const directory = projectContextBundleDirectory(projectRoot);
  const path = resolve(directory, `${name}.json`);
  const exists = await pathExists(path);
  if (exists && !options.force) {
    throw new Error(`Context bundle "${name}" already exists at ${path}; use --force to overwrite it.`);
  }

  const description = options.description?.trim();
  const bundle = parseContextBundle({
    schemaVersion: 1,
    name,
    ...(description ? { description } : {}),
    refs: options.refs,
  }, `Context bundle "${name}"`);
  const record = projectContextBundleRecord(bundle, projectRoot, path);

  if (!options.dryRun) {
    await mkdir(directory, { recursive: true });
    await writeFile(path, `${JSON.stringify(bundle, null, 2)}\n`);
  }

  return {
    record,
    dryRun: options.dryRun ?? false,
    status: exists ? 'overwritten' : 'created',
  };
}

export async function getProjectContextBundle(name: string, cwd = process.cwd()): Promise<ProjectContextBundle> {
  const projectRoot = resolve(cwd);
  const normalizedName = validateContextBundleName(name);
  const path = resolve(projectContextBundleDirectory(projectRoot), `${normalizedName}.json`);
  let content: string;
  try {
    content = await readFile(path, 'utf-8');
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      throw new Error(`Unknown project context bundle "${normalizedName}" in ${projectRoot}.`);
    }
    throw new Error(`Unable to read project context bundle "${normalizedName}" at ${path}: ${errorMessage(error)}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(content) as unknown;
  } catch (error) {
    throw new Error(`Context bundle "${normalizedName}" at ${path} is not valid JSON: ${errorMessage(error)}`);
  }

  const bundle = parseContextBundle(raw, `Context bundle "${normalizedName}" at ${path}`);
  if (bundle.name !== normalizedName) {
    throw new Error(`Context bundle file ${path} declares name "${bundle.name}" instead of "${normalizedName}".`);
  }
  return projectContextBundleRecord(bundle, projectRoot, path);
}

export async function listProjectContextBundles(cwd = process.cwd()): Promise<ProjectContextBundle[]> {
  const projectRoot = resolve(cwd);
  const directory = projectContextBundleDirectory(projectRoot);
  let entries: Array<{ isFile(): boolean; name: string }>;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return [];
    throw new Error(`Unable to list project context bundles in ${directory}: ${errorMessage(error)}`);
  }

  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => basename(entry.name, '.json'))
    .sort((left, right) => left.localeCompare(right));
  return Promise.all(names.map((name) => getProjectContextBundle(name, projectRoot)));
}

export async function deleteProjectContextBundle(options: DeleteContextBundleOptions): Promise<ContextBundleMutationResult> {
  const record = await getProjectContextBundle(options.name, options.cwd);
  if (!options.dryRun) {
    try {
      await unlink(record.path);
    } catch (error) {
      throw new Error(`Unable to delete project context bundle "${record.bundle.name}" at ${record.path}: ${errorMessage(error)}`);
    }
  }
  return {
    record,
    dryRun: options.dryRun ?? false,
    status: 'deleted',
  };
}

export async function expandContextBundleInputs(
  inputs: readonly ContextBundleInput[],
  cwd = process.cwd(),
): Promise<ContextBundleExpansion> {
  const refs: ContextRef[] = [];
  const bundles: ContextBundleAudit[] = [];

  for (const input of inputs) {
    if (input.kind === 'ref') {
      refs.push(parseContextRef(input.ref, 'Context ref'));
      continue;
    }

    const record = await getProjectContextBundle(input.name, cwd);
    const expandedRefs = cloneJson(record.bundle.refs);
    refs.push(...expandedRefs);
    bundles.push({
      name: record.bundle.name,
      scope: 'project',
      digest: record.digest,
      expandedRefs,
    });
  }

  return { refs, bundles };
}

export function mergeContextBundleMetadata(
  metadata: Record<string, JsonValue> | undefined,
  bundles: readonly ContextBundleAudit[],
): Record<string, JsonValue> | undefined {
  if (bundles.length === 0) return metadata;
  if (metadata?.contextBundles !== undefined) {
    throw new Error('Request metadata key "contextBundles" is reserved for Agent SDK named context bundle audit data.');
  }
  return {
    ...(metadata ?? {}),
    contextBundles: cloneJson(bundles) as unknown as JsonValue,
  };
}

export function parseContextRefFlag(value: string, flag: string): ContextRef {
  if (value.startsWith('@')) {
    throw new Error(`${flag} shorthand @id is not supported yet; use run:<id> or session:<id>`);
  }
  const separatorIndex = value.indexOf(':');
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    throw new Error(`${flag} must be run:<id> or session:<id>`);
  }

  const kind = value.slice(0, separatorIndex);
  const id = value.slice(separatorIndex + 1).trim();
  if (!id) {
    throw new Error(`${flag} requires a non-empty id`);
  }
  if (kind === 'run') {
    assertRunRefId(id, `${flag} run ref id`);
    return { kind, id };
  }
  if (kind === 'session') return { kind, id };
  throw new Error(`${flag} kind must be run or session`);
}

export function parseContextRef(value: unknown, label: string): ContextRef {
  const raw = expectObject(value, label);
  const kind = expectEnum(raw.kind, `${label}.kind`, ['run', 'session']);
  const id = expectNonEmptyString(raw.id, `${label}.id`);
  const maxBytes = raw.maxBytes === undefined ? undefined : expectPositiveInteger(raw.maxBytes, `${label}.maxBytes`);
  const allowStatuses = raw.allowStatuses === undefined ? undefined : parseRunStatuses(raw.allowStatuses, `${label}.allowStatuses`);

  if (kind === 'run') {
    assertOnlyKeys(raw, label, ['kind', 'id', 'view', 'maxBytes', 'allowStatuses']);
    assertRunRefId(id, `${label}.id`);
    const view = raw.view === undefined ? undefined : expectEnum(raw.view, `${label}.view`, ['result']);
    return {
      kind,
      id,
      ...(view ? { view } : {}),
      ...(maxBytes ? { maxBytes } : {}),
      ...(allowStatuses ? { allowStatuses } : {}),
    };
  }

  assertOnlyKeys(raw, label, [
    'kind',
    'id',
    'view',
    'selection',
    'rootRunsOnly',
    'maxRuns',
    'maxScanRuns',
    'maxBytes',
    'allowStatuses',
  ]);
  const view = raw.view === undefined ? undefined : expectEnum(raw.view, `${label}.view`, ['run_summaries']);
  const selection = raw.selection === undefined ? undefined : expectEnum(raw.selection, `${label}.selection`, ['latest', 'earliest']);
  const rootRunsOnly = raw.rootRunsOnly === undefined ? undefined : expectBoolean(raw.rootRunsOnly, `${label}.rootRunsOnly`);
  const maxRuns = raw.maxRuns === undefined ? undefined : expectPositiveInteger(raw.maxRuns, `${label}.maxRuns`);
  const maxScanRuns = raw.maxScanRuns === undefined ? undefined : expectPositiveInteger(raw.maxScanRuns, `${label}.maxScanRuns`);
  return {
    kind,
    id,
    ...(view ? { view } : {}),
    ...(selection ? { selection } : {}),
    ...(rootRunsOnly === undefined ? {} : { rootRunsOnly }),
    ...(maxRuns ? { maxRuns } : {}),
    ...(maxScanRuns ? { maxScanRuns } : {}),
    ...(maxBytes ? { maxBytes } : {}),
    ...(allowStatuses ? { allowStatuses } : {}),
  };
}

export function parseContextBundle(value: unknown, label = 'Context bundle'): ContextBundle {
  const raw = expectObject(value, label);
  assertOnlyKeys(raw, label, ['schemaVersion', 'name', 'description', 'refs']);
  if (raw.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion must be 1`);
  }
  const name = validateContextBundleName(expectNonEmptyString(raw.name, `${label}.name`));
  const description = raw.description === undefined ? undefined : expectString(raw.description, `${label}.description`);
  if (!Array.isArray(raw.refs) || raw.refs.length === 0) {
    throw new Error(`${label}.refs must be a non-empty array of run or session context refs`);
  }
  return {
    schemaVersion: 1,
    name,
    ...(description === undefined ? {} : { description }),
    refs: raw.refs.map((ref, index) => parseContextRef(ref, `${label}.refs[${index}]`)),
  };
}

export function validateContextBundleName(value: string): string {
  const name = value.trim();
  if (name !== value || !BUNDLE_NAME_PATTERN.test(name)) {
    throw new Error('Context bundle name must start with a letter or number and contain only letters, numbers, dot, underscore, and hyphen.');
  }
  return name;
}

function assertRunRefId(id: string, label: string): void {
  if (!isUuid(id)) {
    throw new Error(`${label} must be a valid UUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)`);
  }
}

function projectContextBundleRecord(bundle: ContextBundle, projectRoot: string, path: string): ProjectContextBundle {
  return {
    bundle: cloneJson(bundle),
    scope: 'project',
    projectRoot,
    path,
    digest: createHash('sha256').update(canonicalJson(bundle as unknown as JsonValue)).digest('hex'),
  };
}

function canonicalJson(value: JsonValue): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function parseRunStatuses(value: unknown, label: string): RunStatus[] {
  if (!Array.isArray(value) || value.some((entry) => !RUN_STATUSES.includes(entry as RunStatus))) {
    throw new Error(`${label} must be an array of RunStatus values`);
  }
  return value as RunStatus[];
}

function expectObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  return value;
}

function expectNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function expectBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
  return value;
}

function expectPositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function expectEnum<const T extends string>(value: unknown, label: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${label} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function assertOnlyKeys(raw: Record<string, unknown>, label: string, allowed: readonly string[]): void {
  const unknown = Object.keys(raw).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains unsupported field${unknown.length === 1 ? '' : 's'}: ${unknown.sort().join(', ')}`);
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === code);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
