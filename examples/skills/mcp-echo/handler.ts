import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { JsonValue, ToolContext } from '../../../packages/core/src/types.js';

export const name = 'mcp_echo';
export const description = 'Send a message to the demo MCP echo service.';
export const inputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['message'],
  properties: {
    message: {
      type: 'string',
      description: 'The message to send to the MCP echo service.',
    },
  },
} as const;
export const outputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'server'],
  properties: {
    reply: { type: 'string' },
    server: { type: 'string' },
  },
} as const;

interface McpResponse {
  jsonrpc: '2.0';
  id?: number;
  result?: JsonValue;
  error?: {
    code: number;
    message: string;
  };
}

class ContentLengthMessageReader {
  private buffer = '';
  private readonly pending = new Map<number, {
    resolve(value: McpResponse): void;
    reject(error: Error): void;
  }>();

  push(chunk: string): void {
    this.buffer += chunk;

    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        return;
      }

      const header = this.buffer.slice(0, headerEnd);
      const lengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
      if (!lengthMatch) {
        throw new Error('MCP response missing Content-Length header');
      }

      const contentLength = Number(lengthMatch[1]);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;
      if (this.buffer.length < messageEnd) {
        return;
      }

      const payload = this.buffer.slice(messageStart, messageEnd);
      this.buffer = this.buffer.slice(messageEnd);

      const message = JSON.parse(payload) as McpResponse;
      if (typeof message.id === 'number') {
        const pending = this.pending.get(message.id);
        if (pending) {
          this.pending.delete(message.id);
          pending.resolve(message);
        }
      }
    }
  }

  waitFor(id: number): Promise<McpResponse> {
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function encodeMessage(message: object): string {
  const json = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
}

async function sendRequest(
  reader: ContentLengthMessageReader,
  stdin: NodeJS.WritableStream,
  message: Record<string, JsonValue>,
): Promise<McpResponse> {
  const id = Number(message.id);
  const responsePromise = reader.waitFor(id);
  stdin.write(encodeMessage(message));
  return responsePromise;
}

export async function execute(
  input: { message: string },
  context: ToolContext,
): Promise<{ reply: string; server: string }> {
  const serverPath = fileURLToPath(new URL('./mcp-server.ts', import.meta.url));
  const child = spawn('bun', [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const reader = new ContentLengthMessageReader();

  const abortHandler = () => {
    child.kill('SIGTERM');
  };
  context.signal.addEventListener('abort', abortHandler, { once: true });

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    reader.push(chunk);
  });

  child.stderr.setEncoding('utf8');
  let stderr = '';
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  child.on('error', (error) => {
    reader.rejectAll(error instanceof Error ? error : new Error(String(error)));
  });

  child.on('exit', (code, signal) => {
    if (reader) {
      const reason = stderr.trim() || `MCP server exited with code ${code ?? 'null'} signal ${signal ?? 'null'}`;
      reader.rejectAll(new Error(reason));
    }
  });

  try {
    const initializeResponse = await sendRequest(reader, child.stdin, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'adaptive-agent-skill-handler',
          version: '0.1.0',
        },
      },
    });

    if (initializeResponse.error) {
      throw new Error(`MCP initialize failed: ${initializeResponse.error.message}`);
    }

    const toolResponse = await sendRequest(reader, child.stdin, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'echo',
        arguments: {
          message: input.message,
        },
      },
    });

    if (toolResponse.error) {
      throw new Error(`MCP tools/call failed: ${toolResponse.error.message}`);
    }

    const result = toolResponse.result as {
      structuredContent?: {
        reply?: string;
        server?: string;
      };
    } | undefined;
    const reply = result?.structuredContent?.reply;
    const server = result?.structuredContent?.server;

    if (!reply || !server) {
      throw new Error('MCP tools/call returned no structuredContent.reply/server');
    }

    return { reply, server };
  } finally {
    context.signal.removeEventListener('abort', abortHandler);
    child.kill('SIGTERM');
  }
}
