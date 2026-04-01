import { BaseOpenAIChatAdapter, type BaseOpenAIChatAdapterConfig } from './base-openai-chat-adapter.js';

const OLLAMA_BASE_URL = 'http://localhost:11434/v1';

export interface OllamaAdapterConfig {
  model: string;
  baseUrl?: string;
}

export class OllamaAdapter extends BaseOpenAIChatAdapter {
  constructor(config: OllamaAdapterConfig) {
    const baseConfig: BaseOpenAIChatAdapterConfig = {
      provider: 'ollama',
      model: config.model,
      baseUrl: config.baseUrl ?? OLLAMA_BASE_URL,
      capabilities: {
        toolCalling: true,
        jsonOutput: true,
        streaming: true,
        usage: false,
      },
    };

    super(baseConfig);
  }
}
