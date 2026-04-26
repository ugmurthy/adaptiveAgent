import type {
  JsonSchema,
  JsonValue,
  ModelAdapter,
  ModelCapabilities,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ModelToolCall,
  ToolDefinition,
  UsageSummary,
} from '../types.js';

export interface BaseOpenAIChatAdapterConfig {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  defaultHeaders?: Record<string, string>;
  capabilities?: Partial<ModelCapabilities>;
  maxConcurrentRequests?: number;
}

export type ModelInvocationPhase = 'gate_wait' | 'http_request' | 'http_status' | 'response_body' | 'retry_backoff';

export interface ModelInvocationDiagnostics {
  modelInvocationPhase?: ModelInvocationPhase;
  modelInvocationAttempt?: number;
  modelInvocationStatusCode?: number;
  modelInvocationRetryDelayMs?: number;
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
  };
}

interface OpenAIChatCompletionResponse {
  id: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter';
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  toolCalling: true,
  jsonOutput: true,
  streaming: false,
  usage: true,
};

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const DEFAULT_MAX_RETRIES = 2;
const INITIAL_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 8_000;
// Keep the local process from stampeding the same upstream/model when future
// parallel sub-agents begin issuing requests concurrently without forcing the
// whole process through a single in-flight request per model.
const DEFAULT_MAX_CONCURRENT_REQUESTS_PER_MODEL = 4;

const modelRequestGates = new Map<string, ModelRequestGate>();

interface GateWaiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

class ModelRequestGate {
  private maxConcurrentRequests: number;
  private activeCount = 0;
  private cooldownUntil = 0;
  private readonly waiters: GateWaiter[] = [];
  private drainTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(maxConcurrentRequests: number) {
    this.maxConcurrentRequests = maxConcurrentRequests;
  }

  setMaxConcurrentRequests(maxConcurrentRequests: number): void {
    if (maxConcurrentRequests > this.maxConcurrentRequests) {
      this.maxConcurrentRequests = maxConcurrentRequests;
      this.drain();
    }
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(createAbortError(signal.reason));
        return;
      }

      const waiter: GateWaiter = { resolve, reject, signal };
      waiter.onAbort = () => {
        this.removeWaiter(waiter);
        reject(createAbortError(signal.reason));
      };

      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiters.push(waiter);
      this.drain();
    });
  }

  imposeCooldown(delayMs: number): void {
    if (delayMs <= 0) {
      return;
    }

    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + delayMs);
    this.scheduleDrain();
  }

  private drain(): void {
    if (this.activeCount >= this.maxConcurrentRequests) {
      return;
    }

    const remainingCooldownMs = this.cooldownUntil - Date.now();
    if (remainingCooldownMs > 0) {
      this.scheduleDrain(remainingCooldownMs);
      return;
    }

    this.clearDrainTimer();

    while (this.activeCount < this.maxConcurrentRequests) {
      const waiter = this.waiters.shift();
      if (!waiter) {
        return;
      }

      waiter.signal?.removeEventListener('abort', waiter.onAbort!);
      if (waiter.signal?.aborted) {
        continue;
      }

      this.activeCount += 1;
      let released = false;
      waiter.resolve(() => {
        if (released) {
          return;
        }

        released = true;
        this.activeCount = Math.max(0, this.activeCount - 1);
        this.drain();
      });
    }
  }

  private removeWaiter(waiter: GateWaiter): void {
    waiter.signal?.removeEventListener('abort', waiter.onAbort!);
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) {
      this.waiters.splice(index, 1);
    }
  }

  private scheduleDrain(delayMs = Math.max(0, this.cooldownUntil - Date.now())): void {
    this.clearDrainTimer();
    this.drainTimer = setTimeout(() => {
      this.drainTimer = undefined;
      this.drain();
    }, Math.max(0, delayMs));
  }

  private clearDrainTimer(): void {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = undefined;
    }
  }
}

export class BaseOpenAIChatAdapter implements ModelAdapter {
  readonly provider: string;
  readonly model: string;
  readonly capabilities: ModelCapabilities;

  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly defaultHeaders: Record<string, string>;
  private readonly requestGate: ModelRequestGate;

