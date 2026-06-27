import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ToolContext } from '../types.js';
import { createSearchFilesTool } from './search-files.js';

function stubToolContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    runId: 'run-1',
    rootRunId: 'run-1',
    delegationDepth: 0,
    stepId: 'step-1',
    toolCallId: 'call-1',
    idempotencyKey: 'run-1:step-1:call-1',
    signal: new AbortController().signal,
    emit: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

async function executeRecoverableTool(
  tool: {
    execute: (input: any, context: ToolContext) => Promise<unknown>;
    recoverError?: (error: unknown, input: unknown) => unknown;
  },
  input: unknown,
) {
  try {
    return await tool.execute(input as any, stubToolContext());
  } catch (error) {
    return tool.recoverError?.(error, input);
  }
}

describe('createSearchFilesTool', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'search-files-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('has read-only metadata and a strict schema', () => {
    const tool = createSearchFilesTool();

    expect(tool.name).toBe('search_files');
    expect(tool.requiresApproval).toBeUndefined();
    expect(tool.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string' },
        filename: { type: 'string' },
        mode: { enum: ['literal', 'regex'] },
      },
    });
  });

  it('searches file content and returns workspace-relative matches with context', async () => {
    await mkdir(join(tempDir, 'src'));
    await writeFile(join(tempDir, 'src', 'app.ts'), 'first line\nNeedle line\nlast line');
    await writeFile(join(tempDir, 'src', 'other.ts'), 'no match here');

    const tool = createSearchFilesTool({ allowedRoot: tempDir });
    const result = (await tool.execute(
      { path: 'src', query: 'needle', contextLines: 1 } as any,
      stubToolContext(),
    )) as any;

    expect(result.path).toBe('src');
    expect(result.matches).toEqual([
      {
        matchKind: 'content',
        path: 'src/app.ts',
        lineNumber: 2,
        lineText: 'Needle line',
        before: ['first line'],
        after: ['last line'],
      },
    ]);
    expect(result.filesSearched).toBe(2);
    expect(result.filesMatched).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it('searches filenames and skips binary and oversized files', async () => {
    await writeFile(join(tempDir, 'match-small.txt'), 'ok');
    await writeFile(join(tempDir, 'match-large.txt'), 'large');
    await writeFile(join(tempDir, 'match-binary.txt'), new Uint8Array([0x61, 0x00, 0x62]));

    const tool = createSearchFilesTool({ allowedRoot: tempDir, maxFileSizeBytes: 4 });
    const result = (await tool.execute({ filename: 'match' } as any, stubToolContext())) as any;

    expect(result.matches).toEqual([{ matchKind: 'filename', path: 'match-small.txt' }]);
    expect(result.skipped).toMatchObject({ largeFiles: 1, binaryFiles: 1 });
    expect(result.filesSkipped).toBe(2);
  });

  it('returns recoverable output for paths outside the allowed root', async () => {
    const tool = createSearchFilesTool({ allowedRoot: tempDir });
    const result = await executeRecoverableTool(tool, { path: '/outside.txt', query: 'needle' });

    expect(result).toMatchObject({
      ok: false,
      recoveryKind: 'path_outside_workspace',
      toolName: 'search_files',
      requestedPath: '/outside.txt',
      suggestedPath: 'outside.txt',
    });
  });

  it('truncates at maxMatches without pagination', async () => {
    await writeFile(join(tempDir, 'many.txt'), 'needle 1\nneedle 2\nneedle 3');

    const tool = createSearchFilesTool({ allowedRoot: tempDir });
    const result = (await tool.execute(
      { query: 'needle', maxMatches: 2 } as any,
      stubToolContext(),
    )) as any;

    expect(result.matches).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.truncationReasons).toContain('max_matches');
    expect(result.nextCursor).toBeUndefined();
  });

  it('distinguishes literal and regex content matching', async () => {
    await writeFile(join(tempDir, 'regex.txt'), 'a+b\nab\n');
    const tool = createSearchFilesTool({ allowedRoot: tempDir });

    const literal = (await tool.execute(
      { path: 'regex.txt', query: 'a+b', mode: 'literal' } as any,
      stubToolContext(),
    )) as any;
    const regex = (await tool.execute(
      { path: 'regex.txt', query: 'a+b', mode: 'regex' } as any,
      stubToolContext(),
    )) as any;

    expect(literal.matches.map((match: any) => match.lineNumber)).toEqual([1]);
    expect(regex.matches.map((match: any) => match.lineNumber)).toEqual([2]);
  });

  it('applies include and exclude globs with exclude winning', async () => {
    await mkdir(join(tempDir, 'src'));
    await writeFile(join(tempDir, 'src', 'keep.ts'), 'needle');
    await writeFile(join(tempDir, 'src', 'skip.ts'), 'needle');
    await writeFile(join(tempDir, 'src', 'note.md'), 'needle');

    const tool = createSearchFilesTool({ allowedRoot: tempDir });
    const result = (await tool.execute(
      {
        query: 'needle',
        includeGlobs: ['src/**/*.ts'],
        excludeGlobs: ['src/skip.ts'],
      } as any,
      stubToolContext(),
    )) as any;

    expect(result.matches.map((match: any) => match.path)).toEqual(['src/keep.ts']);
  });

  it('skips default heavy directories unless explicitly included', async () => {
    await mkdir(join(tempDir, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(tempDir, 'node_modules', 'pkg', 'index.js'), 'needle');

    const tool = createSearchFilesTool({ allowedRoot: tempDir });
    const defaultResult = (await tool.execute({ query: 'needle' } as any, stubToolContext())) as any;
    const includedResult = (await tool.execute(
      { query: 'needle', includeGlobs: ['node_modules/**'] } as any,
      stubToolContext(),
    )) as any;

    expect(defaultResult.matches).toEqual([]);
    expect(includedResult.matches.map((match: any) => match.path)).toEqual(['node_modules/pkg/index.js']);
  });

  it('rejects invalid regular expressions clearly', async () => {
    await writeFile(join(tempDir, 'file.txt'), 'text');
    const tool = createSearchFilesTool({ allowedRoot: tempDir });

    await expect(
      tool.execute({ query: '[' , mode: 'regex' } as any, stubToolContext()),
    ).rejects.toThrow('Invalid search_files query regex');
  });
});
