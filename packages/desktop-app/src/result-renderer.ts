import createDOMPurify, { type DOMPurify, type WindowLike } from 'dompurify';
import { marked, Renderer } from 'marked';

export const MAX_RESULT_SOURCE_SIZE = 256 * 1024;
export const MAX_MERMAID_SOURCE_SIZE = 64 * 1024;
export const MAX_MERMAID_DIAGRAMS = 8;

export type ResultFormat = 'markdown' | 'text' | 'json';

export interface RenderedResult {
  format: ResultFormat;
  html: string;
  source: string;
  warnings: string[];
}

interface MermaidApi {
  initialize(configuration: Record<string, unknown>): void;
  render(id: string, source: string): Promise<{ svg: string }>;
}

const HTML_TAGS = [
  'a', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'li', 'ol', 'p', 'pre', 'strong', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul',
  'div', 'span',
];
const HTML_ATTRIBUTES = ['class', 'data-mermaid-placeholder', 'href', 'rel', 'target'];
const SVG_TAGS = [
  'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text',
  'tspan', 'defs', 'marker', 'linearGradient', 'radialGradient', 'stop', 'title', 'desc', 'clipPath',
];
const SVG_ATTRIBUTES = [
  'aria-describedby', 'aria-labelledby', 'class', 'clip-path', 'cx', 'cy', 'd', 'dominant-baseline',
  'dx', 'dy', 'fill', 'fill-opacity', 'font-family', 'font-size', 'font-weight', 'height', 'id',
  'marker-end', 'marker-mid', 'marker-start', 'offset', 'opacity', 'orient', 'points', 'preserveAspectRatio',
  'r', 'refX', 'refY', 'role', 'rx', 'ry', 'stop-color', 'stop-opacity', 'stroke', 'stroke-dasharray',
  'stroke-linecap', 'stroke-linejoin', 'stroke-width', 'text-anchor', 'transform', 'viewBox', 'width',
  'x', 'x1', 'x2', 'xmlns', 'y', 'y1', 'y2',
];

let renderSequence = 0;

export function createResultRenderer(purifier: DOMPurify, mermaid: MermaidApi) {
  let initialized = false;
  return async (value: unknown, format?: ResultFormat): Promise<RenderedResult> => {
    const resolvedFormat = format ?? (typeof value === 'string' ? 'markdown' : 'json');
    const source = resolvedFormat === 'json'
      ? safeStringify(value)
      : typeof value === 'string' ? value : String(value ?? '');
    if (resolvedFormat === 'json') {
      return { format: resolvedFormat, source, html: `<pre><code>${escapeHtml(source)}</code></pre>`, warnings: [] };
    }
    if (resolvedFormat === 'text') {
      return { format: resolvedFormat, source, html: `<pre><code>${escapeHtml(source)}</code></pre>`, warnings: [] };
    }
    if (byteLength(source) > MAX_RESULT_SOURCE_SIZE) {
      return {
        format: resolvedFormat,
        source,
        html: `<pre><code>${escapeHtml(source)}</code></pre>`,
        warnings: [`Markdown exceeds the ${MAX_RESULT_SOURCE_SIZE}-byte rendering limit; showing source.`],
      };
    }

    const diagrams: string[] = [];
    const renderer = new Renderer();
    renderer.code = ({ text, lang }) => {
      if (lang?.trim().toLowerCase() !== 'mermaid') {
        return `<pre><code>${escapeHtml(text)}</code></pre>`;
      }
      const index = diagrams.push(text) - 1;
      return `<div data-mermaid-placeholder="${index}"></div>`;
    };
    const parsed = marked.parse(source, { async: false, renderer }) as string;
    let html = sanitizeHtml(purifier, parsed);
    const warnings: string[] = [];
    if (!initialized) {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        htmlLabels: false,
        flowchart: { htmlLabels: false },
        suppressErrorRendering: true,
      });
      initialized = true;
    }
    const renderInstance = ++renderSequence;
    for (let index = 0; index < diagrams.length; index += 1) {
      const sourceDiagram = diagrams[index]!;
      const placeholder = `<div data-mermaid-placeholder="${index}"></div>`;
      let replacement: string;
      if (index >= MAX_MERMAID_DIAGRAMS) {
        warnings.push(`Diagram ${index + 1} exceeds the ${MAX_MERMAID_DIAGRAMS}-diagram limit; showing source.`);
        replacement = sourceFallback(sourceDiagram);
      } else if (byteLength(sourceDiagram) > MAX_MERMAID_SOURCE_SIZE) {
        warnings.push(`Diagram ${index + 1} exceeds the ${MAX_MERMAID_SOURCE_SIZE}-byte limit; showing source.`);
        replacement = sourceFallback(sourceDiagram);
      } else if (!isSafeMermaidSource(sourceDiagram)) {
        warnings.push(`Diagram ${index + 1} contains an external reference or unsafe directive; showing source.`);
        replacement = sourceFallback(sourceDiagram);
      } else {
        try {
          const id = `adaptive-mermaid-${renderInstance}-${index}`;
          const rendered = await mermaid.render(id, sourceDiagram);
          replacement = sanitizeSvg(purifier, rendered.svg);
          if (!replacement.includes('<svg')) throw new Error('Mermaid returned no safe SVG.');
        } catch {
          warnings.push(`Diagram ${index + 1} could not be rendered safely; showing source.`);
          replacement = sourceFallback(sourceDiagram);
        }
      }
      html = html.replace(placeholder, replacement);
    }
    return { format: resolvedFormat, source, html, warnings };
  };
}

