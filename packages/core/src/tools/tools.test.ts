import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { ToolContext } from '../types.js';
import { createReadFileTool } from './read-file.js';
import { createListDirectoryTool } from './list-directory.js';
import { createWriteFileTool } from './write-file.js';
import { createShellExecTool } from './shell-exec.js';
import { createWebSearchTool } from './web-search.js';
import { createReadWebPageTool } from './read-web-page.js';

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

async function executeRecoverableTool(tool: { execute: (input: any, context: ToolContext) => Promise<unknown>; recoverError?: (error: unknown, input: unknown) => unknown }, input: unknown) {
  try {
    return await tool.execute(input as any, stubToolContext());
  } catch (error) {
    return tool.recoverError?.(error, input);
  }
}

// ── read_file ───────────────────────────────────────────────────────────────

describe('createReadFileTool', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'read-file-test-'));
    await writeFile(join(tempDir, 'hello.txt'), 'Hello world');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('reads a file and returns content and size', async () => {
    const tool = createReadFileTool({ allowedRoot: tempDir });
    const result = (await tool.execute({ path: 'hello.txt' } as any, stubToolContext())) as any;

    expect(result.content).toBe('Hello world');
    expect(result.sizeBytes).toBe(11);
    expect(result.path).toBe(join(tempDir, 'hello.txt'));
  });

  it('reads a file using absolute path', async () => {
    const tool = createReadFileTool({ allowedRoot: tempDir });
    const absPath = join(tempDir, 'hello.txt');
    const result = (await tool.execute({ path: absPath } as any, stubToolContext())) as any;

    expect(result.content).toBe('Hello world');
  });

  it('rejects paths outside the allowed root', async () => {
    const tool = createReadFileTool({ allowedRoot: tempDir });

    await expect(
      tool.execute({ path: '../../../etc/passwd' } as any, stubToolContext()),
    ).rejects.toThrow('outside the allowed root');
  });

  it('rejects sibling absolute paths that merely share the root prefix', async () => {
    const tool = createReadFileTool({ allowedRoot: tempDir });
    const siblingDir = `${tempDir}-sibling`;
    await mkdir(siblingDir);
    const siblingFile = join(siblingDir, 'escape.txt');
    await writeFile(siblingFile, 'escape');

    await expect(tool.execute({ path: siblingFile } as any, stubToolContext())).rejects.toThrow(
      'outside the allowed root',
    );
  });

  it('rejects files exceeding max size', async () => {
    const tool = createReadFileTool({ allowedRoot: tempDir, maxSizeBytes: 5 });

    await expect(
      tool.execute({ path: 'hello.txt' } as any, stubToolContext()),
    ).rejects.toThrow('exceeds maximum size');
  });

  it('throws when file does not exist', async () => {
    const tool = createReadFileTool({ allowedRoot: tempDir });

    await expect(
      tool.execute({ path: 'nope.txt' } as any, stubToolContext()),
    ).rejects.toThrow();
  });

  it('has correct tool metadata', () => {
    const tool = createReadFileTool();
    expect(tool.name).toBe('read_file');
    expect(tool.requiresApproval).toBeUndefined();
    expect(tool.retryPolicy).toMatchObject({
      retryable: true,
      retryOn: expect.arrayContaining(['not_found']),
    });
  });
});

// ── list_directory ──────────────────────────────────────────────────────────

