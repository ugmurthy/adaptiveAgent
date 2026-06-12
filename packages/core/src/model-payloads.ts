import type { JsonObject, JsonSchema, JsonValue, ModelMessageContent, ModelTextContentPart } from './types.js';

export function assertValidOutputSchema(schema: unknown, path = 'outputSchema'): asserts schema is JsonSchema {
  const error = validateOutputSchema(schema, path);
  if (error) {
    throw new Error(error);
  }
}

export function validateOutputSchema(schema: unknown, path = 'outputSchema'): string | undefined {
  if (!isRecord(schema)) {
    return `${path} must be a JSON object, not ${describeJsonType(schema)}`;
  }

  if (schema.type !== undefined && schema.type !== 'object') {
    return `${path}.type must be "object" when present`;
  }

  if (schema.properties !== undefined && !isRecord(schema.properties)) {
    return `${path}.properties must be a JSON object, not ${describeJsonType(schema.properties)}`;
  }

  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) || schema.required.some((entry) => typeof entry !== 'string'))
  ) {
    return `${path}.required must be an array of strings`;
  }

  if (
    schema.additionalProperties !== undefined &&
    typeof schema.additionalProperties !== 'boolean' &&
    !isRecord(schema.additionalProperties)
  ) {
    return `${path}.additionalProperties must be a boolean or JSON schema object`;
  }

  if (
    schema.items !== undefined &&
    !isRecord(schema.items) &&
    !(Array.isArray(schema.items) && schema.items.every(isRecord))
  ) {
    return `${path}.items must be a JSON schema object or an array of JSON schema objects`;
  }

  return undefined;
}

export function toModelVisibleToolResultObject(output: JsonValue): JsonObject {
  if (isJsonObject(output)) {
    return output;
  }

  if (typeof output === 'string') {
    return {
      result: output,
      resultType: 'text',
    };
  }

  return { result: output };
}

export function normalizeToolResultContentForModel(content: ModelMessageContent): string {
  return JSON.stringify(toModelVisibleToolResultObject(readToolResultContent(content)));
}

function readToolResultContent(content: ModelMessageContent): JsonValue {
  if (typeof content === 'string') {
    const parsed = tryParseJsonValue(content);
    return parsed.ok ? parsed.value : content;
  }

  const text = content
    .filter((part): part is ModelTextContentPart => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
  return text;
}

function tryParseJsonValue(text: string): { ok: true; value: JsonValue } | { ok: false } {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isJsonValue(parsed) ? { ok: true, value: parsed } : { ok: false };
  } catch {
    return { ok: false };
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) {
    return true;
  }

  if (typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  if (isRecord(value)) {
    return Object.values(value).every(isJsonValue);
  }

  return false;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeJsonType(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  if (Array.isArray(value)) {
    return 'an array';
  }

  if (typeof value === 'object') {
    return 'an object';
  }

  if (typeof value === 'undefined') {
    return 'undefined';
  }

  return `a ${typeof value}`;
}
