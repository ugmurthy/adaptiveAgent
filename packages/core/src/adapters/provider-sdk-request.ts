function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toProviderSdkJsonSchema(jsonSchema: Record<string, unknown>): Record<string, unknown> {
  const schema = jsonSchema.schema;
  const schemaDefinition = jsonSchema.schemaDefinition;

  return {
    ...jsonSchema,
    ...(schema !== undefined && schemaDefinition === undefined
      ? { schemaDefinition: schema }
      : {}),
  };
}

export function toProviderSdkResponseFormat(
  responseFormat: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(responseFormat)) {
    return undefined;
  }

  const { json_schema, ...rest } = responseFormat;
  return isRecord(json_schema)
    ? {
        ...rest,
        jsonSchema: toProviderSdkJsonSchema(json_schema),
      }
    : {
        ...rest,
      };
}
