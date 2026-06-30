import type { JsonSchema, StructuredOutputMode } from '../types.js';
import { BaseOpenAIChatAdapter, type BaseOpenAIChatAdapterConfig } from './base-openai-chat-adapter.js';

const OLLAMA_BASE_URL = 'http://localhost:11434/v1';

/**
 * JSON types used as a permissive fallback for schema nodes that declare no
 * `type` and no composition keyword (i.e. an open "any" schema such as `{}`).
 */
const ANY_JSON_TYPES = ['string', 'number', 'boolean', 'object', 'array', 'null'];

const SCHEMA_COMPOSITION_KEYS = ['type', 'anyOf', 'oneOf', 'allOf', '$ref', 'enum', 'const'];

// Sub-keys whose value is itself a schema node.
const SCHEMA_VALUE_KEYS = ['items', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains'];
// Sub-keys whose value is a map of named schema nodes.
const SCHEMA_MAP_KEYS = ['properties', 'patternProperties', '$defs', 'definitions'];
// Sub-keys whose value is an array of schema nodes.
const SCHEMA_LIST_KEYS = ['anyOf', 'oneOf', 'allOf', 'prefixItems'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursively ensures every JSON Schema node declares a `type` (or a
 * composition keyword). Ollama's tool-aware chat templates (notably gpt-oss)
 * render tool parameters with `index $prop.Type 0`, which panics with a 500
 * error when a property schema has an empty/absent type. Open "any" schemas
 * like `{}` are the common trigger, e.g. the delegate tool's `input` parameter.
 *
 * The walk is schema-aware: it only fills `type` on real schema nodes and
 * descends solely into keywords whose values are schemas, never into arbitrary
 * keyword values such as the `properties` map or the `required` array.
 */
function ensureSchemaTypes(schema: unknown): unknown {
  if (!isRecord(schema)) {
    return schema;
  }

  const next: Record<string, unknown> = { ...schema };

  for (const key of SCHEMA_VALUE_KEYS) {
    if (next[key] !== undefined) {
      next[key] = ensureSchemaTypes(next[key]);
    }
  }

  for (const key of SCHEMA_MAP_KEYS) {
    const value = next[key];
    if (isRecord(value)) {
      const mapped: Record<string, unknown> = {};
      for (const [name, entry] of Object.entries(value)) {
        mapped[name] = ensureSchemaTypes(entry);
      }
      next[key] = mapped;
    }
  }

  for (const key of SCHEMA_LIST_KEYS) {
    const value = next[key];
    if (Array.isArray(value)) {
      next[key] = value.map((entry) => ensureSchemaTypes(entry));
    }
  }

  const hasTypeOrComposition = SCHEMA_COMPOSITION_KEYS.some((key) => next[key] !== undefined);
  if (!hasTypeOrComposition) {
    next.type = [...ANY_JSON_TYPES];
  }

  return next;
}

export interface OllamaAdapterConfig {
  model: string;
  baseUrl?: string;
  maxConcurrentRequests?: number;
  structuredOutputMode?: StructuredOutputMode;
}

export class OllamaAdapter extends BaseOpenAIChatAdapter {
  constructor(config: OllamaAdapterConfig) {
    const baseConfig: BaseOpenAIChatAdapterConfig = {
      provider: 'ollama',
      model: config.model,
      baseUrl: config.baseUrl ?? OLLAMA_BASE_URL,
      maxConcurrentRequests: config.maxConcurrentRequests,
      structuredOutputMode: config.structuredOutputMode,
      capabilities: {
        toolCalling: true,
        jsonOutput: true,
        streaming: true,
        usage: true,
        imageInput: true,
      },
    };

    super(baseConfig);
  }

  protected override normalizeToolParameters(parameters: JsonSchema): JsonSchema {
    return ensureSchemaTypes(parameters) as JsonSchema;
  }
}