describe('createListDirectoryTool', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'list-dir-test-'));
    await writeFile(join(tempDir, 'file-a.txt'), 'A');
    await writeFile(join(tempDir, 'file-b.md'), 'B');
    await mkdir(join(tempDir, 'subdir'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('lists directory entries with types', async () => {
    const tool = createListDirectoryTool({ allowedRoot: tempDir });
    const result = (await tool.execute({ path: '.' } as any, stubToolContext())) as any;

    expect(result.path).toBe(tempDir);
    expect(result.entries).toHaveLength(3);

    const names = result.entries.map((e: any) => e.name).sort();
    expect(names).toEqual(['file-a.txt', 'file-b.md', 'subdir']);

    const subdirEntry = result.entries.find((e: any) => e.name === 'subdir');
    expect(subdirEntry.type).toBe('directory');

    const fileEntry = result.entries.find((e: any) => e.name === 'file-a.txt');
    expect(fileEntry.type).toBe('file');
  });

  it('rejects paths outside the allowed root', async () => {
    const tool = createListDirectoryTool({ allowedRoot: tempDir });

    await expect(
      tool.execute({ path: '../../../' } as any, stubToolContext()),
    ).rejects.toThrow('outside the allowed root');
  });

  it('rejects sibling absolute directories that merely share the root prefix', async () => {
    const tool = createListDirectoryTool({ allowedRoot: tempDir });
    const siblingDir = `${tempDir}-sibling`;
    await mkdir(siblingDir);

    await expect(tool.execute({ path: siblingDir } as any, stubToolContext())).rejects.toThrow(
      'outside the allowed root',
    );
  });

  it('has correct tool metadata', () => {
    const tool = createListDirectoryTool();
    expect(tool.name).toBe('list_directory');
    expect(tool.requiresApproval).toBeUndefined();
    expect(tool.retryPolicy).toMatchObject({
      retryable: true,
      retryOn: expect.arrayContaining(['not_found']),
    });
  });
});

// ── write_file ──────────────────────────────────────────────────────────────

describe('createWriteFileTool', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'write-file-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('writes a file and returns path and size', async () => {
    const tool = createWriteFileTool({ allowedRoot: tempDir });
    const result = (await tool.execute(
      { path: 'output.txt', content: 'written content' } as any,
      stubToolContext(),
    )) as any;

    expect(result.path).toBe(join(tempDir, 'output.txt'));
    expect(result.sizeBytes).toBe(15);

    const actual = await readFile(join(tempDir, 'output.txt'), 'utf-8');
    expect(actual).toBe('written content');
  });

  it('creates parent directories by default', async () => {
    const tool = createWriteFileTool({ allowedRoot: tempDir });
    const result = (await tool.execute(
      { path: 'nested/deep/file.txt', content: 'deep' } as any,
      stubToolContext(),
    )) as any;

    expect(result.path).toBe(join(tempDir, 'nested', 'deep', 'file.txt'));
    const actual = await readFile(join(tempDir, 'nested', 'deep', 'file.txt'), 'utf-8');
    expect(actual).toBe('deep');
  });

  it('rejects paths outside the allowed root', async () => {
    const tool = createWriteFileTool({ allowedRoot: tempDir });

    await expect(
      tool.execute({ path: '../../../tmp/evil.txt', content: 'no' } as any, stubToolContext()),
    ).rejects.toThrow('outside the allowed root');
  });

  it('rejects sibling absolute paths that merely share the root prefix', async () => {
    const tool = createWriteFileTool({ allowedRoot: tempDir });
    const siblingPath = join(`${tempDir}-sibling`, 'evil.txt');

    await expect(tool.execute({ path: siblingPath, content: 'no' } as any, stubToolContext())).rejects.toThrow(
      'outside the allowed root',
    );
  });

  it('reports malformed JSON input clearly', async () => {
    const tool = createWriteFileTool({ allowedRoot: tempDir });

    await expect(tool.execute('{"path":"bad.txt","content":"unterminated' as any, stubToolContext())).rejects.toThrow(
      'write_file expects a JSON object',
    );
  });

  it('has requiresApproval set', () => {
    const tool = createWriteFileTool();
    expect(tool.name).toBe('write_file');
    expect(tool.requiresApproval).toBe(true);
  });
});


// ── shell_exec ──────────────────────────────────────────────────────────────

