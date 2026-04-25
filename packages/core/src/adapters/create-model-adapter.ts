import type { ModelAdapter } from '../types.js';
import { MeshAdapter } from './mesh-adapter.js';
import { MistralAdapter } from './mistral-adapter.js';
import { OllamaAdapter } from './ollama-adapter.js';
import { OpenRouterAdapter } from './openrouter-adapter.js';

export interface ModelAdapterConfig {
  provider: 'openrouter' | 'ollama' | 'mistral' | 'mesh';
  model: string;
  apiKey?: string;
  baseUrl?: string;
  siteUrl?: string;
  siteName?: string;
  maxConcurrentRequests?: number;
}

export function createModelAdapter(config: ModelAdapterConfig): ModelAdapter {
  switch (config.provider) {
    case 'openrouter': {
      if (!config.apiKey) {
        throw new Error('OpenRouter requires an apiKey');
      }

      return new OpenRouterAdapter({
        model: config.model,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        siteUrl: config.siteUrl,
        siteName: config.siteName,
        maxConcurrentRequests: config.maxConcurrentRequests,
      });
    }

    case 'ollama':
      return new OllamaAdapter({
        model: config.model,
        baseUrl: config.baseUrl,
        maxConcurrentRequests: config.maxConcurrentRequests,
      });

    case 'mistral': {
      if (!config.apiKey) {
        throw new Error('Mistral requires an apiKey');
      }

      return new MistralAdapter({
        model: config.model,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        maxConcurrentRequests: config.maxConcurrentRequests,
      });
    }

    case 'mesh': {
      if (!config.apiKey) {
        throw new Error('Mesh requires an apiKey');
      }

      return new MeshAdapter({
        model: config.model,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        maxConcurrentRequests: config.maxConcurrentRequests,
      });
    }

    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}
