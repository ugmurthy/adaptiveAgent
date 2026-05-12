import { OpenRouter } from '@openrouter/sdk';

import type { ModelRequest, ModelResponse } from '../types.js';
import { BaseOpenAIChatAdapter, type BaseOpenAIChatAdapterConfig } from './base-openai-chat-adapter.js';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

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
    const body = await this.buildRequestBody(request);
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
    responseFormat: body.response_format,
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
  return {
    ...data,
    image_url: undefined,
    imageUrl: data.image_url,
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
    completion_tokens_details: data.completionTokensDetails,
  };
}
