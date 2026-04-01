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

export class BaseOpenAIChatAdapter implements ModelAdapter {
  readonly provider: string;
  readonly model: string;
  readonly capabilities: ModelCapabilities;

  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly defaultHeaders: Record<string, string>;

  constructor(config: BaseOpenAIChatAdapterConfig) {
    this.provider = config.provider;
    this.model = config.model;
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.defaultHeaders = config.defaultHeaders ?? {};
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...config.capabilities };
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const body = this.buildRequestBody(request);
    const headers = this.buildHeaders();
    const url = `${this.baseUrl}/chat/completions`;

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: request.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown error');
      throw new ModelRequestError(
        `${this.provider} API returned ${response.status}: ${errorText}`,
        response.status,
      );
    }

    const data = (await response.json()) as OpenAIChatCompletionResponse;
    return this.parseResponse(data);
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
  ) {
    super(message);
    this.name = 'ModelRequestError';
  }
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
    return JSON.parse(args) as JsonValue;
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
