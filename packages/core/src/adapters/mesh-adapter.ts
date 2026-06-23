import { createHash } from 'node:crypto';

import { MeshAPI, MeshAPIApiError, type ModelInfo } from 'meshapi-node-sdk';

import { approximateSerializedByteLength, compactJsonObject } from '../logging.js';
import type { JsonValue, ModelRequest, ModelResponse, StructuredOutputMode } from '../types.js';
import { BaseOpenAIChatAdapter, MAX_LOCAL_AUDIO_BYTES, type BaseOpenAIChatAdapterConfig } from './base-openai-chat-adapter.js';

const MESH_BASE_URL = 'https://api.meshapi.ai/v1';
const DISABLED_MODEL_TIMEOUT_MESH_HTTP_TIMEOUT_MS = 900_000;
const MESH_MODEL_RATE_CACHE_TTL_MS = 30 * 60 * 1000;
const MESH_MODEL_PRICING_TIMEOUT_MS = 5_000;

export interface MeshAdapterConfig {
  model: string;
  apiKey: string;
  baseUrl?: string;
  maxConcurrentRequests?: number;
  structuredOutputMode?: StructuredOutputMode;
}

export class MeshAdapter extends BaseOpenAIChatAdapter {
  private readonly client: MeshAPI;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(config: MeshAdapterConfig) {
    const baseUrl = config.baseUrl ?? MESH_BASE_URL;
    const baseConfig: BaseOpenAIChatAdapterConfig = {
      provider: 'mesh',
      model: config.model,
      baseUrl,
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

    this.baseUrl = baseUrl;
    this.apiKey = config.apiKey;

    this.client = new MeshAPI({
      baseUrl: toMeshSdkBaseUrl(baseUrl),
      token: config.apiKey,
      maxRetries: 0,
    });
  }

  override async generate(request: ModelRequest): Promise<ModelResponse> {
    const body = await this.buildRequestBody(request);
    const chunks: unknown[] = [];
    const startedAt = Date.now();
    try {
      const stream = this.client.chat.completions.create(
        {
          ...body,
          stream: true,
        } as never,
        { signal: request.signal, timeoutMs: resolveMeshHttpTimeoutMs(request.modelTimeoutMs) },
      );
      const accumulator = new MeshStreamAccumulator();
      for await (const chunk of stream as AsyncIterable<unknown>) {
        chunks.push(chunk);
        accumulator.add(chunk);
      }

      const completion = accumulator.toCompletion();
      const providerReportedCost = hasPositiveProviderReportedCost(completion);
      const parsed = this.parseResponse(completion as never);
      const priced = await this.withEstimatedMeshCost(parsed, completion, providerReportedCost, request.signal);
      return {
        ...priced,
        providerResponseId: priced.providerResponseId || undefined,
        rawProviderResponse: chunks,
        performance: compactJsonObject({
          ...(priced.performance ?? {}),
          adapterAttemptCount: 1,
          adapterResponseLatencyMs: Date.now() - startedAt,
          adapterRequestBytes: approximateSerializedByteLength(body),
          adapterResponseBytes: approximateSerializedByteLength(chunks),
        }),
      };
    } catch (error) {
      throw enrichMeshError(error);
    }
  }

  private async withEstimatedMeshCost(
    response: ModelResponse,
    completion: Record<string, unknown>,
    providerReportedCost: boolean,
    signal: AbortSignal | undefined,
  ): Promise<ModelResponse> {
    if (!response.usage) {
      return response;
    }

    const responseUsageModel = response.usage.model;
    const actualModel = readString(completion.model) ?? responseUsageModel ?? this.model;
    const usage = response.usage.model === actualModel
      ? response.usage
      : { ...response.usage, model: actualModel };

    if (providerReportedCost) {
      return usage === response.usage ? response : { ...response, usage };
    }

    const rate = await getMeshModelRateForCandidates(
      this.client,
      this.baseUrl,
      this.apiKey,
      meshModelRateCandidates(actualModel, responseUsageModel, this.model),
      signal,
    );
    if (!rate) {
      return usage === response.usage ? response : { ...response, usage };
    }

    return {
      ...response,
      usage: {
        ...usage,
        estimatedCostUSD: estimateCostFromRate(usage.promptTokens, usage.completionTokens, rate),
      },
    };
  }
}

interface MeshModelRate {
  promptUsdPer1k: number;
  completionUsdPer1k: number;
}

interface MeshModelRateCacheEntry {
  ratesByModel: Map<string, MeshModelRate>;
  expiresAt: number;
}

const meshModelRateCache = new Map<string, MeshModelRateCacheEntry>();
const meshModelRateRefreshes = new Map<string, Promise<MeshModelRateCacheEntry>>();

function meshModelRateCandidates(...models: Array<string | undefined>): string[] {
  const candidates: string[] = [];
  for (const model of models) {
    addModelRateCandidate(candidates, model);
  }

  for (const model of [...candidates]) {
    const slashIndex = model.indexOf('/');
    if (slashIndex >= 0 && slashIndex < model.length - 1) {
      addModelRateCandidate(candidates, model.slice(slashIndex + 1));
    }
  }

  return candidates;
}

function addModelRateCandidate(candidates: string[], model: string | undefined): void {
  if (!model || candidates.includes(model)) {
    return;
  }
  candidates.push(model);
}

interface MeshAccumulatedToolCall {
  index: number;
  id?: string;
  name?: string;
  argumentsText: string;
}

class MeshStreamAccumulator {
  private id: string | undefined;
  private model: string | undefined;
  private text = '';
  private finishReason: string | undefined;
  private usage: Record<string, unknown> | undefined;
  private cost: unknown;
  private reasoning = '';
  private reasoningDetails: JsonValue[] | undefined;
  private readonly toolCalls = new Map<number, MeshAccumulatedToolCall>();
  private nextToolCallIndex = 0;

