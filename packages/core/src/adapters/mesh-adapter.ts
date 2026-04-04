import { BaseOpenAIChatAdapter, type BaseOpenAIChatAdapterConfig } from './base-openai-chat-adapter.js';

const MESH_BASE_URL = 'https://api.meshapi.ai/v1';

export interface MeshAdapterConfig {
  model: string;
  apiKey: string;
  baseUrl?: string;
}

export class MeshAdapter extends BaseOpenAIChatAdapter {
  constructor(config: MeshAdapterConfig) {
    const baseConfig: BaseOpenAIChatAdapterConfig = {
      provider: 'mesh',
      model: config.model,
      baseUrl: config.baseUrl ?? MESH_BASE_URL,
      apiKey: config.apiKey,
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