describe('createShellExecTool', () => {
  it('executes a command and returns stdout', async () => {
    const tool = createShellExecTool();
    const result = (await tool.execute(
      { command: 'echo "hello from shell"' } as any,
      stubToolContext(),
    )) as any;

    expect(result.stdout.trim()).toBe('hello from shell');
    expect(result.exitCode).toBe(0);
  });

  it('captures stderr', async () => {
    const tool = createShellExecTool();
    const result = (await tool.execute(
      { command: 'echo "err" >&2' } as any,
      stubToolContext(),
    )) as any;

    expect(result.stderr.trim()).toBe('err');
  });

  it('reports non-zero exit code', async () => {
    const tool = createShellExecTool();
    const result = (await tool.execute(
      { command: 'exit 42' } as any,
      stubToolContext(),
    )) as any;

    expect(result.exitCode).toBe(42);
  });

  it('normalizes shell spawn failures to a numeric exit code', async () => {
    const tool = createShellExecTool({ shell: '/definitely/missing/sh' });
    const result = (await tool.execute(
      { command: 'echo "hello from shell"' } as any,
      stubToolContext(),
    )) as any;

    expect(typeof result.exitCode).toBe('number');
    expect(result.exitCode).toBeGreaterThan(0);
  });

  it('has requiresApproval set', () => {
    const tool = createShellExecTool();
    expect(tool.name).toBe('shell_exec');
    expect(tool.requiresApproval).toBe(true);
  });
});

// ── web_search ──────────────────────────────────────────────────────────────

