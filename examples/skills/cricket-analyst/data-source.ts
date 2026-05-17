/**
 * Data source resolution for the cricket-analyst skill.
 *
 * Resolution order:
 *   1. If `options.dataSource` is provided (test injection), use it directly.
 *   2. If `CRICKET_DATA_BASE_URL` is set in env, fetch JSON from
 *      `<base>/<file>` (no API key required for the curated mirror).
 *   3. Otherwise, read the bundled fixture file under ./fixtures/.
 *
 * Network errors fall back to the fixture so a flaky CI run still produces a
 * deterministic bulletin. The `--no-network` flag (US-013) flips
 * `options.allowNetwork = false` to forbid the HTTP path entirely.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export interface DataSourceOptions {
  /** Test-only injection: pre-loaded JSON keyed by file name. */
  dataSource?: Record<string, unknown>;
  /** When false, only the local fixture is consulted. Default: true. */
  allowNetwork?: boolean;
  /** Override base URL (otherwise read from env). */
  baseUrl?: string;
  /** Override fetch (test injection). */
  fetchImpl?: typeof fetch;
}

const HERE = dirname(fileURLToPath(import.meta.url));

export async function loadDataset<T>(file: string, options: DataSourceOptions = {}): Promise<T> {
  if (options.dataSource && options.dataSource[file] !== undefined) {
    return options.dataSource[file] as T;
  }

  const allowNetwork = options.allowNetwork ?? true;
  const baseUrl = options.baseUrl ?? process.env.CRICKET_DATA_BASE_URL;

  if (allowNetwork && baseUrl) {
    try {
      const fetchImpl = options.fetchImpl ?? fetch;
      const url = `${baseUrl.replace(/\/$/, '')}/${file}`;
      const res = await fetchImpl(url);
      if (res.ok) {
        return (await res.json()) as T;
      }
    } catch {
      // fall through to fixture
    }
  }

  const fixturePath = join(HERE, 'fixtures', file);
  try {
    const raw = await readFile(fixturePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch (err) {
    if (allowNetwork === false || options.allowNetwork === false) {
      throw new Error(
        `cricket-analyst: --no-network mode requires fixture "${file}" at ${fixturePath}, but it was not found. ` +
          `Either remove --no-network, supply options.dataSource, or add the fixture file. ` +
          `(underlying: ${(err as Error).message})`,
      );
    }
    throw err;
  }
}
