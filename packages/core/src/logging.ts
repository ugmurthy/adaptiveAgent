import type {
  AgentRun,
  JsonObject,
  ModelContentPart,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  RunResult,
  ToolDefinition,
} from './types.js';

import { captureValueForLog, summarizeValueForLog } from './logger.js';

const textEncoder = new TextEncoder();

export function runLogBindings(run: Pick<AgentRun, 'id' | 'rootRunId' | 'parentRunId' | 'delegateName' | 'delegationDepth'>) {
  return {
    runId: run.id,
    rootRunId: run.rootRunId,
    parentRunId: run.parentRunId,
    delegateName: run.delegateName,
    delegationDepth: run.delegationDepth,
  };
}

export function summarizeModelRequestForLog(request: ModelRequest) {
  return {
    messageCount: request.messages.length,
    messages: request.messages.map(summarizeModelMessageForLog),
    toolNames: request.tools?.map((tool) => tool.name) ?? [],
    outputSchema: request.outputSchema ? summarizeValueForLog(request.outputSchema) : undefined,
    metadata: captureValueForLog(request.metadata),
    performance: modelRequestPerformanceMetrics(request),
  };
}

export function summarizeModelResponseForLog(response: ModelResponse) {
  return {
    finishReason: response.finishReason,
    providerResponseId: response.providerResponseId,
    rawProviderResponse: response.rawProviderResponse === undefined
      ? undefined
      : captureValueForLog(response.rawProviderResponse, { mode: 'full' }),
    summary: response.summary,
    toolCalls:
      response.toolCalls?.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
        input: summarizeValueForLog(toolCall.input),
      })) ?? [],
    text: response.text ? summarizeValueForLog(response.text) : undefined,
    structuredOutput:
      response.structuredOutput === undefined ? undefined : summarizeValueForLog(response.structuredOutput),
    usage: response.usage ? captureValueForLog(response.usage, { mode: 'full' }) : undefined,
    performance: modelResponsePerformanceMetrics(response),
  };
}

export function modelRequestPerformanceMetrics(request: ModelRequest): JsonObject {
  const requestPayload = {
    messages: request.messages,
    tools: request.tools,
    outputSchema: request.outputSchema,
    metadata: request.metadata,
  };

  return compactJsonObject({
    messageCount: request.messages.length,
    toolCount: request.tools?.length ?? 0,
    requestBytes: approximateSerializedByteLength(requestPayload),
    messageBytes: approximateSerializedByteLength(request.messages),
    toolDefinitionBytes: request.tools ? approximateSerializedByteLength(request.tools) : 0,
    outputSchemaBytes: request.outputSchema ? approximateSerializedByteLength(request.outputSchema) : 0,
  });
}

export function modelResponsePerformanceMetrics(response: ModelResponse): JsonObject {
  const metrics = compactJsonObject({
    responseBytes: approximateSerializedByteLength({
      text: response.text,
      structuredOutput: response.structuredOutput,
      toolCalls: response.toolCalls,
      finishReason: response.finishReason,
      usage: response.usage,
      providerResponseId: response.providerResponseId,
      summary: response.summary,
      reasoning: response.reasoning,
      reasoningDetails: response.reasoningDetails,
    }),
    textBytes: response.text === undefined ? 0 : encodedByteLength(response.text),
    structuredOutputBytes: response.structuredOutput === undefined ? 0 : approximateSerializedByteLength(response.structuredOutput),
    toolCallCount: response.toolCalls?.length ?? 0,
    toolCallInputBytes: response.toolCalls ? approximateSerializedByteLength(response.toolCalls.map((toolCall) => toolCall.input)) : 0,
    reasoningBytes: response.reasoning === undefined ? 0 : encodedByteLength(response.reasoning),
  });

  if (isJsonObject(response.performance)) {
    metrics.adapter = response.performance;
  }

  return metrics;
}

export function approximateSerializedByteLength(value: unknown): number {
  const serialized = safeJsonStringify(value);
  return serialized === undefined ? 0 : encodedByteLength(serialized);
}

export function encodedByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

export function compactJsonObject(values: Record<string, unknown>): JsonObject {
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      continue;
    }

    if (isJsonValue(value)) {
      result[key] = value;
    }
  }
  return result;
}

export function captureToolInputForLog(tool: ToolDefinition, input: unknown, fallbackMode: 'full' | 'summary' | 'none') {
  return captureValueForLog(input, {
    mode: tool.capture ?? fallbackMode,
    redactPaths: tool.redact?.inputPaths,
  });
}

export function captureToolOutputForLog(tool: ToolDefinition, output: unknown, fallbackMode: 'full' | 'summary' | 'none') {
  const mode = tool.capture ?? fallbackMode;
  const logValue = mode === 'summary' && tool.summarizeResult ? tool.summarizeResult(output as never) : output;
  return captureValueForLog(logValue, {
    mode,
    redactPaths: tool.redact?.outputPaths,
  });
}

export function summarizeRunResultForLog(result: RunResult) {
  switch (result.status) {
    case 'success':
      return {
        status: result.status,
        output: summarizeValueForLog(result.output),
        stepsUsed: result.stepsUsed,
        usage: captureValueForLog(result.usage, { mode: 'full' }),
      };
    case 'failure':
      return {
        status: result.status,
        error: result.error,
        code: result.code,
        stepsUsed: result.stepsUsed,
        usage: captureValueForLog(result.usage, { mode: 'full' }),
      };
    default:
      return captureValueForLog(result, { mode: 'summary' });
  }
}

function summarizeModelMessageForLog(message: ModelMessage) {
  return {
    role: message.role,
    name: message.name,
    toolCallId: message.toolCallId,
    content: summarizeModelMessageContentForLog(message.content),
    toolCalls: message.toolCalls?.map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.name,
      input: summarizeValueForLog(toolCall.input),
    })),
  };
}

function summarizeModelMessageContentForLog(content: ModelMessage['content']) {
  if (typeof content === 'string') {
    return summarizeValueForLog(content);
  }

  return content.map((part) => summarizeModelContentPartForLog(part));
}

function summarizeModelContentPartForLog(part: ModelContentPart) {
  if (part.type === 'text') {
    return {
      type: part.type,
      text: summarizeValueForLog(part.text),
    };
  }

  if (part.type === 'file') {
    return {
      type: part.type,
      file: {
        source: summarizeInputSourceForLog(part.file.source),
        mimeType: part.file.mimeType,
        name: part.file.name,
      },
    };
  }

  if (part.type === 'audio') {
    return {
      type: part.type,
      audio: {
        source: summarizeInputSourceForLog(part.audio.source),
        mimeType: part.audio.mimeType,
        format: part.audio.format,
        name: part.audio.name,
      },
    };
  }

  return {
    type: part.type,
    image: {
      path: part.image.path,
      mimeType: part.image.mimeType,
      detail: part.image.detail,
      name: part.image.name,
    },
  };
}

function summarizeInputSourceForLog(source: { kind: string; path?: string; url?: string; fileId?: string }) {
  return {
    kind: source.kind,
    path: source.path,
    url: source.url,
    fileId: source.fileId,
  };
}

function safeJsonStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonObject[keyof JsonObject] {
  if (value === null) {
    return true;
  }

  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return Number.isFinite(value) || typeof value !== 'number';
    case 'object':
      if (Array.isArray(value)) {
        return value.every(isJsonValue);
      }

      return Object.values(value).every(isJsonValue);
    default:
      return false;
  }
}