  constructor(config: BaseOpenAIChatAdapterConfig) {
    this.provider = config.provider;
    this.model = config.model;
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.defaultHeaders = config.defaultHeaders ?? {};
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...config.capabilities };
    this.requestGate = getOrCreateModelRequestGate(
      this.provider,
      this.model,
      normalizeMaxConcurrentRequests(config.maxConcurrentRequests),
    );
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const body = this.buildRequestBody(request);
    const headers = this.buildHeaders();
    const url = `${this.baseUrl}/chat/completions`;

    let attempt = 0;
    while (true) {
      let retryDelayMs: number | undefined;
      let release: (() => void) | undefined;
      try {
        release = await this.requestGate.acquire(request.signal);
      } catch (error) {
        throw withModelInvocationDiagnostics(error, {
          modelInvocationPhase: 'gate_wait',
          modelInvocationAttempt: attempt + 1,
        });
      }
      try {
        let response: Response;
        try {
          response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: request.signal,
          });
        } catch (error) {
          throw withModelInvocationDiagnostics(error, {
            modelInvocationPhase: 'http_request',
            modelInvocationAttempt: attempt + 1,
          });
        }

        if (!response.ok) {
          throw withModelInvocationDiagnostics(await toModelRequestError(this.provider, response), {
            modelInvocationPhase: 'http_status',
            modelInvocationAttempt: attempt + 1,
            modelInvocationStatusCode: response.status,
          });
        }

        let data: OpenAIChatCompletionResponse;
        try {
          data = (await response.json()) as OpenAIChatCompletionResponse;
        } catch (error) {
          throw withModelInvocationDiagnostics(error, {
            modelInvocationPhase: 'response_body',
            modelInvocationAttempt: attempt + 1,
            modelInvocationStatusCode: response.status,
          });
        }
        return this.parseResponse(data);
      } catch (error) {
        retryDelayMs = getRetryDelayMs(error, attempt);
        if (retryDelayMs === undefined || isAbortError(error) || request.signal?.aborted) {
          throw error;
        }

        this.requestGate.imposeCooldown(retryDelayMs);
      } finally {
        release?.();
      }

      try {
        await sleepWithSignal(retryDelayMs, request.signal);
      } catch (error) {
        throw withModelInvocationDiagnostics(error, {
          modelInvocationPhase: 'retry_backoff',
          modelInvocationAttempt: attempt + 1,
          modelInvocationRetryDelayMs: retryDelayMs,
        });
      }
      attempt += 1;
    }
  }

  protected buildRequestBody(
    request: ModelRequest,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: request.messages.map((msg) => toOpenAIMessage(msg)),
    };

    if (request.tools && request.tools.length > 0 && this.capabilities.toolCalling) {
      body.tools = request.tools.map((tool) => toOpenAITool(tool));
    }

    if (request.outputSchema && this.capabilities.jsonOutput) {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: 'response',
          strict: true,
          schema: request.outputSchema,
        },
      };
    }

    return body;
  }

  protected buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.defaultHeaders,
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    return headers;
  }

  protected parseResponse(data: OpenAIChatCompletionResponse): ModelResponse {
    const choice = data.choices[0];
    if (!choice) {
      return {
        finishReason: 'error',
      };
    }

    const toolCalls = choice.message.tool_calls?.map(
      (tc): ModelToolCall => ({
        id: tc.id,
        name: tc.function.name,
        input: parseToolArguments(tc.function.arguments),
      }),
    );

    const text = choice.message.content ?? undefined;
    const structuredOutput = text ? tryParseJson(text) : undefined;

    const finishReason = mapFinishReason(choice.finish_reason);

    const usage: UsageSummary | undefined = data.usage
      ? {
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens,
          estimatedCostUSD: 0,
          provider: this.provider,
          model: this.model,
        }
      : undefined;

    return {
      text,
      structuredOutput,
      toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      finishReason,
      usage,
      providerResponseId: data.id,
    };
  }
}

export class ModelRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ModelRequestError';
  }
}

