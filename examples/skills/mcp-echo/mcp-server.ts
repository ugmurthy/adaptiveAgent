import { stdin, stdout } from 'node:process';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

function encodeMessage(message: object): string {
  const json = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
}

function writeMessage(message: object): void {
  stdout.write(encodeMessage(message));
}

let buffer = '';
stdin.setEncoding('utf8');

stdin.on('data', (chunk: string) => {
  buffer += chunk;

  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      return;
    }

    const header = buffer.slice(0, headerEnd);
    const lengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
    if (!lengthMatch) {
      return;
    }

    const contentLength = Number(lengthMatch[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + contentLength;
    if (buffer.length < bodyEnd) {
      return;
    }

    const payload = buffer.slice(bodyStart, bodyEnd);
    buffer = buffer.slice(bodyEnd);

    const request = JSON.parse(payload) as JsonRpcRequest;
    handleRequest(request);
  }
});

function handleRequest(request: JsonRpcRequest): void {
  if (request.method === 'initialize') {
    writeMessage({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: 'example-mcp-echo',
          version: '0.1.0',
        },
      },
    });
    return;
  }

  if (request.method === 'tools/call') {
    const name = request.params?.name;
    const args = request.params?.arguments as { message?: string } | undefined;
    if (name !== 'echo') {
      writeMessage({
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: -32601,
          message: `Unknown tool ${String(name)}`,
        },
      });
      return;
    }

    const message = args?.message ?? '';
    writeMessage({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        content: [
          {
            type: 'text',
            text: `echo:${message}`,
          },
        ],
        structuredContent: {
          reply: `echo:${message}`,
          server: 'example-mcp-echo',
        },
      },
    });
    return;
  }

  writeMessage({
    jsonrpc: '2.0',
    id: request.id,
    error: {
      code: -32601,
      message: `Unsupported method ${request.method}`,
    },
  });
}
