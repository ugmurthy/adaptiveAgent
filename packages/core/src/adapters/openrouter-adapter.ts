import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';

import { OpenRouter } from '@openrouter/sdk';

import type { FileInput, ModelContentPart, ModelMessage, ModelRequest, ModelResponse } from '../types.js';
import { BaseOpenAIChatAdapter, MAX_LOCAL_AUDIO_BYTES, MAX_LOCAL_FILE_BYTES, type BaseOpenAIChatAdapterConfig } from './base-openai-chat-adapter.js';
import { toProviderSdkResponseFormat } from './provider-sdk-request.js';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const TEXT_LIKE_FILE_MIME_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/rtf',
  'application/x-ndjson',
  'application/x-yaml',
  'application/xml',
  'text/csv',
  'text/html',
  'text/markdown',
  'text/plain',
  'text/tab-separated-values',
  'text/xml',
  'text/yaml',
]);
export interface OpenRouterAdapterConfig {
  model: string;
  apiKey: string;
  baseUrl?: string;
  siteUrl?: string;
  siteName?: string;
  maxConcurrentRequests?: number;
}

export class OpenRouterAdapter extends BaseOpenAIChatAdapter {
  private readonly client: OpenRouter;
  private readonly sdkHeaders: Record<string, string>;

  constructor(config: OpenRouterAdapterConfig) {
    const headers: Record<string, string> = {};

    if (config.siteUrl) {
      headers['HTTP-Referer'] = config.siteUrl;
    }

    if (config.siteName) {
      headers['X-Title'] = config.siteName;
    }

    const baseConfig: BaseOpenAIChatAdapterConfig = {
      provider: 'openrouter',
      model: config.model,
      baseUrl: config.baseUrl ?? OPENROUTER_BASE_URL,
      apiKey: config.apiKey,
      defaultHeaders: headers,
      maxConcurrentRequests: config.maxConcurrentRequests,
      capabilities: {
        toolCalling: true,
        jsonOutput: true,
        streaming: true,
        usage: true,
        imageInput: true,
        input: {
          image: { sources: ['path'] },
          file: { sources: ['path', 'url', 'file_id'], maxInlineBytes: MAX_LOCAL_FILE_BYTES },
          audio: { sources: ['path', 'data'], maxInlineBytes: MAX_LOCAL_AUDIO_BYTES },
        },
      },
    };

    super(baseConfig);
    this.sdkHeaders = headers;

    this.client = new OpenRouter({
      apiKey: config.apiKey,
      httpReferer: config.siteUrl,
      appTitle: config.siteName,
      serverURL: config.baseUrl ?? OPENROUTER_BASE_URL,
      retryConfig: { strategy: 'none' },
    });
  }

  override async generate(request: ModelRequest): Promise<ModelResponse> {
    const normalizedRequest = await normalizeOpenRouterRequest(request);
    const body = await this.buildRequestBody(normalizedRequest);
    const completion = await this.client.chat.send(
      {
        chatRequest: toSdkRequest(body),
      } as never,
      { signal: request.signal, headers: this.sdkHeaders } as never,
    );

    return this.parseResponse(fromSdkResponse(completion));
  }
}

function toSdkRequest(body: Record<string, unknown>): Record<string, unknown> {
  return {
    ...body,
    messages: Array.isArray(body.messages) ? body.messages.map(toSdkMessage) : body.messages,
    response_format: undefined,
    responseFormat: toProviderSdkResponseFormat(body.response_format),
    parallelToolCalls: false,
  };
}

function toSdkMessage(message: unknown): Record<string, unknown> {
  const data = message as Record<string, unknown>;
  return {
    ...data,
    content: Array.isArray(data.content) ? data.content.map(toSdkContentPart) : data.content,
    tool_call_id: undefined,
    toolCallId: data.tool_call_id,
    tool_calls: undefined,
    toolCalls: Array.isArray(data.tool_calls) ? data.tool_calls.map(toSdkToolCall) : undefined,
    reasoning_details: undefined,
    reasoningDetails: data.reasoning_details,
  };
}

function toSdkContentPart(part: unknown): Record<string, unknown> {
  const data = part as Record<string, unknown>;
  const file = data.file as Record<string, unknown> | undefined;
  const inputAudio = data.input_audio as Record<string, unknown> | undefined;
  return {
    ...data,
    image_url: undefined,
    imageUrl: data.image_url,
    file: file ? { fileData: file.file_data, fileId: file.file_id, filename: file.filename } : data.file,
    input_audio: undefined,
    inputAudio,
  };
}

function toSdkToolCall(toolCall: unknown): Record<string, unknown> {
  const data = toolCall as Record<string, unknown>;
  return {
    ...data,
    function: data.function,
  };
}

function fromSdkResponse(response: unknown): never {
  const data = response as Record<string, unknown>;
  return {
    ...data,
    choices: Array.isArray(data.choices) ? data.choices.map(fromSdkChoice) : [],
    usage: data.usage ? fromSdkUsage(data.usage) : undefined,
  } as never;
}

function fromSdkChoice(choice: unknown): Record<string, unknown> {
  const data = choice as Record<string, unknown>;
  return {
    ...data,
    finish_reason: data.finishReason,
    message: data.message ? fromSdkMessage(data.message) : data.message,
  };
}

function fromSdkMessage(message: unknown): Record<string, unknown> {
  const data = message as Record<string, unknown>;
  return {
    ...data,
    tool_calls: Array.isArray(data.toolCalls) ? data.toolCalls.map(fromSdkToolCall) : undefined,
    reasoning_details: data.reasoningDetails,
  };
}

function fromSdkToolCall(toolCall: unknown): Record<string, unknown> {
  const data = toolCall as Record<string, unknown>;
  return {
    ...data,
    function: data.function,
  };
}