export function sanitizeHtml(purifier: DOMPurify, html: string): string {
  const sanitized = purifier.sanitize(html, {
    ALLOWED_TAGS: HTML_TAGS,
    ALLOWED_ATTR: HTML_ATTRIBUTES,
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'img', 'video', 'audio'],
    FORBID_ATTR: ['src', 'srcset', 'onerror', 'onload', 'onclick'],
  }) as string;
  const template = purifier.sanitize('<template></template>', { RETURN_DOM: true }) as Element;
  const document = template.ownerDocument;
  const container = document.createElement('div');
  container.innerHTML = sanitized;
  for (const link of container.querySelectorAll('a')) {
    const href = link.getAttribute('href');
    if (!href || !isSafeLink(href)) {
      link.removeAttribute('href');
      link.removeAttribute('target');
      link.removeAttribute('rel');
    } else if (/^https?:/i.test(href)) {
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
    }
  }
  return container.innerHTML;
}

export function sanitizeSvg(purifier: DOMPurify, svg: string): string {
  const sanitized = purifier.sanitize(svg, {
    ALLOWED_TAGS: SVG_TAGS,
    ALLOWED_ATTR: SVG_ATTRIBUTES,
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: ['script', 'style', 'foreignObject', 'iframe', 'image', 'use', 'a'],
    FORBID_ATTR: ['href', 'xlink:href', 'onerror', 'onload', 'onclick', 'style'],
  }) as string;
  if (/<(?:script|style|foreignObject|iframe|image|use|a)\b/i.test(sanitized)) return '';
  const withoutLocalFragments = sanitized.replace(/url\(\s*#[a-z][\w:.-]*\s*\)/gi, '');
  if (/\son[a-z]+\s*=|(?:javascript|data|https?|file):|url\s*\(|@import|expression\s*\(/i.test(withoutLocalFragments)) return '';
  return sanitized;
}

let browserRenderer: ReturnType<typeof createResultRenderer> | undefined;
export async function renderResult(value: unknown, format?: ResultFormat): Promise<RenderedResult> {
  if (!browserRenderer) {
    const purifier = createDOMPurify(window as unknown as WindowLike);
    const mermaid = (await import('mermaid')).default;
    browserRenderer = createResultRenderer(purifier, mermaid);
  }
  return browserRenderer(value, format);
}

function isSafeLink(href: string): boolean {
  return href.startsWith('#') || /^(?:https?:|mailto:)/i.test(href);
}

function isSafeMermaidSource(source: string): boolean {
  return !/(?:javascript|data|https?|file):|\/\/|\bclick\s+|%%\{|<\/?[a-z]|url\s*\(|\b(?:image|icon)\s*:/i.test(source);
}

function sourceFallback(source: string): string {
  return `<pre class="mermaid-source"><code>${escapeHtml(source)}</code></pre>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return '[Unable to serialize structured result]';
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
