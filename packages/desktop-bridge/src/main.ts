import { createInterface } from 'node:readline';

import { main as runAdaptiveAgentCli } from '@adaptive-agent/agent-sdk/src/adaptive-agent.js';

import { CLI_CHILD_MODE, ProcessCliExecutor } from './cli-executor.js';
import {
  JSON_RPC_ERROR_CODES,
  DesktopProtocolError,
  parseDesktopRpcRequest,
  rpcIdFromUnknownLine,
  type DesktopMessage,
  type JsonRpcErrorResponse,
  type JsonRpcId,
} from './protocol.js';
import { DesktopRuntime } from './runtime.js';

if (Bun.argv[2] === CLI_CHILD_MODE) {
  void runCliChild(Bun.argv.slice(3));
} else {
  runDesktopBridge();
}

async function runCliChild(argv: string[]): Promise<void> {
  try {
    process.exitCode = await runAdaptiveAgentCli(argv);
  } catch (error) {
    process.stderr.write(`${safeErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

function runDesktopBridge(): void {
  let writeChain = Promise.resolve();

  const writeMessage = (message: DesktopMessage): void => {
    const line = `${JSON.stringify(message)}\n`;
    writeChain = writeChain.then(async () => {
      await new Promise<void>((resolve, reject) => {
        process.stdout.write(line, (error) => error ? reject(error) : resolve());
      });
    }).catch((error: unknown) => {
      process.stderr.write(`agent-runtime protocol write failed: ${safeErrorMessage(error)}\n`);
    });
  };

  const cliExecutor = new ProcessCliExecutor(import.meta.path);
  const runtime = new DesktopRuntime(writeMessage, cliExecutor);
  const active = new Set<Promise<void>>();
  let shuttingDown = false;
  let closePromise: Promise<void> | undefined;

  writeMessage(runtime.readyMessage());

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    const operation = processLine(line);
    active.add(operation);
    void operation.finally(() => active.delete(operation));
  });

  lines.on('close', () => {
    void shutdownAfterInputClosed();
  });

  process.once('SIGINT', () => void shutdownWithDeadline());
  process.once('SIGTERM', () => void shutdownWithDeadline());

  async function processLine(line: string): Promise<void> {
    const rpcFallbackId = rpcIdFromUnknownLine(line);
    try {
      if (shuttingDown) {
        throw new DesktopProtocolError(
          'SHUTTING_DOWN',
          'The runtime is shutting down.',
          JSON_RPC_ERROR_CODES.shuttingDown,
        );
      }
      const request = parseDesktopRpcRequest(line);

      const isShutdown = request.method === 'runtime/shutdown';
      if (isShutdown) {
        const pending = [...active];
        shuttingDown = true;
        forceExitAfterDeadline();
        await cliExecutor.close();
        await Promise.allSettled(pending);
      }

      const result = await runtime.handleRpc(request);
      writeMessage({ jsonrpc: '2.0', id: request.id, result });

      if (isShutdown) lines.close();
    } catch (error) {
      writeMessage(jsonRpcError(rpcFallbackId, error));
    }
  }

  async function shutdownAfterInputClosed(): Promise<void> {
    shuttingDown = true;
    await Promise.allSettled([...active]);
    await cliExecutor.close();
    await closeRuntime();
  }

  async function shutdownWithDeadline(): Promise<void> {
    shuttingDown = true;
    forceExitAfterDeadline();
    lines.close();
    await cliExecutor.close();
    await Promise.allSettled([...active]);
    await closeRuntime();
  }

  async function closeRuntime(): Promise<void> {
    closePromise ??= (async () => {
      await runtime.close().catch((error: unknown) => {
        process.stderr.write(`agent-runtime shutdown failed: ${safeErrorMessage(error)}\n`);
      });
      await writeChain;
    })();
    await closePromise;
  }
}

function jsonRpcError(id: JsonRpcId | null, error: unknown): JsonRpcErrorResponse {
  const protocolError = error instanceof DesktopProtocolError ? error : undefined;
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: protocolError?.jsonRpcCode ?? JSON_RPC_ERROR_CODES.internalError,
      message: safeErrorMessage(error),
      data: {
        protocolCode: protocolError?.code ?? 'RUNTIME_ERROR',
        ...(protocolError?.data === undefined ? {} : { details: protocolError.data }),
      },
    },
  };
}

function forceExitAfterDeadline(): void {
  const timer = setTimeout(() => process.exit(0), 5_000);
  timer.unref();
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
