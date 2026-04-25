import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';

import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import pretty from 'pino-pretty';

import type { CaptureMode, JsonValue } from './types.js';

export type AdaptiveAgentLogger = Logger & { readonly filePath?: string };
export type AdaptiveAgentLogLevel = LoggerOptions['level'] | 'silent';
export type AdaptiveAgentLogDestination = 'console' | 'file' | 'both';
export const DEFAULT_LOG_LEVEL: AdaptiveAgentLogLevel = 'silent';
export const DEFAULT_LOG_DESTINATION: AdaptiveAgentLogDestination = 'console';

export interface AdaptiveAgentLoggerOptions {
  level?: AdaptiveAgentLogLevel;
  destination?: AdaptiveAgentLogDestination;
  filePath?: string;
  name?: string;
  pretty?: boolean;
}

export function createAdaptiveAgentLogger(options: AdaptiveAgentLoggerOptions = {}): AdaptiveAgentLogger {
  const destination = options.destination ?? DEFAULT_LOG_DESTINATION;
  const loggerOptions: LoggerOptions = {
    name: options.name ?? 'adaptive-agent',
    level: options.level ?? DEFAULT_LOG_LEVEL,
    base: undefined,
    serializers: {
      err: pino.stdSerializers.err,
    },
  };

  if (destination === 'console') {
    const consoleDestination = createConsoleDestination(options.pretty);
    return consoleDestination ? pino(loggerOptions, consoleDestination) : pino(loggerOptions);
  }

  const filePath = resolveLogFilePath(requireLogFilePath(options, destination));
  const fileDestination = createFileDestination(filePath);
  if (destination === 'file') {
    return attachFilePath(pino(loggerOptions, fileDestination), filePath);
  }

  return attachFilePath(
    pino(
      loggerOptions,
      pino.multistream([
        { stream: createConsoleStream(options.pretty) },
        { stream: fileDestination },
      ]),
    ),
    filePath,
  );
}

function createConsoleDestination(prettyEnabled: boolean | undefined): DestinationStream | undefined {
  return prettyEnabled === false ? undefined : createPrettyDestination();
}

function createConsoleStream(prettyEnabled: boolean | undefined): DestinationStream {
  return prettyEnabled === false ? pino.destination(1) : createPrettyDestination();
}

function createPrettyDestination(): DestinationStream {
  return pretty({
    colorize: true,
    ignore: 'pid,hostname',
    translateTime: 'HH:MM:ss.l',
    singleLine: false,
  });
}

function createFileDestination(filePath: string): DestinationStream {
  mkdirSync(dirname(filePath), { recursive: true });
  return pino.destination({ dest: filePath, sync: false });
}

function resolveLogFilePath(filePath: string, now = new Date()): string {
  const parsedPath = parse(filePath);
  const baseName = normalizeLogFileBaseName(parsedPath.name);
  const dateStamp = formatLogDate(now);
  const datedFileName = `${baseName}-${dateStamp}${parsedPath.ext}`;
  const datedFilePath = join(parsedPath.dir, datedFileName);

  if (!existsSync(datedFilePath)) {
    return datedFilePath;
  }

  let serial = 2;
  while (true) {
    const rotatedFilePath = join(parsedPath.dir, `${baseName}-${dateStamp}-${serial}${parsedPath.ext}`);
    if (!existsSync(rotatedFilePath)) {
      return rotatedFilePath;
    }

    serial += 1;
  }
}

function normalizeLogFileBaseName(fileName: string): string {
  const normalizedFileName = fileName.replace(/-\d{4}-\d{2}-\d{2}(?:-\d+)?$/, '');
  return normalizedFileName.length > 0 ? normalizedFileName : fileName;
}

