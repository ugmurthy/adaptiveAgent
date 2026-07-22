import { createInterface } from 'node:readline';

import {
  DESKTOP_PROTOCOL_VERSION,
  DesktopProtocolError,
  commandIdFromUnknownLine,
  parseDesktopCommand,
  type DesktopMessage,
} from './protocol.js';
import { DesktopRuntime } from './runtime.js';

let writeChain = Promise.resolve();

function writeMessage(message: DesktopMessage): void {
  const line = `${JSON.stringify(message)}\n`;
  writeChain = writeChain.then(async () => {
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(line, (error) => error ? reject(error) : resolve());
    });
  }).catch((error: unknown) => {
    process.stderr.write(`agent-runtime protocol write failed: ${safeErrorMessage(error)}\n`);
  });
}

const runtime = new DesktopRuntime(writeMessage);
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
  const fallbackId = commandIdFromUnknownLine(line);
  try {
    if (shuttingDown) throw new DesktopProtocolError('SHUTTING_DOWN', 'The runtime is shutting down.');
    const command = parseDesktopCommand(line);
    if (command.type === 'runtime.shutdown') {
      shuttingDown = true;
      forceExitAfterDeadline();
      await Promise.allSettled([...active]);
    }
    const result = await runtime.handle(command);
    writeMessage({ version: DESKTOP_PROTOCOL_VERSION, id: command.id, type: 'response', ok: true, result });
    if (command.type === 'runtime.shutdown') {
      lines.close();
    }
  } catch (error) {
    writeMessage({
      version: DESKTOP_PROTOCOL_VERSION,
      id: fallbackId,
      type: 'response',
      ok: false,
      error: {
        code: error instanceof DesktopProtocolError ? error.code : 'RUNTIME_ERROR',
        message: safeErrorMessage(error),
      },
    });
  }
}

async function shutdownAfterInputClosed(): Promise<void> {
  shuttingDown = true;
  forceExitAfterDeadline();
  await Promise.allSettled([...active]);
  await closeRuntime();
}

async function shutdownWithDeadline(): Promise<void> {
  shuttingDown = true;
  forceExitAfterDeadline();
  lines.close();
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

function forceExitAfterDeadline(): void {
  const timer = setTimeout(() => process.exit(0), 2_000);
  timer.unref();
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