function fromSdkUsage(usage: unknown): Record<string, unknown> {
  const data = usage as Record<string, unknown>;
  return {
    prompt_tokens: data.promptTokens,
    completion_tokens: data.completionTokens,
    total_tokens: data.totalTokens,
    cost: data.cost,
    cost_details: data.costDetails,
    completion_tokens_details: data.completionTokensDetails,
  };
}

async function normalizeOpenRouterRequest(request: ModelRequest): Promise<ModelRequest> {
  const messages = await Promise.all(request.messages.map(normalizeOpenRouterMessage));
  const changed = messages.some((message, index) => message !== request.messages[index]);
  return changed ? { ...request, messages } : request;
}

async function normalizeOpenRouterMessage(message: ModelMessage): Promise<ModelMessage> {
  if (!Array.isArray(message.content)) {
    return message;
  }

  let changed = false;
  const content: ModelContentPart[] = [];
  for (const part of message.content) {
    if (part.type !== 'file') {
      content.push(part);
      continue;
    }

    const textPart = await normalizeTextLikeFilePart(part.file);
    if (!textPart) {
      content.push(part);
      continue;
    }

    content.push(textPart);
    changed = true;
  }

  return changed ? { ...message, content } : message;
}

async function normalizeTextLikeFilePart(
  file: FileInput,
): Promise<Extract<ModelContentPart, { type: 'text' }> | undefined> {
  const mimeType = detectFileMimeType(file);
  if (!isTextLikeFileMimeType(mimeType)) {
    return undefined;
  }

  const text = await readFileInputAsText(file);
  if (text === undefined) {
    return undefined;
  }

  return {
    type: 'text',
    text: formatInlineFileText(file, mimeType, text),
  };
}

function detectFileMimeType(file: FileInput): string | undefined {
  if (typeof file.mimeType === 'string' && file.mimeType.trim()) {
    return file.mimeType.trim().toLowerCase();
  }

  const extension = inferFileExtension(file)?.toLowerCase();
  switch (extension) {
    case '.csv': return 'text/csv';
    case '.htm':
    case '.html': return 'text/html';
    case '.json': return 'application/json';
    case '.jsonl':
    case '.ndjson': return 'application/x-ndjson';
    case '.md':
    case '.markdown': return 'text/markdown';
    case '.rtf': return 'application/rtf';
    case '.tsv': return 'text/tab-separated-values';
    case '.txt': return 'text/plain';
    case '.xml': return 'application/xml';
    case '.yaml':
    case '.yml': return 'text/yaml';
    default: return undefined;
  }
}

function inferFileExtension(file: FileInput): string | undefined {
  if (file.source.kind === 'path') {
    return extname(file.source.path);
  }
  if (typeof file.name === 'string' && file.name.trim()) {
    return extname(file.name);
  }
  if (file.source.kind === 'url') {
    const path = safeUrlPathname(file.source.url);
    return path ? extname(path) : undefined;
  }
  return undefined;
}

function isTextLikeFileMimeType(mimeType: string | undefined): boolean {
  if (!mimeType) {
    return false;
  }
  return mimeType.startsWith('text/')
    || mimeType.endsWith('+json')
    || TEXT_LIKE_FILE_MIME_TYPES.has(mimeType);
}

async function readFileInputAsText(file: FileInput): Promise<string | undefined> {
  switch (file.source.kind) {
    case 'path': {
      const fileStats = await stat(file.source.path);
      if (!fileStats.isFile()) {
        throw new Error(`File input path is not a file: ${file.source.path}`);
      }
      if (fileStats.size > MAX_LOCAL_FILE_BYTES) {
        throw new Error(`File input ${file.source.path} exceeds maximum size of ${MAX_LOCAL_FILE_BYTES} bytes`);
      }
      const buffer = await readFile(file.source.path);
      if (buffer.byteLength > MAX_LOCAL_FILE_BYTES) {
        throw new Error(`File input ${file.source.path} exceeds maximum size of ${MAX_LOCAL_FILE_BYTES} bytes`);
      }
      return buffer.toString('utf8');
    }
    case 'url':
      return parseDataUrlAsText(file.source.url);
    case 'file_id':
      return undefined;
  }
}

function parseDataUrlAsText(value: string): string | undefined {
  if (!value.startsWith('data:')) {
    return undefined;
  }

  const commaIndex = value.indexOf(',');
  if (commaIndex < 0) {
    return undefined;
  }

  const header = value.slice(5, commaIndex);
  const payload = value.slice(commaIndex + 1);
  const base64 = header.split(';').includes('base64');
  return base64
    ? Buffer.from(payload, 'base64').toString('utf8')
    : decodeURIComponent(payload);
}

function formatInlineFileText(file: FileInput, mimeType: string | undefined, text: string): string {
  const name = escapeXmlAttribute(file.name ?? inferFileName(file) ?? 'attached-file');
  const mimeAttribute = mimeType ? ` mimeType="${escapeXmlAttribute(mimeType)}"` : '';
  return `<file name="${name}"${mimeAttribute}>\n${text}\n</file>`;
}

function inferFileName(file: FileInput): string | undefined {
  if (file.source.kind === 'path') {
    const segments = file.source.path.split(/[\\/]/).filter(Boolean);
    return segments.at(-1);
  }
  if (file.source.kind === 'url') {
    const path = safeUrlPathname(file.source.url);
    if (!path) {
      return undefined;
    }
    const segments = path.split('/').filter(Boolean);
    return segments.at(-1);
  }
  return undefined;
}

function safeUrlPathname(value: string): string | undefined {
  try {
    return new URL(value).pathname;
  } catch {
    return undefined;
  }
}

function escapeXmlAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