function formatLogDate(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function attachFilePath(logger: Logger, filePath: string): AdaptiveAgentLogger {
  Object.defineProperty(logger, 'filePath', {
    value: filePath,
    enumerable: true,
    configurable: false,
    writable: false,
  });

  return logger as AdaptiveAgentLogger;
}

function requireLogFilePath(options: AdaptiveAgentLoggerOptions, destination: AdaptiveAgentLogDestination): string {
  if (!options.filePath) {
    throw new Error(`createAdaptiveAgentLogger() requires filePath when destination='${destination}'`);
  }

  return options.filePath;
}

export function captureValueForLog(
  value: unknown,
  options: {
    mode?: CaptureMode;
    redactPaths?: string[];
  } = {},
): JsonValue | undefined {
  const mode = options.mode ?? 'summary';
  if (mode === 'none' || value === undefined) {
    return undefined;
  }

  const normalized = normalizeUnknown(value);
  const redacted = applyRedactions(normalized, options.redactPaths ?? []);
  return mode === 'full' ? truncateValue(redacted) : summarizeValueForLog(redacted);
}

export function summarizeValueForLog(value: unknown): JsonValue {
  return summarizeJsonValue(normalizeUnknown(value));
}

export function errorForLog(error: unknown): JsonValue {
  if (error instanceof Error) {
    return truncateValue({
      name: error.name,
      message: error.message,
      stack: error.stack ?? null,
    });
  }

  return summarizeValueForLog(error);
}

function normalizeUnknown(value: unknown): JsonValue {
  if (value === undefined) {
    return null;
  }

  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack ?? null,
    };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeUnknown(entry));
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return Object.fromEntries(entries.map(([key, entry]) => [key, normalizeUnknown(entry)]));
  }

  if (typeof value === 'function') {
    return `[Function ${(value as Function).name || 'anonymous'}]`;
  }

  return String(value);
}

function applyRedactions(value: JsonValue, redactPaths: string[]): JsonValue {
  if (redactPaths.length === 0) {
    return structuredClone(value);
  }

  const clone = structuredClone(value);
  for (const path of redactPaths) {
    const segments = path.split('.').filter(Boolean);
    if (segments.length === 0) {
      continue;
    }

    redactPath(clone, segments);
  }

  return clone;
}

function redactPath(current: JsonValue, segments: string[]): void {
  if (segments.length === 0 || current === null || typeof current !== 'object') {
    return;
  }

  const [head, ...tail] = segments;

  if (Array.isArray(current)) {
    const index = Number.parseInt(head, 10);
    if (Number.isNaN(index) || index < 0 || index >= current.length) {
      return;
    }

    if (tail.length === 0) {
      current[index] = '[REDACTED]';
      return;
    }

    redactPath(current[index], tail);
    return;
  }

  if (!(head in current)) {
    return;
  }

  if (tail.length === 0) {
    current[head] = '[REDACTED]';
    return;
  }

  redactPath(current[head], tail);
}

function truncateValue(value: JsonValue, depth = 0): JsonValue {
  if (typeof value === 'string') {
    return value.length > 2_000 ? `${value.slice(0, 2_000)}...(${value.length} chars)` : value;
  }

  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (depth >= 6) {
    return summarizeJsonValue(value);
  }

  if (Array.isArray(value)) {
    const items = value.slice(0, 25).map((entry) => truncateValue(entry, depth + 1));
    if (value.length > 25) {
      items.push(`...(${value.length - 25} more items)`);
    }
    return items;
  }

  const entries = Object.entries(value);
  const next: Record<string, JsonValue> = {};
  for (const [key, entry] of entries.slice(0, 40)) {
    next[key] = truncateValue(entry, depth + 1);
  }
  if (entries.length > 40) {
    next.__truncated__ = `${entries.length - 40} more keys`;
  }
  return next;
}

function summarizeJsonValue(value: JsonValue, depth = 0): JsonValue {
  if (typeof value === 'string') {
    return value.length > 200
      ? {
          type: 'string',
          length: value.length,
          preview: `${value.slice(0, 200)}...`,
        }
      : value;
  }

  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
      items: value.slice(0, 5).map((entry) => summarizeJsonValue(entry, depth + 1)),
    };
  }

  const entries = Object.entries(value);
  if (depth >= 3) {
    return {
      type: 'object',
      keys: entries.map(([key]) => key).slice(0, 10),
      keyCount: entries.length,
    };
  }

  const preview: Record<string, JsonValue> = {};
  for (const [key, entry] of entries.slice(0, 8)) {
    preview[key] = summarizeJsonValue(entry, depth + 1);
  }

  return {
    type: 'object',
    keyCount: entries.length,
    preview,
  };
}
