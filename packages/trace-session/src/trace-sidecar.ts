#!/usr/bin/env bun

import { createTracePostgresPool, resolveTraceRuntimeTarget, UnsupportedTraceRuntimeError, type TraceConfigOptions } from './db.js';
import { PostgresTraceReader, SqliteTraceReader, TraceService } from './trace-session/reader.js';
import {
  JSON_RPC_ERROR_CODES,
  TRACE_SIDECAR_MAX_REQUEST_BYTES,
  TRACE_SIDECAR_MAX_RESPONSE_BYTES,
  TRACE_SIDECAR_QUERY_TIMEOUT_MS,
  TraceSidecarProtocolError,
  parseTraceSidecarRpcRequest,
  rpcIdFromUnknownLine,
  type JsonRpcId,
} from './sidecar/protocol.js';
import { TraceSidecarRuntime, type TraceSidecarPolicy } from './sidecar/runtime.js';

export { TraceSidecarRuntime } from './sidecar/runtime.js';
export type { TraceSidecarPolicy } from './sidecar/runtime.js';
export * from './sidecar/protocol.js';

interface SidecarOptions extends TraceConfigOptions, TraceSidecarPolicy {
  help: boolean;
}

const USAGE = `Usage: trace-session-sidecar [database options] [policy options]

Database options (trusted process startup only):
  --sqlite-path <path>       Exact runtime SQLite path (read-only inspection).
  --settings <path>          Agent settings used to select SQLite or PostgreSQL.
  --config <path>            PostgreSQL trace config.
  --database-url <url>       PostgreSQL connection string.
  --database-url-env <name>  Environment variable containing the connection string.
  --pgssl                    Enable PostgreSQL TLS.

Sensitive-data policy:
  --allow-messages           Allow clients to request persisted message context.
  --allow-reasoning          Allow reasoning; also enables messages.
  --allow-raw-tool-payloads  Allow clients to request timeline tool inputs and outputs.
  --help                     Show this help.`;

