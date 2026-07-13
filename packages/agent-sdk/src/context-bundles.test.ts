import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createProjectContextBundle,
  deleteProjectContextBundle,
  expandContextBundleInputs,
  getProjectContextBundle,
  listProjectContextBundles,
  mergeContextBundleMetadata,
  projectContextBundleDirectory,
} from './context-bundles.js';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_RUN_ID = '22222222-2222-4222-8222-222222222222';
const BUNDLE_RUN_ID = '33333333-3333-4333-8333-333333333333';
const BEFORE_RUN_ID = '44444444-4444-4444-8444-444444444444';
const AFTER_RUN_ID = '55555555-5555-4555-8555-555555555555';
const REPLACEMENT_RUN_ID = '66666666-6666-4666-8666-666666666666';

describe('project context bundles', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'context-bundles-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('creates, lists, shows, overwrites, and deletes project-scoped bundles', async () => {
    const created = await createProjectContextBundle({
      cwd: tempDir,
      name: 'migration-research',
      description: 'Curated migration evidence.',
      refs: [
        { kind: 'run', id: RUN_ID },
        { kind: 'session', id: 'session-456', selection: 'earliest', maxRuns: 3 },
      ],
    });

    expect(created.status).toBe('created');
    expect(created.record.path).toBe(join(tempDir, '.adaptiveAgent', 'context-bundles', 'migration-research.json'));
    expect(created.record.digest).toMatch(/^[a-f0-9]{64}$/);
    await expect(listProjectContextBundles(tempDir)).resolves.toMatchObject([
      { bundle: { name: 'migration-research', refs: [{ id: RUN_ID }, { id: 'session-456' }] } },
    ]);

    const stored = JSON.parse(await readFile(created.record.path, 'utf-8')) as Record<string, unknown>;
    expect(stored).toEqual({
      schemaVersion: 1,
      name: 'migration-research',
      description: 'Curated migration evidence.',
      refs: [
        { kind: 'run', id: RUN_ID },
        { kind: 'session', id: 'session-456', selection: 'earliest', maxRuns: 3 },
      ],
    });

    await expect(createProjectContextBundle({
      cwd: tempDir,
      name: 'migration-research',
      refs: [{ kind: 'run', id: OTHER_RUN_ID }],
    })).rejects.toThrow('use --force');

    const overwritten = await createProjectContextBundle({
      cwd: tempDir,
      name: 'migration-research',
      refs: [{ kind: 'run', id: OTHER_RUN_ID }],
      force: true,
    });
    expect(overwritten.status).toBe('overwritten');
    expect(overwritten.record.digest).not.toBe(created.record.digest);

    await deleteProjectContextBundle({ cwd: tempDir, name: 'migration-research', dryRun: true });
    await expect(getProjectContextBundle('migration-research', tempDir)).resolves.toMatchObject({
      bundle: { refs: [{ id: OTHER_RUN_ID }] },
    });
    await deleteProjectContextBundle({ cwd: tempDir, name: 'migration-research' });
    await expect(getProjectContextBundle('migration-research', tempDir)).rejects.toThrow('Unknown project context bundle');
  });

  it('expands bundles in input order and preserves immutable audit data', async () => {
    await createProjectContextBundle({
      cwd: tempDir,
      name: 'evidence',
      description: 'Display only; never model-visible.',
      refs: [
        { kind: 'run', id: BUNDLE_RUN_ID },
        { kind: 'session', id: 'session-bundle' },
      ],
    });

    const expansion = await expandContextBundleInputs([
      { kind: 'ref', ref: { kind: 'run', id: BEFORE_RUN_ID } },
      { kind: 'bundle', name: 'evidence' },
      { kind: 'ref', ref: { kind: 'run', id: AFTER_RUN_ID } },
    ], tempDir);

    expect(expansion.refs).toEqual([
      { kind: 'run', id: BEFORE_RUN_ID },
      { kind: 'run', id: BUNDLE_RUN_ID },
      { kind: 'session', id: 'session-bundle' },
      { kind: 'run', id: AFTER_RUN_ID },
    ]);
    expect(expansion.bundles).toEqual([{
      name: 'evidence',
      scope: 'project',
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      expandedRefs: [
        { kind: 'run', id: BUNDLE_RUN_ID },
        { kind: 'session', id: 'session-bundle' },
      ],
    }]);

    const metadata = mergeContextBundleMetadata({ caller: 'test' }, expansion.bundles);
    expect(metadata).toEqual({ caller: 'test', contextBundles: expansion.bundles });
    expect(JSON.stringify(metadata)).not.toContain('Display only');

    await createProjectContextBundle({
      cwd: tempDir,
      name: 'evidence',
      refs: [{ kind: 'run', id: REPLACEMENT_RUN_ID }],
      force: true,
    });
    expect(expansion.bundles[0]?.expandedRefs).toEqual([
      { kind: 'run', id: BUNDLE_RUN_ID },
      { kind: 'session', id: 'session-bundle' },
    ]);
    const nextExpansion = await expandContextBundleInputs([{ kind: 'bundle', name: 'evidence' }], tempDir);
    expect(nextExpansion.bundles[0]?.digest).not.toBe(expansion.bundles[0]?.digest);
    expect(nextExpansion.refs).toEqual([{ kind: 'run', id: REPLACEMENT_RUN_ID }]);
  });

  it('uses canonical content digests independent of JSON object key order', async () => {
    const created = await createProjectContextBundle({
      cwd: tempDir,
      name: 'canonical',
      description: 'Same content.',
      refs: [{ kind: 'session', id: 'session-1', maxRuns: 2, selection: 'latest' }],
    });
    await writeFile(created.record.path, JSON.stringify({
      refs: [{ selection: 'latest', maxRuns: 2, id: 'session-1', kind: 'session' }],
      description: 'Same content.',
      name: 'canonical',
      schemaVersion: 1,
    }));

    const reordered = await getProjectContextBundle('canonical', tempDir);
    expect(reordered.digest).toBe(created.record.digest);
  });

  it('rejects unknown, empty, nested, and malformed bundles before expansion', async () => {
    await expect(createProjectContextBundle({ cwd: tempDir, name: 'empty', refs: [] })).rejects.toThrow('non-empty array');
    await expect(createProjectContextBundle({ cwd: tempDir, name: '../outside', refs: [{ kind: 'run', id: RUN_ID }] })).rejects.toThrow('Context bundle name');
    await expect(createProjectContextBundle({
      cwd: tempDir,
      name: 'malformed-run-id',
      refs: [{ kind: 'run', id: 'c453e5947-6e7e-4cde-a488-cb133288e29c' }],
    })).rejects.toThrow('must be a valid UUID');
    await expect(expandContextBundleInputs([{ kind: 'bundle', name: 'missing' }], tempDir)).rejects.toThrow('Unknown project context bundle');

    const directory = projectContextBundleDirectory(tempDir);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'nested.json'), JSON.stringify({
      schemaVersion: 1,
      name: 'nested',
      refs: [{ kind: 'bundle', id: 'other' }],
    }));
    await expect(getProjectContextBundle('nested', tempDir)).rejects.toThrow('.kind must be one of: run, session');

    await writeFile(join(directory, 'invalid.json'), JSON.stringify({
      schemaVersion: 1,
      name: 'invalid',
      refs: [{ kind: 'run', id: RUN_ID, selection: 'latest' }],
    }));
    await expect(getProjectContextBundle('invalid', tempDir)).rejects.toThrow('unsupported field: selection');
    expect(() => mergeContextBundleMetadata({ contextBundles: [] }, [{
      name: 'reserved',
      scope: 'project',
      digest: 'digest',
      expandedRefs: [{ kind: 'run', id: RUN_ID }],
    }])).toThrow('reserved');
  });
});