  add(chunk: unknown): void {
    if (!isRecord(chunk)) {
      return;
    }

    if (typeof chunk.id === 'string' && this.id === undefined) {
      this.id = chunk.id;
    }
    if (typeof chunk.model === 'string' && this.model === undefined) {
      this.model = chunk.model;
    }
    if (isRecord(chunk.usage)) {
      this.usage = chunk.usage;
    }
    if ('cost' in chunk && chunk.cost !== undefined && chunk.cost !== null) {
      this.cost = chunk.cost;
    }

    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    for (const choice of choices) {
      if (!isRecord(choice)) {
        continue;
      }
      if (typeof choice.index === 'number' && choice.index !== 0) {
        continue;
      }

      if (typeof choice.finish_reason === 'string') {
        this.finishReason = choice.finish_reason;
      }

      const delta = isRecord(choice.delta) ? choice.delta : undefined;
      if (!delta) {
        continue;
      }

      if (typeof delta.content === 'string') {
        this.text += delta.content;
      }
      if (typeof delta.reasoning === 'string') {
        this.reasoning += delta.reasoning;
      } else if (typeof delta.reasoning_content === 'string') {
        this.reasoning += delta.reasoning_content;
      }
      if (Array.isArray(delta.reasoning_details)) {
        this.reasoningDetails = delta.reasoning_details as JsonValue[];
      }

      const toolCallDeltas = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const toolCallDelta of toolCallDeltas) {
        this.addToolCall(toolCallDelta);
      }
    }
  }

  toCompletion(): Record<string, unknown> {
    const toolCalls = Array.from(this.toolCalls.values())
      .sort((a, b) => a.index - b.index)
      .filter((toolCall) => toolCall.id || toolCall.name || toolCall.argumentsText.length > 0)
      .map((toolCall) => ({
        id: toolCall.id ?? `call_${toolCall.index}`,
        type: 'function',
        function: {
          name: toolCall.name ?? '',
          arguments: toolCall.argumentsText,
        },
      }));

    return {
      id: this.id ?? '',
      ...(this.model === undefined ? {} : { model: this.model }),
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: this.text.length > 0 ? this.text : null,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
            ...(this.reasoning.length > 0 ? { reasoning: this.reasoning } : {}),
            ...(this.reasoningDetails === undefined ? {} : { reasoning_details: this.reasoningDetails }),
          },
          finish_reason: this.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
        },
      ],
      ...(this.usage === undefined ? {} : { usage: this.usage }),
      ...(this.cost === undefined ? {} : { cost: this.cost }),
    };
  }

  private addToolCall(value: unknown): void {
    if (!isRecord(value)) {
      return;
    }

    const index = typeof value.index === 'number' && Number.isInteger(value.index)
      ? value.index
      : this.nextToolCallIndex++;
    let toolCall = this.toolCalls.get(index);
    if (!toolCall) {
      toolCall = { index, argumentsText: '' };
      this.toolCalls.set(index, toolCall);
    }

    if (typeof value.id === 'string' && value.id.length > 0) {
      toolCall.id = value.id;
    }
    const fn = isRecord(value.function) ? value.function : undefined;
    if (!fn) {
      return;
    }
    if (typeof fn.name === 'string' && fn.name.length > 0) {
      toolCall.name = fn.name;
    }
    if (typeof fn.arguments === 'string') {
      toolCall.argumentsText += fn.arguments;
    }
  }
}