export async function main(argv = process.argv.slice(2)): Promise<void> {
  let service: TraceService | undefined;
  try {
    const options = parseSidecarArgs(argv);
    if (options.help) {
      process.stdout.write(`${USAGE}\n`);
      return;
    }
    const target = await resolveTraceRuntimeTarget(options);
    if (target.kind === 'memory') throw new UnsupportedTraceRuntimeError('memory');
    if (target.kind === 'sqlite') {
      service = new TraceService(new SqliteTraceReader(target.path));
    } else {
      const pool = createTracePostgresPool(target.config, { statementTimeoutMs: TRACE_SIDECAR_QUERY_TIMEOUT_MS });
      service = new TraceService(new PostgresTraceReader(pool, () => pool.end()));
    }

    await runStdioSidecar(service, target.kind, options);
  } catch (error) {
    process.stderr.write(`trace-session-sidecar failed: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  } finally {
    await service?.close().catch((error: unknown) => {
      process.stderr.write(`trace-session-sidecar shutdown failed: ${errorMessage(error)}\n`);
      process.exitCode = 1;
    });
  }
}

export function parseSidecarArgs(argv: string[]): SidecarOptions {
  const options: SidecarOptions = {
    allowMessages: false,
    allowReasoning: false,
    allowRawToolPayloads: false,
    help: false,
  };
  const backendSelectors = new Set<string>();
  const selectBackend = (flag: string): void => {
    if (backendSelectors.has(flag)) throw new Error(`${flag} cannot be repeated.`);
    backendSelectors.add(flag);
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    switch (arg) {
      case '--sqlite-path': selectBackend(arg); options.sqlitePath = requiredValue(arg, argv[++index]); break;
      case '--settings': selectBackend(arg); options.settingsPath = requiredValue(arg, argv[++index]); break;
      case '--config': selectBackend(arg); options.configPath = requiredValue(arg, argv[++index]); break;
      case '--database-url': selectBackend(arg); options.databaseUrl = requiredValue(arg, argv[++index]); break;
      case '--database-url-env': selectBackend(arg); options.databaseUrlEnv = requiredValue(arg, argv[++index]); break;
      case '--pgssl': options.ssl = true; break;
      case '--allow-messages': options.allowMessages = true; break;
      case '--allow-reasoning': options.allowReasoning = true; options.allowMessages = true; break;
      case '--allow-raw-tool-payloads': options.allowRawToolPayloads = true; break;
      case '--help':
      case '-h': options.help = true; break;
      default: throw new Error(`Unexpected argument: ${arg}\n\n${USAGE}`);
    }
  }
  if (backendSelectors.size > 1) throw new Error('Select exactly one backend source: --sqlite-path, --settings, --config, --database-url, or --database-url-env.');
  return options;
}

async function runStdioSidecar(service: TraceService, backendKind: 'sqlite' | 'postgres', policy: TraceSidecarPolicy): Promise<void> {
  const runtime = new TraceSidecarRuntime(service, backendKind, policy);
  let shuttingDown = false;
  let forceExitTimer: ReturnType<typeof setTimeout> | undefined;

  const write = async (message: unknown): Promise<void> => {
    let line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line, 'utf8') > TRACE_SIDECAR_MAX_RESPONSE_BYTES) {
      const id = responseId(message);
      line = `${JSON.stringify(errorResponse(id, new TraceSidecarProtocolError(
        'RESULT_TOO_LARGE',
        `Response exceeds the ${TRACE_SIDECAR_MAX_RESPONSE_BYTES}-byte limit.`,
        JSON_RPC_ERROR_CODES.resultTooLarge,
      )))}\n`;
    }
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(line, (error) => error ? reject(error) : resolve());
    });
  };

  const stopForSignal = (): void => {
    shuttingDown = true;
    process.stdin.destroy();
    forceExitTimer ??= setTimeout(() => process.exit(1), 5_000);
    forceExitTimer.unref();
  };
  process.once('SIGINT', stopForSignal);
  process.once('SIGTERM', stopForSignal);

  try {
    for await (const frame of readBoundedNdjsonFrames(process.stdin)) {
      if (frame.oversized) {
        await write(errorResponse(null, new TraceSidecarProtocolError(
          'INVALID_REQUEST',
          `Request exceeds the ${TRACE_SIDECAR_MAX_REQUEST_BYTES}-byte limit.`,
          JSON_RPC_ERROR_CODES.invalidRequest,
        )));
        continue;
      }
      const line = frame.line;
      if (!line.trim()) continue;
      const id = rpcIdFromUnknownLine(line);
      try {
        if (shuttingDown) throw new TraceSidecarProtocolError('SHUTTING_DOWN', 'The sidecar is shutting down.', JSON_RPC_ERROR_CODES.shuttingDown);
        const request = parseTraceSidecarRpcRequest(line);
        const result = await runtime.handle(request);
        await write({ jsonrpc: '2.0', id: request.id, result });
        if (request.method === 'shutdown') {
          shuttingDown = true;
          break;
        }
      } catch (error) {
        if (!(error instanceof TraceSidecarProtocolError)) process.stderr.write(`trace-session-sidecar query failed: ${errorMessage(error)}\n`);
        await write(errorResponse(id, error));
      }
    }
  } finally {
    if (forceExitTimer) clearTimeout(forceExitTimer);
    process.removeListener('SIGINT', stopForSignal);
    process.removeListener('SIGTERM', stopForSignal);
    process.stdin.pause();
  }
}

export async function* readBoundedNdjsonFrames(
  input: AsyncIterable<Uint8Array | string>,
  maxBytes = TRACE_SIDECAR_MAX_REQUEST_BYTES,
): AsyncGenerator<{ line: string; oversized: false } | { line: ''; oversized: true }> {
  let buffered = Buffer.alloc(0);
  let oversized = false;

  for await (const rawChunk of input) {
    const chunk = typeof rawChunk === 'string' ? Buffer.from(rawChunk) : Buffer.from(rawChunk);
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline === -1 ? chunk.length : newline;
      const segment = chunk.subarray(offset, end);
      if (!oversized) {
        if (buffered.length + segment.length > maxBytes) {
          oversized = true;
          buffered = Buffer.alloc(0);
        } else if (segment.length > 0) {
          buffered = Buffer.concat([buffered, segment]);
        }
      }
      if (newline === -1) break;
      if (oversized) {
        yield { line: '', oversized: true };
      } else {
        const line = buffered.at(-1) === 13 ? buffered.subarray(0, -1) : buffered;
        yield { line: line.toString('utf8'), oversized: false };
      }
      buffered = Buffer.alloc(0);
      oversized = false;
      offset = newline + 1;
    }
  }

  if (oversized) yield { line: '', oversized: true };
  else if (buffered.length > 0) yield { line: buffered.toString('utf8'), oversized: false };
}

function errorResponse(id: JsonRpcId | null, error: unknown): Record<string, unknown> {
  const protocolError = error instanceof TraceSidecarProtocolError ? error : undefined;
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: protocolError?.jsonRpcCode ?? JSON_RPC_ERROR_CODES.internalError,
      message: protocolError?.message ?? 'Trace query failed.',
      data: {
        protocolCode: protocolError?.code ?? 'TRACE_QUERY_FAILED',
        ...(protocolError?.data ? { details: protocolError.data } : {}),
      },
    },
  };
}

function responseId(value: unknown): JsonRpcId | null {
  if (!value || typeof value !== 'object') return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' || typeof id === 'number' && Number.isFinite(id) ? id : null;
}

function requiredValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) await main();
