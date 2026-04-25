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
      },
    };

    super(baseConfig);
  }
}
