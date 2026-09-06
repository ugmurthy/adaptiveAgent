import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ToolContext, ToolDefinition } from '../types.js';
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
  tool: Pick<ToolDefinition<any, any>, 'execute' | 'recoverError'>,
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
    expect(JSON.stringify(tool.inputSchema)).toContain('"type":"integer","minimum":0');
    expect(JSON.stringify(tool.inputSchema)).toContain('"minLength":1');
    expect(JSON.stringify(tool.inputSchema)).toContain('"pattern":"^[a-f0-9]{64}$"');
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

  it('infers replace for an unambiguous oldText/newText edit', async () => {
    await writeFile(join(tempDir, 'compiler.py'), 'def compile():\n    return False\n');

    const tool = createEditFileTool({ allowedRoot: tempDir });
    await tool.execute(
      {
        path: 'compiler.py',
        edits: [{ oldText: 'return False', newText: 'return True' }],
      } as any,
      stubToolContext(),
    );

    await expect(readFile(join(tempDir, 'compiler.py'), 'utf8')).resolves.toBe(
      'def compile():\n    return True\n',
    );
  });

  it('reports the supported operation types for an unknown type', async () => {
    await writeFile(join(tempDir, 'file.ts'), 'const enabled = false;\n');

    const tool = createEditFileTool({ allowedRoot: tempDir });
    await expect(
      tool.execute(
        {
          path: 'file.ts',
          edits: [{ type: 'update', oldText: 'false', newText: 'true' }],
        } as any,
        stubToolContext(),
      ),
    ).rejects.toThrow('supported types are "replace", "insert_after", and "insert_before"');
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

  it('returns a recoverable no-match conflict with current-state guidance and does not write', async () => {
    await writeFile(join(tempDir, 'file.txt'), 'one found');

    const tool = createEditFileTool({ allowedRoot: tempDir });
    const result = await executeRecoverableTool(tool, {
      path: 'file.txt',
      edits: [{ type: 'replace', oldText: 'missing', newText: 'found' }],
    });

    expect(result).toMatchObject({
      ok: false,
      recoveryKind: 'edit_conflict',
      conflictKind: 'no_match',
      toolName: 'edit_file',
      path: join(tempDir, 'file.txt'),
      editIndex: 0,
      operation: 'replace',
      targetText: 'missing',
      expectedMatches: 1,
      actualMatches: 0,
      fileSha256: sha256('one found'),
      fileChanged: false,
      replacementAlreadyPresent: true,
      message: 'edit_file replace edit 0 expected 1 match for oldText but found 0',
      correctiveAction: expect.stringContaining('Read the current file'),
    });
    await expect(readFile(join(tempDir, 'file.txt'), 'utf8')).resolves.toBe('one found');
  });

  it('returns candidate locations for an ambiguous match and does not guess', async () => {
    await writeFile(join(tempDir, 'file.txt'), 'target first\nother\ntarget second\n');

    const tool = createEditFileTool({ allowedRoot: tempDir });
    const result = await executeRecoverableTool(tool, {
      path: 'file.txt',
      edits: [{ type: 'replace', oldText: 'target', newText: 'changed' }],
    });

    expect(result).toMatchObject({
      ok: false,
      recoveryKind: 'edit_conflict',
      conflictKind: 'ambiguous_match',
      expectedMatches: 1,
      actualMatches: 2,
      fileChanged: false,
      candidateLocations: [
        { line: 1, column: 1, excerpt: 'target first' },
        { line: 3, column: 1, excerpt: 'target second' },
      ],
      correctiveAction: expect.stringContaining('surrounding unchanged text'),
    });
    await expect(readFile(join(tempDir, 'file.txt'), 'utf8')).resolves.toBe(
      'target first\nother\ntarget second\n',
    );
  });

  it('reports likely CRLF/LF mismatch without applying a fuzzy edit', async () => {
    await writeFile(join(tempDir, 'file.txt'), 'alpha\r\nbeta\r\n');

    const tool = createEditFileTool({ allowedRoot: tempDir });
    const result = await executeRecoverableTool(tool, {
      path: 'file.txt',
      edits: [{ type: 'replace', oldText: 'alpha\nbeta', newText: 'changed' }],
    });

    expect(result).toMatchObject({
      recoveryKind: 'edit_conflict',
      conflictKind: 'no_match',
      actualMatches: 0,
      normalizedLineEndingMatches: 1,
      fileChanged: false,
      correctiveAction: expect.stringContaining('CRLF/LF'),
    });
    await expect(readFile(join(tempDir, 'file.txt'), 'utf8')).resolves.toBe('alpha\r\nbeta\r\n');
  });

  it('keeps a multi-edit request atomic when a later edit conflicts', async () => {
    await writeFile(join(tempDir, 'file.txt'), 'alpha\nbeta\n');

    const tool = createEditFileTool({ allowedRoot: tempDir });
    const result = await executeRecoverableTool(tool, {
      path: 'file.txt',
      edits: [
        { type: 'replace', oldText: 'alpha', newText: 'ALPHA' },
        { type: 'replace', oldText: 'missing', newText: 'changed' },
      ],
    });

    expect(result).toMatchObject({
      recoveryKind: 'edit_conflict',
      editIndex: 1,
      fileChanged: false,
    });
    await expect(readFile(join(tempDir, 'file.txt'), 'utf8')).resolves.toBe('alpha\nbeta\n');
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

  it('returns recoverable current-state metadata for expectedSha256 mismatches', async () => {
    await writeFile(join(tempDir, 'file.txt'), 'current');

    const tool = createEditFileTool({ allowedRoot: tempDir });
    const result = await executeRecoverableTool(tool, {
      path: 'file.txt',
      expectedSha256: sha256('stale'),
      edits: [{ type: 'replace', oldText: 'current', newText: 'changed' }],
    });

    expect(result).toMatchObject({
      ok: false,
      recoveryKind: 'stale_file',
      toolName: 'edit_file',
      path: join(tempDir, 'file.txt'),
      expectedSha256: sha256('stale'),
      actualSha256: sha256('current'),
      correctiveAction: expect.stringContaining('Read the current file'),
    });
    await expect(readFile(join(tempDir, 'file.txt'), 'utf8')).resolves.toBe('current');
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

  it('returns recoverable output when the file does not exist', async () => {
    const tool = createEditFileTool({ allowedRoot: tempDir });
    const result = await executeRecoverableTool(tool, {
      path: 'missing.txt',
      edits: [{ type: 'replace', oldText: 'a', newText: 'b' }],
    });

    expect(result).toMatchObject({
      ok: false,
      recoveryKind: 'file_not_found',
      toolName: 'edit_file',
      path: join(tempDir, 'missing.txt'),
      fileChanged: false,
      correctiveAction: expect.stringContaining('list the containing directory'),
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

  it('returns recoverable output for unsupported binary files', async () => {
    await writeFile(join(tempDir, 'binary.txt'), new Uint8Array([0x61, 0x00, 0x62]));

    const tool = createEditFileTool({ allowedRoot: tempDir });
    const result = await executeRecoverableTool(tool, {
      path: 'binary.txt',
      edits: [{ type: 'replace', oldText: 'a', newText: 'b' }],
    });

    expect(result).toMatchObject({
      ok: false,
      recoveryKind: 'unsupported_text_file',
      path: join(tempDir, 'binary.txt'),
      fileChanged: false,
      correctiveAction: expect.stringContaining('binary files'),
    });
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

  it('does not recover unexpected operational failures', () => {
    const tool = createEditFileTool({ allowedRoot: tempDir });

    expect(tool.recoverError?.(new Error('permission denied'), {
      path: 'file.txt',
      edits: [{ type: 'replace', oldText: 'a', newText: 'b' }],
    })).toBeUndefined();
  });
});
