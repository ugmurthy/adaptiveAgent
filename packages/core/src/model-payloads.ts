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

export function validateJsonValueAgainstSchema(
  value: JsonValue,
  schema: JsonSchema,
  path = 'input',
): string | undefined {
  return validateJsonSchemaValue(value, schema, path);
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

function validateJsonSchemaValue(value: JsonValue, schema: JsonSchema, path: string): string | undefined {
  const typeError = validateSchemaType(value, schema.type, path);
  if (typeError) {
    return typeError;
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => jsonValuesEqual(candidate, value))) {
    return `${path} must be one of ${JSON.stringify(schema.enum)}, not ${JSON.stringify(value)}`;
  }

  if (isJsonObject(value)) {
    const required = schema.required;
    if (Array.isArray(required)) {
      for (const key of required) {
        if (typeof key === 'string' && !(key in value)) {
          return `${path}.${key} is required`;
        }
      }
    }

    const properties = isRecord(schema.properties) ? schema.properties : undefined;
    if (properties) {
      for (const [key, propertySchema] of Object.entries(properties)) {
        if (!(key in value) || !isRecord(propertySchema)) {
          continue;
        }
        const nestedError = validateJsonSchemaValue(value[key] as JsonValue, propertySchema as JsonSchema, `${path}.${key}`);
        if (nestedError) {
          return nestedError;
        }
      }
    }

    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(properties ?? {}));
      const unknown = Object.keys(value).find((key) => !allowed.has(key));
      if (unknown) {
        return `${path}.${unknown} is not allowed`;
      }
    }

    if (isRecord(schema.additionalProperties)) {
      const properties = isRecord(schema.properties) ? schema.properties : {};
      for (const [key, childValue] of Object.entries(value)) {
        if (key in properties) {
          continue;
        }
        const nestedError = validateJsonSchemaValue(
          childValue as JsonValue,
          schema.additionalProperties as JsonSchema,
          `${path}.${key}`,
        );
        if (nestedError) {
          return nestedError;
        }
      }
    }
  }

  if (Array.isArray(value) && isRecord(schema.items)) {
    for (let index = 0; index < value.length; index += 1) {
      const nestedError = validateJsonSchemaValue(value[index] as JsonValue, schema.items as JsonSchema, `${path}[${index}]`);
      if (nestedError) {
        return nestedError;
      }
    }
  }

  return undefined;
}

function validateSchemaType(value: JsonValue, rawType: unknown, path: string): string | undefined {
  if (rawType === undefined) {
    return undefined;
  }

  const allowedTypes = Array.isArray(rawType) ? rawType : [rawType];
  if (!allowedTypes.every((entry) => typeof entry === 'string')) {
    return undefined;
  }

  if (allowedTypes.some((type) => jsonSchemaTypeMatches(value, type))) {
    return undefined;
  }

  const expected = allowedTypes.length === 1 ? `"${allowedTypes[0]}"` : JSON.stringify(allowedTypes);
  return `${path} must be ${expected}, not ${describeJsonType(value)}`;
}

function jsonSchemaTypeMatches(value: JsonValue, type: string): boolean {
  switch (type) {
    case 'array':
      return Array.isArray(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'null':
      return value === null;
    case 'number':
      return typeof value === 'number';
    case 'object':
      return isJsonObject(value);
    case 'string':
      return typeof value === 'string';
    default:
      return true;
  }
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
