import { MeshAPI, MeshAPIApiError } from 'meshapi-node-sdk';

import { approximateSerializedByteLength, compactJsonObject } from '../logging.js';
import type { ModelRequest, ModelResponse, StructuredOutputMode } from '../types.js';
import { BaseOpenAIChatAdapter, MAX_LOCAL_AUDIO_BYTES, type BaseOpenAIChatAdapterConfig } from './base-openai-chat-adapter.js';

const MESH_BASE_URL = 'https://api.meshapi.ai/v1';
const DISABLED_MODEL_TIMEOUT_MESH_HTTP_TIMEOUT_MS = 900_000;

export interface MeshAdapterConfig {
  model: string;
  apiKey: string;
  baseUrl?: string;
  maxConcurrentRequests?: number;
  structuredOutputMode?: StructuredOutputMode;
}

export class MeshAdapter extends BaseOpenAIChatAdapter {
  private readonly client: MeshAPI;

  constructor(config: MeshAdapterConfig) {
    const baseConfig: BaseOpenAIChatAdapterConfig = {
      provider: 'mesh',
      model: config.model,
      baseUrl: config.baseUrl ?? MESH_BASE_URL,
      apiKey: config.apiKey,
      maxConcurrentRequests: config.maxConcurrentRequests,
      structuredOutputMode: config.structuredOutputMode,
      capabilities: {
        toolCalling: true,
        jsonOutput: true,
        streaming: true,
        usage: true,
        imageInput: true,
        input: {
          image: { sources: ['path'] },
          audio: { sources: ['path', 'data'], maxInlineBytes: MAX_LOCAL_AUDIO_BYTES },
        },
      },
    };

    super(baseConfig);

    this.client = new MeshAPI({
      baseUrl: toMeshSdkBaseUrl(config.baseUrl ?? MESH_BASE_URL),
      token: config.apiKey,
      maxRetries: 0,
    });
  }

  override async generate(request: ModelRequest): Promise<ModelResponse> {
    const body = await this.buildRequestBody(request);
    let completion;
    const startedAt = Date.now();
    try {
      completion = await this.client.chat.completions.create(
        {
          ...body,
          stream: false,
        } as never,
        { signal: request.signal, timeoutMs: resolveMeshHttpTimeoutMs(request.modelTimeoutMs) },
      );
    } catch (error) {
      throw enrichMeshError(error);
    }

    const parsed = this.parseResponse(completion as never);
    return {
      ...parsed,
      rawProviderResponse: completion,
      performance: compactJsonObject({
        ...(parsed.performance ?? {}),
        adapterAttemptCount: 1,
        adapterResponseLatencyMs: Date.now() - startedAt,
        adapterRequestBytes: approximateSerializedByteLength(body),
        adapterResponseBytes: approximateSerializedByteLength(completion),
      }),
    };
  }
}

function toMeshSdkBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
}

function resolveMeshHttpTimeoutMs(modelTimeoutMs: number | undefined): number | undefined {
  if (modelTimeoutMs === undefined) {
    return undefined;
  }

  return modelTimeoutMs > 0 ? modelTimeoutMs : DISABLED_MODEL_TIMEOUT_MESH_HTTP_TIMEOUT_MS;
}

function enrichMeshError(error: unknown): Error {
  if (!(error instanceof MeshAPIApiError)) {
    return error instanceof Error ? error : new Error(String(error));
  }

  const providerDetail = extractMeshProviderDetail(error.providerError);
  if (!providerDetail) {
    return error;
  }

  const requestIdSuffix = error.requestId ? ` [requestId=${error.requestId}]` : '';
  const enriched = new Error(`${error.message}: ${providerDetail}${requestIdSuffix}`, { cause: error });
  enriched.name = error.name;
  return enriched;
}

function extractMeshProviderDetail(value: Record<string, unknown> | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const directMessage = readNestedString(value, [
    ['message'],
    ['error'],
    ['detail'],
    ['provider_message'],
    ['cause'],
    ['error', 'message'],
    ['details', 'message'],
  ]);
  if (directMessage) {
    return directMessage;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function readNestedString(
  value: Record<string, unknown>,
  paths: string[][],
): string | undefined {
  for (const path of paths) {
    let current: unknown = value;
    for (const segment of path) {
      if (typeof current !== 'object' || current === null || !(segment in current)) {
        current = undefined;
        break;
      }

      current = (current as Record<string, unknown>)[segment];
    }

    if (typeof current === 'string' && current.trim().length > 0) {
      return current.trim();
    }
  }

  return undefined;
}
