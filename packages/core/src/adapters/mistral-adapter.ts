import { Mistral } from '@mistralai/mistralai';

import type { ModelRequest, ModelResponse } from '../types.js';
import { BaseOpenAIChatAdapter, type BaseOpenAIChatAdapterConfig } from './base-openai-chat-adapter.js';

const MISTRAL_BASE_URL = 'https://api.mistral.ai/v1';

export interface MistralAdapterConfig {
  model: string;
  apiKey: string;
  baseUrl?: string;
  maxConcurrentRequests?: number;
}

export class MistralAdapter extends BaseOpenAIChatAdapter {
  private readonly client: Mistral;

  constructor(config: MistralAdapterConfig) {
    const baseConfig: BaseOpenAIChatAdapterConfig = {
      provider: 'mistral',
      model: config.model,
      baseUrl: config.baseUrl ?? MISTRAL_BASE_URL,
      apiKey: config.apiKey,
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

    this.client = new Mistral({
      apiKey: config.apiKey,
      serverURL: toMistralSdkServerUrl(config.baseUrl ?? MISTRAL_BASE_URL),
      retryConfig: { strategy: 'none' },
    });
  }

  override async generate(request: ModelRequest): Promise<ModelResponse> {
    const body = await this.buildRequestBody(request);
    const completion = await this.client.chat.complete(toSdkRequest(body) as never, {
      signal: request.signal,
    } as never);

    return this.parseResponse(fromSdkResponse(completion));
  }
}

function toMistralSdkServerUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
}

function toSdkRequest(body: Record<string, unknown>): Record<string, unknown> {
  return {
    ...body,
    messages: Array.isArray(body.messages) ? body.messages.map(toSdkMessage) : body.messages,
    response_format: undefined,
    responseFormat: body.response_format,
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
  };
}
