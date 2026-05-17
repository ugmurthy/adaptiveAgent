/**
 * TTL-based filesystem cache for cricket-analyst data fetches.
 *
 * Cache files live at `<cacheRoot>/<action>-<keyHash>.json`. Default cacheRoot
 * is `<repoRoot>/.cache/cricket-analyst/`. Each action has its own TTL so
 * fast-moving data (points table) refreshes more often than slow-moving data
 * (player form). The cache is intentionally simple — JSON files keyed by a
 * short hash, no manifest, no eviction beyond TTL expiry.
 */

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export type ActionName = 'points_table' | 'fixtures' | 'player_form';

export const DEFAULT_TTL_MS: Record<ActionName, number> = {
  points_table: 30 * 60 * 1000,        // 30 min
  fixtures: 6 * 60 * 60 * 1000,        // 6 h
  player_form: 24 * 60 * 60 * 1000,    // 24 h
};

export interface CacheOptions {
  /** Cache root directory. Default: `<repoRoot>/.cache/cricket-analyst/`. */
  cacheRoot?: string;
  /** Per-action TTL override (ms). */
  ttlMs?: Partial<Record<ActionName, number>>;
  /** Override clock for tests. */
  now?: () => number;
  /** When false, the cache is bypassed entirely. Default: true. */
  enabled?: boolean;
}

const DEFAULT_CACHE_ROOT = resolve(
  fileURLToPath(import.meta.url),
  '..',
  '..',
  '..',
  '..',
  '.cache',
  'cricket-analyst',
);

export function resolveCacheRoot(options: CacheOptions = {}): string {
  return options.cacheRoot ?? DEFAULT_CACHE_ROOT;
}

export function cacheKey(action: ActionName, params: Record<string, unknown>): string {
  const stable = JSON.stringify(params, Object.keys(params).sort());
  const hash = createHash('sha256').update(stable).digest('hex').slice(0, 12);
  return `${action}-${hash}`;
}

export function cachePath(
  action: ActionName,
  params: Record<string, unknown>,
  options: CacheOptions = {},
): string {
  const root = resolveCacheRoot(options);
  return join(root, `${cacheKey(action, params)}.json`);
}

/**
 * Read a fresh entry from the cache, or undefined if missing/expired/disabled.
 */
export async function readCache<T>(
  action: ActionName,
  params: Record<string, unknown>,
  options: CacheOptions = {},
): Promise<T | undefined> {
  if (options.enabled === false) return undefined;

  const path = cachePath(action, params, options);
  const ttl = options.ttlMs?.[action] ?? DEFAULT_TTL_MS[action];
  const now = options.now?.() ?? Date.now();

  try {
    const stats = await stat(path);
    if (now - stats.mtimeMs > ttl) return undefined;
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/**
 * Write an entry to the cache. Failures are swallowed — caching is best-effort.
 */
export async function writeCache<T>(
  action: ActionName,
  params: Record<string, unknown>,
  value: T,
  options: CacheOptions = {},
): Promise<void> {
  if (options.enabled === false) return;
  const path = cachePath(action, params, options);
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(value, null, 2), 'utf-8');
  } catch {
    // best-effort
  }
}

/**
 * Wrap a fetcher in TTL-cached read/write.
 */
export async function withCache<T>(
  action: ActionName,
  params: Record<string, unknown>,
  options: CacheOptions,
  fetcher: () => Promise<T>,
): Promise<T> {
  const cached = await readCache<T>(action, params, options);
  if (cached !== undefined) return cached;
  const fresh = await fetcher();
  await writeCache(action, params, fresh, options);
  return fresh;
}