describe('createWebSearchTool', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends a Brave Search request and parses results', async () => {
    const tool = createWebSearchTool({ apiKey: 'brave-key' });
    expect(tool.budgetGroup).toBe('web_research.search');

    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          web: {
            results: [
              { title: 'Result 1', url: 'https://example.com/1', description: 'First result' },
              { title: 'Result 2', url: 'https://example.com/2', description: 'Second result' },
            ],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = (await tool.execute(
      { query: 'test query' } as any,
      stubToolContext(),
    )) as any;

    expect(result.query).toBe('test query');
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({
      title: 'Result 1',
      url: 'https://example.com/1',
      snippet: 'First result',
    });
    expect(tool.summarizeResult?.(result)).toMatchObject({
      provider: 'brave',
      providerPath: 'api',
      resultCount: 2,
    });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toContain('web/search');
    expect(url).toContain('q=test+query');
    expect(init.headers['X-Subscription-Token']).toBe('brave-key');
  });

  it('sends a DuckDuckGo request and parses lite results', async () => {
    const tool = createWebSearchTool({ provider: 'duckduckgo' });

    fetchSpy.mockResolvedValueOnce(
      new Response(
        "<script>DDG.deep.initialize('/d.js?q=test%20query&vqd=123', false);</script>",
        { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
      ),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(
        "if (DDG.pageLayout) DDG.pageLayout.load('d',[{\"a\":\"First <b>result</b>\",\"t\":\"Result 1\",\"u\":\"https://example.com/1\"},{\"a\":\"Second result\",\"t\":\"Result 2\",\"u\":\"https://example.com/2\"}]);DDG.duckbar.load('images', {});",
        { status: 200, headers: { 'Content-Type': 'application/javascript; charset=utf-8' } },
      ),
    );

    const result = (await tool.execute(
      { query: 'test query' } as any,
      stubToolContext(),
    )) as any;

    expect(result.query).toBe('test query');
    expect(result.results).toEqual([
      {
        title: 'Result 1',
        url: 'https://example.com/1',
        snippet: 'First result',
      },
      {
        title: 'Result 2',
        url: 'https://example.com/2',
        snippet: 'Second result',
      },
    ]);
    expect(tool.summarizeResult?.(result)).toMatchObject({
      provider: 'duckduckgo',
      providerPath: 'deep',
      resultCount: 2,
    });
    expect(JSON.stringify(result)).not.toContain('providerPath');

    const [pageUrl, pageInit] = fetchSpy.mock.calls[0];
    const [deepUrl, deepInit] = fetchSpy.mock.calls[1];
    expect(pageUrl).toContain('duckduckgo.com/');
    expect(pageUrl).toContain('q=test+query');
    expect(pageUrl).toContain('ia=web');
    expect(pageInit.headers['X-Subscription-Token']).toBeUndefined();
    expect(deepUrl).toBe('https://duckduckgo.com/d.js?q=test%20query&vqd=123');
    expect(deepInit.headers.Referer).toContain('duckduckgo.com/');
  });

  it('falls back to DuckDuckGo HTML results when the deep payload is unavailable', async () => {
    const tool = createWebSearchTool({ provider: 'duckduckgo' });

    fetchSpy.mockResolvedValueOnce(
      new Response('<html><body>No deep initialization here</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }),
    );
    fetchSpy.mockResolvedValueOnce(
      new Response(
        `
          <div class="result">
            <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F1&amp;rut=abc" class="result__a">Result <b>1</b></a>
            <div class="result__snippet">First <b>result</b></div>
          </div>
        `,
        { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
      ),
    );

    const result = (await tool.execute(
      { query: 'test query' } as any,
      stubToolContext(),
    )) as any;

    expect(result.results).toEqual([
      {
        title: 'Result 1',
        url: 'https://example.com/1',
        snippet: 'First result',
      },
    ]);
    expect(tool.summarizeResult?.(result)).toMatchObject({
      provider: 'duckduckgo',
      providerPath: 'html-fallback',
      resultCount: 1,
    });

    const [fallbackUrl] = fetchSpy.mock.calls[1];
    expect(fallbackUrl).toContain('html.duckduckgo.com/html/');
    expect(fallbackUrl).toContain('q=test+query');
  });

  it('returns a recoverable error on a DuckDuckGo anomaly challenge page', async () => {
    const tool = createWebSearchTool({ provider: 'duckduckgo' });

    fetchSpy.mockResolvedValueOnce(
      new Response('<form action="//duckduckgo.com/anomaly.js"></form>', {
        status: 202,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }),
    );

    const result = (await executeRecoverableTool(tool, { query: 'test' })) as any;

    expect(result).toMatchObject({
      query: 'test',
      results: [],
      error: {
        kind: 'challenge',
        status: 202,
        provider: 'duckduckgo',
      },
    });
  });

  it('respects maxResults', async () => {
    const tool = createWebSearchTool({ apiKey: 'key', maxResults: 1 });

    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          web: {
            results: [
              { title: 'A', url: 'https://a.com', description: 'a' },
              { title: 'B', url: 'https://b.com', description: 'b' },
            ],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = (await tool.execute(
      { query: 'test' } as any,
      stubToolContext(),
    )) as any;

    expect(result.results).toHaveLength(1);
  });

  it('returns a recoverable error on non-OK response', async () => {
    const tool = createWebSearchTool({ apiKey: 'key' });

    fetchSpy.mockResolvedValueOnce(
      new Response('forbidden', { status: 403 }),
    );

    const result = (await executeRecoverableTool(tool, { query: 'test' })) as any;

    expect(result).toMatchObject({
      query: 'test',
      results: [],
      error: {
        kind: 'http_error',
        status: 403,
        provider: 'brave',
      },
    });
    expect(tool.summarizeResult?.(result)).toMatchObject({
      provider: 'brave',
      resultCount: 0,
      error: {
        kind: 'http_error',
        status: 403,
      },
    });
  });

  it('accepts optional purpose metadata on web_search input', async () => {
    const tool = createWebSearchTool({ apiKey: 'key' });

    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          web: {
            results: [{ title: 'A', url: 'https://a.com', description: 'a' }],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = (await tool.execute(
      {
        query: 'test',
        purpose: 'verify a claim',
        expectedUse: 'verify',
        freshnessRequired: true,
      } as any,
      stubToolContext(),
    )) as any;

    expect(result).toMatchObject({
      query: 'test',
      purpose: 'verify a claim',
      expectedUse: 'verify',
      freshnessRequired: true,
      researchStatus: {
        status: 'complete',
      },
    });
  });

  it('has correct tool metadata', () => {
    const tool = createWebSearchTool({ apiKey: 'key' });
    expect(tool.name).toBe('web_search');
    expect(tool.requiresApproval).toBeUndefined();
  });
});

// ── read_web_page ───────────────────────────────────────────────────────────

describe('createReadWebPageTool', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches a page and extracts title and text', async () => {
    const tool = createReadWebPageTool();
    expect(tool.budgetGroup).toBe('web_research.read');

    const html = `
      <html>
        <head><title>Test Page</title></head>
        <body>
          <h1>Hello</h1>
          <p>This is a paragraph.</p>
          <script>var x = 1;</script>
          <style>.foo { color: red; }</style>
        </body>
      </html>
    `;

    fetchSpy.mockResolvedValueOnce(
      new Response(html, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }),
    );

    const result = (await tool.execute(
      { url: 'https://example.com/page' } as any,
      stubToolContext(),
    )) as any;

    expect(result.url).toBe('https://example.com/page');
    expect(result.title).toBe('Test Page');
    expect(result.text).toContain('Hello');
    expect(result.text).toContain('This is a paragraph.');
    expect(result.text).not.toContain('var x = 1');
    expect(result.text).not.toContain('.foo');
    expect(result.bytesFetched).toBeGreaterThan(0);
  });

  it('truncates text exceeding maxTextLength', async () => {
    const tool = createReadWebPageTool({ maxTextLength: 20 });

    fetchSpy.mockResolvedValueOnce(
      new Response('<html><body><p>A long paragraph that exceeds the limit</p></body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
    );

    const result = (await tool.execute(
      { url: 'https://example.com' } as any,
      stubToolContext(),
    )) as any;

    expect(result.text).toContain('[truncated]');
    expect(result.text.length).toBeLessThan(50);
  });

  it('decodes HTML entities', async () => {
    const tool = createReadWebPageTool();

    fetchSpy.mockResolvedValueOnce(
      new Response('<html><body><p>Tom &amp; Jerry &lt;3&gt;</p></body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
    );

    const result = (await tool.execute(
      { url: 'https://example.com' } as any,
      stubToolContext(),
    )) as any;

    expect(result.text).toContain('Tom & Jerry <3>');
  });

  it('returns a recoverable error on non-OK response', async () => {
    const tool = createReadWebPageTool();

    fetchSpy.mockResolvedValueOnce(
      new Response('not found', { status: 404, headers: { 'Content-Type': 'text/html' } }),
    );

    const result = (await executeRecoverableTool(tool, { url: 'https://example.com/nope' })) as any;

    expect(result).toMatchObject({
      url: 'https://example.com/nope',
      title: '',
      text: '',
      bytesFetched: 0,
      error: {
        kind: 'http_error',
        status: 404,
      },
    });
  });

  it('returns a recoverable error on non-text content type', async () => {
    const tool = createReadWebPageTool();

    fetchSpy.mockResolvedValueOnce(
      new Response('binary', {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
    );

    const result = (await executeRecoverableTool(tool, { url: 'https://example.com/bin' })) as any;

    expect(result).toMatchObject({
      url: 'https://example.com/bin',
      error: {
        kind: 'content_error',
      },
    });
    expect(result.error.message).toContain('Unsupported content type');
  });

  it('returns a recoverable error on oversized responses', async () => {
    const tool = createReadWebPageTool({ maxSizeBytes: 4 });

    fetchSpy.mockResolvedValueOnce(
      new Response('hello', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      }),
    );

    const result = (await executeRecoverableTool(tool, { url: 'https://example.com/large' })) as any;

    expect(result).toMatchObject({
      url: 'https://example.com/large',
      error: {
        kind: 'content_error',
      },
    });
    expect(result.error.message).toContain('exceeds maximum size');
  });

  it('returns a recoverable timeout error for slow page reads', () => {
    const tool = createReadWebPageTool();
    const result = tool.recoverError?.(new Error('Timed out after 30000ms'), {
      url: 'https://example.com/slow',
    } as any) as any;

    expect(result).toMatchObject({
      url: 'https://example.com/slow',
      title: '',
      text: '',
      bytesFetched: 0,
      error: {
        kind: 'timeout',
        message: 'Timed out after 30000ms',
      },
    });
  });

  it('has correct tool metadata', () => {
    const tool = createReadWebPageTool();
    expect(tool.name).toBe('read_web_page');
    expect(tool.requiresApproval).toBeUndefined();
  });
});