async function toModelRequestError(provider: string, response: Response): Promise<ModelRequestError> {
  const errorText = await response.text().catch(() => 'unknown error');
  return new ModelRequestError(
    `${provider} API returned ${response.status}: ${errorText}`,
    response.status,
    parseRetryAfterMs(response.headers.get('Retry-After')),
  );
}

function getRetryDelayMs(error: unknown, attempt: number): number | undefined {
  if (!(error instanceof ModelRequestError)) {
    return undefined;
  }

  if (!RETRYABLE_STATUS_CODES.has(error.statusCode) || attempt >= DEFAULT_MAX_RETRIES) {
    return undefined;
  }

  if (error.retryAfterMs !== undefined) {
    return Math.max(0, error.retryAfterMs);
  }

  const cappedDelayMs = Math.min(MAX_RETRY_DELAY_MS, INITIAL_RETRY_DELAY_MS * 2 ** attempt);
  return Math.random() * cappedDelayMs;
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }

  const retryAt = Date.parse(value);
  if (Number.isNaN(retryAt)) {
    return undefined;
  }

  return Math.max(0, retryAt - Date.now());
}

function sleepWithSignal(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) {
    if (signal?.aborted) {
      throw createAbortError(signal.reason);
    }

    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError(signal.reason));
      return;
    }

    const timeoutId = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);

    const onAbort = () => {
      clearTimeout(timeoutId);
      cleanup();
      reject(createAbortError(signal?.reason));
    };

    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function createAbortError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }

  return new DOMException(typeof reason === 'string' ? reason : 'The operation was aborted.', 'AbortError');
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function withModelInvocationDiagnostics(error: unknown, diagnostics: ModelInvocationDiagnostics): Error {
  const normalizedError = error instanceof Error ? error : new Error(String(error));
  Object.assign(normalizedError, diagnostics);
  return normalizedError;
}

function getOrCreateModelRequestGate(provider: string, model: string, maxConcurrentRequests: number): ModelRequestGate {
  const key = `${provider}\u0000${model}`;
  let gate = modelRequestGates.get(key);
  if (!gate) {
    gate = new ModelRequestGate(maxConcurrentRequests);
    modelRequestGates.set(key, gate);
    return gate;
  }

  gate.setMaxConcurrentRequests(maxConcurrentRequests);
  return gate;
}

function normalizeMaxConcurrentRequests(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_MAX_CONCURRENT_REQUESTS_PER_MODEL;
  }

  if (!Number.isInteger(value) || value < 1) {
    throw new Error('maxConcurrentRequests must be an integer >= 1');
  }

  return value;
}

function toOpenAIMessage(msg: ModelMessage): OpenAIMessage {
  if (msg.role === 'tool') {
    return {
      role: 'tool',
      content: msg.content,
      tool_call_id: msg.toolCallId ?? '',
    };
  }

  if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: msg.content.length > 0 ? msg.content : null,
      name: msg.name,
      tool_calls: msg.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: 'function',
        function: {
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.input),
        },
      })),
    };
  }

  return {
    role: msg.role,
    content: msg.content,
    name: msg.name,
  };
}

function toOpenAITool(
  tool: Pick<ToolDefinition, 'name' | 'description' | 'inputSchema'>,
): OpenAITool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

function parseToolArguments(args: string): JsonValue {
  try {
    let parsed = JSON.parse(args) as JsonValue;
    // Some models double-serialize tool arguments as a JSON string.
    // Unwrap one level if the result is a string that parses to an object.
    if (typeof parsed === 'string') {
      try {
        const inner = JSON.parse(parsed);
        if (typeof inner === 'object' && inner !== null) {
          parsed = inner as JsonValue;
        }
      } catch {
        // not double-encoded — keep the string
      }
    }
    return parsed;
  } catch {
    return args;
  }
}

function tryParseJson(text: string): JsonValue | undefined {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as JsonValue;
    }
  } catch {
    // not JSON — that's fine, return undefined
  }

  return undefined;
}

function mapFinishReason(
  reason: string,
): ModelResponse['finishReason'] {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'tool_calls':
      return 'tool_calls';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'error';
  }
}
