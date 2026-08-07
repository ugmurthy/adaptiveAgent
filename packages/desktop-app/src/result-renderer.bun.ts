import { describe, expect, it } from 'bun:test';
import createDOMPurify, { type WindowLike } from 'dompurify';
import { JSDOM } from 'jsdom';

import {
  createResultRenderer,
  MAX_MERMAID_DIAGRAMS,
  MAX_MERMAID_SOURCE_SIZE,
  MAX_RESULT_SOURCE_SIZE,
  sanitizeHtml,
  sanitizeSvg,
} from './result-renderer';

function purifier() {
  return createDOMPurify(new JSDOM('').window as unknown as WindowLike);
}

describe('secure result renderer', () => {
  it('sanitizes Markdown scripts, handlers, embeds, images, and unsafe URLs', () => {
    const clean = sanitizeHtml(purifier(), '<script>alert(1)</script><img src="https://tracker.invalid/x"><a href="javascript:alert(1)" onclick="alert(2)">bad</a><a href="https://example.com">safe</a>');
    expect(clean).not.toMatch(/script|img|javascript|onclick|tracker\.invalid/i);
    expect(clean).toContain('<a>bad</a>');
    expect(clean).toContain('href="https://example.com"');
    expect(clean).toContain('rel="noopener noreferrer"');
  });

  it('uses strict Mermaid configuration, unique IDs, and an SVG-specific allowlist', async () => {
    const ids: string[] = [];
    let configuration: Record<string, unknown> | undefined;
    const render = createResultRenderer(purifier(), {
      initialize(value) { configuration = value; },
      async render(id) {
        ids.push(id);
        return { svg: '<svg viewBox="0 0 10 10"><script>alert(1)</script><foreignObject><div onclick="x()">bad</div></foreignObject><image href="https://tracker.invalid/x"/><path d="M0 0L1 1" onload="x()"/></svg>' };
      },
    });
    const first = await render('```mermaid\ngraph TD; A-->B\n```');
    const second = await render('```mermaid\ngraph TD; B-->C\n```');
    expect(configuration).toMatchObject({ securityLevel: 'strict', htmlLabels: false, flowchart: { htmlLabels: false } });
    expect(ids[0]).not.toBe(ids[1]);
    expect(first.html).toContain('<svg');
    expect(first.html).not.toMatch(/script|foreignObject|onclick|onload|image|tracker\.invalid/i);
    expect(second.warnings).toEqual([]);
  });

  it('falls back per diagram for malformed, oversized, and excess Mermaid without hiding Markdown', async () => {
    const render = createResultRenderer(purifier(), {
      initialize() {},
      async render(_id, source) {
        if (source.includes('broken')) throw new Error('parse');
        return { svg: '<svg><path d="M0 0"/></svg>' };
      },
    });
    const diagrams = Array.from({ length: MAX_MERMAID_DIAGRAMS + 1 }, (_, index) => `\`\`\`mermaid\ngraph TD; A${index}-->B\n\`\`\``).join('\n');
    const result = await render(`# Surrounding\n\n\`\`\`mermaid\nbroken\n\`\`\`\n\n${diagrams}`);
    expect(result.html).toContain('<h1>Surrounding</h1>');
    expect(result.html).toContain('broken');
    expect(result.warnings.length).toBe(3);

    const oversized = await render(`\`\`\`mermaid\n${'x'.repeat(MAX_MERMAID_SOURCE_SIZE + 1)}\n\`\`\``);
    expect(oversized.html).toContain('mermaid-source');
    expect(oversized.warnings).toHaveLength(1);
  });

  it('defaults strings to Markdown, preserves raw source, and bounds whole-result rendering', async () => {
    const render = createResultRenderer(purifier(), { initialize() {}, async render() { return { svg: '<svg></svg>' }; } });
    const markdown = await render('**safe**');
    expect(markdown.format).toBe('markdown');
    expect(markdown.source).toBe('**safe**');
    expect(markdown.html).toContain('<strong>safe</strong>');
    const structured = await render({ answer: 42 });
    expect(structured.format).toBe('json');
    expect(structured.html).toContain('&quot;answer&quot;');
    const plain = await render('<b>literal</b>', 'text');
    expect(plain.format).toBe('text');
    expect(plain.html).toContain('&lt;b&gt;literal&lt;/b&gt;');
    const oversized = await render('x'.repeat(MAX_RESULT_SOURCE_SIZE + 1));
    expect(oversized.warnings).toHaveLength(1);
    expect(oversized.html).toContain('<pre>');
  });

  it('syntax-highlights supported fenced code and safely escapes unknown languages', async () => {
    const render = createResultRenderer(purifier(), { initialize() {}, async render() { return { svg: '<svg></svg>' }; } });
    const highlighted = await render('```ts\nconst answer: number = 42;\n```');
    expect(highlighted.html).toContain('class="hljs language-typescript"');
    expect(highlighted.html).toContain('hljs-keyword');
    const unknown = await render('```made-up\n<script>alert(1)</script>\n```');
    expect(unknown.html).toContain('&lt;script&gt;');
    expect(unknown.html).not.toContain('<script>');
  });

  it('rejects active protocols and external references from SVG', () => {
    expect(sanitizeSvg(purifier(), '<svg><a href="javascript:alert(1)"><text>x</text></a><use href="https://example.com/x.svg#x"/></svg>'))
      .not.toMatch(/javascript|https|<a|<use/i);
    expect(sanitizeSvg(purifier(), '<svg><defs><marker id="arrow"><path d="M0 0"/></marker></defs><path d="M0 0" marker-end="url(#arrow)"/></svg>'))
      .toContain('marker-end="url(#arrow)"');
  });

  it('does not invoke Mermaid for external references or configuration directives', async () => {
    let calls = 0;
    const render = createResultRenderer(purifier(), {
      initialize() {},
      async render() { calls += 1; return { svg: '<svg></svg>' }; },
    });
    const result = await render('```mermaid\ngraph TD; A[https://tracker.invalid]-->B\n```\n```mermaid\n%%{init: {securityLevel: loose}}%%\ngraph TD; A-->B\n```');
    expect(calls).toBe(0);
    expect(result.warnings).toHaveLength(2);
    expect(result.html).not.toContain('<svg');
  });
});
