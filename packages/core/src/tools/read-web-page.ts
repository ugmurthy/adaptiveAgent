import type { ToolDefinition } from '../types.js';

export interface ReadWebPageToolConfig {
  /** Maximum response body size in bytes. Defaults to 512 KiB. */
  maxSizeBytes?: number;
  /** Maximum extracted text length in characters. Defaults to 50000. */
  maxTextLength?: number;
}

interface ReadWebPageInput {
  url: string;
}

interface ReadWebPageOutput {
  url: string;
  title: string;
  text: string;
  bytesFetched: number;
}

const DEFAULT_MAX_SIZE = 524_288; // 512 KiB
const DEFAULT_MAX_TEXT_LENGTH = 50_000;

export function createReadWebPageTool(config?: ReadWebPageToolConfig): ToolDefinition {
  const maxSizeBytes = config?.maxSizeBytes ?? DEFAULT_MAX_SIZE;
  const maxTextLength = config?.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;

  return {
    name: 'read_web_page',
    description:
      'Fetch a web page and extract its text content. Returns the URL, page title, and extracted text.',
    inputSchema: {
      type: 'object',
      required: ['url'],
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'The URL of the web page to read.' },
      },
    },
    async execute(input, context) {
      const { url } = input as unknown as ReadWebPageInput;

      const response = await fetch(url, {
        headers: {
          'User-Agent': 'AdaptiveAgent/1.0 (compatible; bot)',
          Accept: 'text/html,application/xhtml+xml,text/plain',
        },
        signal: context.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} fetching ${url}`);
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('text/') && !contentType.includes('html') && !contentType.includes('xml')) {
        throw new Error(`Unsupported content type ${contentType} for ${url}`);
      }

      const rawBuffer = await response.arrayBuffer();
      if (rawBuffer.byteLength > maxSizeBytes) {
        throw new Error(`Response from ${url} exceeds maximum size of ${maxSizeBytes} bytes`);
      }

      const html = new TextDecoder().decode(rawBuffer);
      const title = extractTitle(html);
      let text = stripHtmlToText(html);

      if (text.length > maxTextLength) {
        text = text.slice(0, maxTextLength) + '\n[truncated]';
      }

      return {
        url,
        title,
        text,
        bytesFetched: rawBuffer.byteLength,
      } satisfies ReadWebPageOutput as unknown as ReturnType<ToolDefinition['execute']>;
    },
  };
}

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeHtmlEntities(match[1].trim()) : '';
}

function stripHtmlToText(html: string): string {
  let text = html;

  // Remove script and style blocks
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');

  // Replace block-level tags with newlines
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|br|blockquote|section|article|header|footer|nav)[\s>]/gi, '\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');

  // Remove all remaining HTML tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode common HTML entities
  text = decodeHtmlEntities(text);

  // Collapse whitespace
  text = text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');

  return text.trim();
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}