async function getMeshModelRate(
  client: MeshAPI,
  baseUrl: string,
  apiKey: string,
  model: string,
  signal: AbortSignal | undefined,
): Promise<MeshModelRate | undefined> {
  const cacheKey = meshModelRateCacheKey(baseUrl, apiKey);
  const now = Date.now();
  const cached = meshModelRateCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.ratesByModel.get(model);
  }

  let refresh = meshModelRateRefreshes.get(cacheKey);
  if (!refresh) {
    refresh = refreshMeshModelRates(client, signal);
    meshModelRateRefreshes.set(cacheKey, refresh);
    refresh.then(() => {
      if (meshModelRateRefreshes.get(cacheKey) === refresh) {
        meshModelRateRefreshes.delete(cacheKey);
      }
    }, () => {
      if (meshModelRateRefreshes.get(cacheKey) === refresh) {
        meshModelRateRefreshes.delete(cacheKey);
      }
    });
  }

  try {
    const entry = await refresh;
    meshModelRateCache.set(cacheKey, entry);
    return entry.ratesByModel.get(model);
  } catch {
    return cached?.ratesByModel.get(model);
  }
}

async function getMeshModelRateForCandidates(
  client: MeshAPI,
  baseUrl: string,
  apiKey: string,
  models: string[],
  signal: AbortSignal | undefined,
): Promise<MeshModelRate | undefined> {
  for (const model of models) {
    const rate = await getMeshModelRate(client, baseUrl, apiKey, model, signal);
    if (rate) {
      return rate;
    }
  }
  return undefined;
}

async function refreshMeshModelRates(
  client: MeshAPI,
  signal: AbortSignal | undefined,
): Promise<MeshModelRateCacheEntry> {
  const models = await client.models.list(undefined, { signal, timeoutMs: MESH_MODEL_PRICING_TIMEOUT_MS });
  const ratesByModel = new Map<string, MeshModelRate>();
  for (const model of models) {
    const rate = toMeshModelRate(model);
    if (rate) {
      ratesByModel.set(model.id, rate);
    }
  }
  return {
    ratesByModel,
    expiresAt: Date.now() + MESH_MODEL_RATE_CACHE_TTL_MS,
  };
}

function toMeshModelRate(model: ModelInfo): MeshModelRate | undefined {
  const promptUsdPer1k = readFiniteNumber(
    model.pricing.prompt_usd_per_1k_discounted,
    model.pricing.prompt_usd_per_1k,
  );
  const completionUsdPer1k = readFiniteNumber(
    model.pricing.completion_usd_per_1k_discounted,
    model.pricing.completion_usd_per_1k,
  );

  if (promptUsdPer1k === undefined || completionUsdPer1k === undefined) {
    if (model.is_free) {
      return { promptUsdPer1k: 0, completionUsdPer1k: 0 };
    }
    return undefined;
  }

  return { promptUsdPer1k, completionUsdPer1k };
}

function estimateCostFromRate(
  promptTokens: number,
  completionTokens: number,
  rate: MeshModelRate,
): number {
  return (promptTokens / 1000) * rate.promptUsdPer1k + (completionTokens / 1000) * rate.completionUsdPer1k;
}

function meshModelRateCacheKey(baseUrl: string, apiKey: string): string {
  return `${baseUrl.replace(/\/+$/, '')}|${apiKeyFingerprint(apiKey)}`;
}

function apiKeyFingerprint(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 12);
}

function hasPositiveProviderReportedCost(completion: Record<string, unknown>): boolean {
  const usage = isRecord(completion.usage) ? completion.usage : undefined;
  const costDetails = usage && isRecord(usage.cost_details) ? usage.cost_details : undefined;

  const cost = readFiniteNumber(
    completion.estimated_cost_usd,
    completion.cost_usd,
    completion.total_cost_usd,
    completion.cost,
    completion.total_cost,
    usage?.estimated_cost_usd,
    usage?.cost_usd,
    usage?.total_cost_usd,
    usage?.cost,
    usage?.total_cost,
    costDetails?.upstream_inference_cost,
    sumFiniteNumbers(
      costDetails?.upstream_inference_prompt_cost,
      costDetails?.upstream_inference_completions_cost,
    ),
  );
  return cost !== undefined && cost > 0;
}

function sumFiniteNumbers(...values: unknown[]): number | undefined {
  let total = 0;
  let found = false;
  for (const value of values) {
    const parsed = readFiniteNumber(value);
    if (parsed === undefined) continue;
    total += parsed;
    found = true;
  }
  return found ? total : undefined;
}

function readFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value.replace(/^\$/, '').trim())
        : undefined;
    if (parsed !== undefined && Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
