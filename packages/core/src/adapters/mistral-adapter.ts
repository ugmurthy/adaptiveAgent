import { BaseOpenAIChatAdapter, type BaseOpenAIChatAdapterConfig } from './base-openai-chat-adapter.js';

const MISTRAL_BASE_URL = 'https://api.mistral.ai/v1';

export interface MistralAdapterConfig {
  model: string;
  apiKey: string;
  baseUrl?: string;
  maxConcurrentRequests?: number;
}

export class MistralAdapter extends BaseOpenAIChatAdapter {
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
      },
    };

    super(baseConfig);
  }
}
