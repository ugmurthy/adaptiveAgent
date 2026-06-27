import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ToolContext } from '../types.js';
import { createEditFileTool } from './edit-file.js';

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

function sha256(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

describe('createEditFileTool', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'edit-file-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('has write-like metadata and a strict schema', () => {
    const tool = createEditFileTool();

    expect(tool.name).toBe('edit_file');
    expect(tool.requiresApproval).toBe(true);
    expect(tool.inputSchema).toMatchObject({
      type: 'object',
      required: ['path', 'edits'],
      additionalProperties: false,
    });
  });

  it('applies an exact replace and returns updated metadata', async () => {
    await writeFile(join(tempDir, 'file.txt'), 'hello world');

    const tool = createEditFileTool({ allowedRoot: tempDir });
    const result = (await tool.execute(
      {
        path: 'file.txt',
        expectedSha256: sha256('hello world'),
        edits: [{ type: 'replace', oldText: 'world', newText: 'there' }],
      } as any,
      stubToolContext(),
    )) as any;

    expect(result).toMatchObject({
      path: join(tempDir, 'file.txt'),
      changed: true,
      editCount: 1,
      sizeBytes: Buffer.byteLength('hello there'),
      sha256: sha256('hello there'),
    });
    await expect(readFile(join(tempDir, 'file.txt'), 'utf8')).resolves.toBe('hello there');
  });

  it('applies multiple edits in order to in-memory content and writes once', async () => {
    await writeFile(join(tempDir, 'file.txt'), 'alpha\nbeta\n');

    const tool = createEditFileTool({ allowedRoot: tempDir });
    const result = (await tool.execute(
      {
        path: 'file.txt',
        edits: [
          { type: 'replace', oldText: 'alpha', newText: 'ALPHA' },
          { type: 'insert_after', anchorText: 'ALPHA', text: '!' },
          { type: 'insert_before', anchorText: 'beta', text: 'B:' },
        ],
      } as any,
      stubToolContext(),
    )) as any;

    expect(result.editCount).toBe(3);
    await expect(readFile(join(tempDir, 'file.txt'), 'utf8')).resolves.toBe('ALPHA!\nB:beta\n');
  });

  it('fails match mismatches without writing', async () => {
    await writeFile(join(tempDir, 'file.txt'), 'one two');

    const tool = createEditFileTool({ allowedRoot: tempDir });
    await expect(
      tool.execute(
        {
          path: 'file.txt',
          edits: [{ type: 'replace', oldText: 'missing', newText: 'found' }],
        } as any,
        stubToolContext(),
      ),
    ).rejects.toThrow('expected 1 matches');

    await expect(readFile(join(tempDir, 'file.txt'), 'utf8')).resolves.toBe('one two');
  });

  it('fails expectedSha256 mismatches without writing', async () => {
    await writeFile(join(tempDir, 'file.txt'), 'original');

    const tool = createEditFileTool({ allowedRoot: tempDir });
    await expect(
      tool.execute(
        {
          path: 'file.txt',
          expectedSha256: sha256('different'),
          edits: [{ type: 'replace', oldText: 'original', newText: 'changed' }],
        } as any,
        stubToolContext(),
      ),
    ).rejects.toThrow('expectedSha256 mismatch');

    await expect(readFile(join(tempDir, 'file.txt'), 'utf8')).resolves.toBe('original');
  });

  it('returns recoverable output for paths outside the allowed root', async () => {
    const tool = createEditFileTool({ allowedRoot: tempDir });
    const result = await executeRecoverableTool(tool, {
      path: '/outside.txt',
      edits: [{ type: 'replace', oldText: 'a', newText: 'b' }],
    });

    expect(result).toMatchObject({
      ok: false,
      recoveryKind: 'path_outside_workspace',
      toolName: 'edit_file',
      requestedPath: '/outside.txt',
      suggestedPath: 'outside.txt',
    });
  });

  it('rejects binary files without writing', async () => {
    await writeFile(join(tempDir, 'binary.txt'), new Uint8Array([0x61, 0x00, 0x62]));

    const tool = createEditFileTool({ allowedRoot: tempDir });
    await expect(
      tool.execute(
        {
          path: 'binary.txt',
          edits: [{ type: 'replace', oldText: 'a', newText: 'b' }],
        } as any,
        stubToolContext(),
      ),
    ).rejects.toThrow('rejects binary files');

    expect(await readFile(join(tempDir, 'binary.txt'))).toEqual(Buffer.from([0x61, 0x00, 0x62]));
  });

  it('creates an adjacent backup only after validation succeeds', async () => {
    await writeFile(join(tempDir, 'file.txt'), 'before');

    const tool = createEditFileTool({ allowedRoot: tempDir, createBackup: true });
    const result = (await tool.execute(
      {
        path: 'file.txt',
        edits: [{ type: 'replace', oldText: 'before', newText: 'after' }],
      } as any,
      stubToolContext(),
    )) as any;

    expect(result.backupPath).toMatch(`${join(tempDir, 'file.txt')}.bak-`);
    await expect(readFile(result.backupPath, 'utf8')).resolves.toBe('before');
    await expect(readFile(join(tempDir, 'file.txt'), 'utf8')).resolves.toBe('after');
  });

  it('rejects symbolic links', async () => {
    await mkdir(join(tempDir, 'nested'));
    await writeFile(join(tempDir, 'nested', 'target.txt'), 'target');
    await symlink(join(tempDir, 'nested', 'target.txt'), join(tempDir, 'link.txt'));

    const tool = createEditFileTool({ allowedRoot: tempDir });
    await expect(
      tool.execute(
        {
          path: 'link.txt',
          edits: [{ type: 'replace', oldText: 'target', newText: 'changed' }],
        } as any,
        stubToolContext(),
      ),
    ).rejects.toThrow('refuses to edit symbolic links');

    expect((await lstat(join(tempDir, 'link.txt'))).isSymbolicLink()).toBe(true);
    await expect(readFile(join(tempDir, 'nested', 'target.txt'), 'utf8')).resolves.toBe('target');
  });
});
