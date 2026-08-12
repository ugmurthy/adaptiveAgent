import { describe, expect, it } from 'vitest';

import {
  DESKTOP_PROTOCOL_VERSION,
  JSON_RPC_ERROR_CODES,
  DesktopProtocolError,
  parseDesktopRpcRequest,
  rpcIdFromUnknownLine,
} from './protocol.js';

describe('desktop bridge protocol', () => {
  it('parses a supported JSON-RPC request', () => {
    expect(parseDesktopRpcRequest('{"jsonrpc":"2.0","id":7,"method":"runtime/info"}')).toEqual({
      jsonrpc: '2.0',
      id: 7,
      method: 'runtime/info',
    });
  });

  it('rejects malformed JSON with a stable error code', () => {
    expect(() => parseDesktopRpcRequest('{')).toThrowError(expect.objectContaining<Partial<DesktopProtocolError>>({
      code: 'INVALID_JSON',
      jsonRpcCode: JSON_RPC_ERROR_CODES.parseError,
    }));
  });

  it('rejects the removed protocol-v1 envelope as an invalid request', () => {
    expect(() => parseDesktopRpcRequest('{"version":1,"id":"hello","type":"hello"}')).toThrowError(
      expect.objectContaining<Partial<DesktopProtocolError>>({
        code: 'INVALID_REQUEST',
        jsonRpcCode: JSON_RPC_ERROR_CODES.invalidRequest,
        message: 'jsonrpc must be exactly "2.0".',
      }),
    );
  });

  it('uses a string for protocol 1.15', () => {
    expect(DESKTOP_PROTOCOL_VERSION).toBe('1.15');
  });

  it('validates agent builder requests', () => {
    expect(parseDesktopRpcRequest(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'agent/createDraft', params: { brief: 'Build a reviewer' } }))).toMatchObject({ method: 'agent/createDraft' });
    expect(parseDesktopRpcRequest(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'agent/validateConfig', params: { agent: { id: 'reviewer' } } }))).toMatchObject({ method: 'agent/validateConfig' });
    expect(() => parseDesktopRpcRequest(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'agent/createDraft', params: { brief: 7 } }))).toThrowError(expect.objectContaining({ code: 'INVALID_PARAMS' }));
    expect(() => parseDesktopRpcRequest(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'agent/saveConfig', params: { agent: [] } }))).toThrowError(expect.objectContaining({ code: 'INVALID_PARAMS' }));
    expect(() => parseDesktopRpcRequest(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'agent/saveConfig', params: { agent: { id: 'reviewer' } } }))).toThrowError(expect.objectContaining({ code: 'INVALID_PARAMS' }));
  });

  it('strictly validates managed attachment descriptors', () => {
    const attachment = { attachmentId: 'a1', kind: 'file', stagedRelativePath: 'a1/note.txt', name: 'note.txt', sizeBytes: 3, sha256: 'a'.repeat(64), mimeType: 'text/plain' };
    expect(parseDesktopRpcRequest(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'agent/run', params: { executionId: 'e1', goal: 'read', attachments: [attachment] } }))).toMatchObject({ method: 'agent/run' });
    for (const invalid of [{ ...attachment, source: { kind: 'url' } }, { ...attachment, audioFormat: 'wav' }, { ...attachment, sha256: 'bad' }]) {
      expect(() => parseDesktopRpcRequest(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'agent/run', params: { executionId: 'e1', goal: 'read', attachments: [invalid] } }))).toThrowError(expect.objectContaining({ code: 'INVALID_PARAMS' }));
    }
  });

  it('uses standard JSON-RPC parse, request, method, and params error codes', () => {
    expect(() => parseDesktopRpcRequest('{')).toThrowError(expect.objectContaining<Partial<DesktopProtocolError>>({
      jsonRpcCode: JSON_RPC_ERROR_CODES.parseError,
    }));
    expect(() => parseDesktopRpcRequest('[]')).toThrowError(expect.objectContaining<Partial<DesktopProtocolError>>({
      jsonRpcCode: JSON_RPC_ERROR_CODES.invalidRequest,
    }));
    expect(() => parseDesktopRpcRequest('{"jsonrpc":"2.0","id":1,"method":"missing"}')).toThrowError(
      expect.objectContaining<Partial<DesktopProtocolError>>({ jsonRpcCode: JSON_RPC_ERROR_CODES.methodNotFound }),
    );
    expect(() => parseDesktopRpcRequest('{"jsonrpc":"2.0","id":1,"method":"agent/run","params":{}}')).toThrowError(
      expect.objectContaining<Partial<DesktopProtocolError>>({ jsonRpcCode: JSON_RPC_ERROR_CODES.invalidParams }),
    );
  });

  it('validates the JSON-RPC initialize and CLI execution contracts', () => {
    expect(parseDesktopRpcRequest(JSON.stringify({
      jsonrpc: '2.0',
      id: 'init',
      method: 'initialize',
      params: { protocolVersion: '1.10', clientInfo: { name: 'desktop', version: '1.0.0' } },
    })).method).toBe('initialize');

    expect(() => parseDesktopRpcRequest(JSON.stringify({
      jsonrpc: '2.0',
      id: 'exec',
      method: 'cli/execute',
      params: { argv: [] },
    }))).toThrowError(expect.objectContaining<Partial<DesktopProtocolError>>({ code: 'INVALID_PARAMS' }));
  });

  it('validates gateway run selection and access-token updates', () => {
    const profileRef = { source: 'server', id: 'researcher', version: '1', contentHash: 'abc123' };
    expect(parseDesktopRpcRequest(JSON.stringify({
      jsonrpc: '2.0',
      id: 'run',
      method: 'agent/run',
      params: { runId: 'run-1', goal: 'Research', inferenceMode: 'gateway', inferenceTier: 'high', profileRef },
    }))).toMatchObject({ method: 'agent/run' });
    expect(parseDesktopRpcRequest(JSON.stringify({
      jsonrpc: '2.0',
      id: 'token',
      method: 'auth/updateAccessToken',
      params: { accessToken: 'secret-value' },
    }))).toMatchObject({ method: 'auth/updateAccessToken' });
    expect(() => parseDesktopRpcRequest(JSON.stringify({
      jsonrpc: '2.0',
      id: 'bad-profile',
      method: 'agent/chat',
      params: { runId: 'run-2', transcript: [{ role: 'user', content: 'Hello' }], profileRef: { source: 'server', id: 'missing-fields' } },
    }))).toThrowError(expect.objectContaining<Partial<DesktopProtocolError>>({ code: 'INVALID_PARAMS' }));
  });

  it('requires host run identity and validates complete chat transcripts', () => {
    for (const params of [{ goal: 'missing id' }, { runId: 'chat-1', message: 'legacy singular message' }]) {
      expect(() => parseDesktopRpcRequest(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'agent/chat', params })))
        .toThrowError(expect.objectContaining<Partial<DesktopProtocolError>>({ code: 'INVALID_PARAMS' }));
    }
    expect(parseDesktopRpcRequest(JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'agent/chat',
      params: { runId: 'chat-2', sessionId: 'session-1', transcript: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'reply' }, { role: 'user', content: 'next' }] },
    }))).toMatchObject({ method: 'agent/chat' });
    for (const message of [
      { role: 'user', content: 'describe', images: [{ path: '/tmp/image.png' }] },
      { role: 'user', content: [{ type: 'image', image: { path: '/tmp/image.png' } }] },
      { role: 'user', content: [{ type: 'audio', audio: { source: { kind: 'path', path: '/tmp/audio.mp3' } } }] },
    ]) {
      expect(() => parseDesktopRpcRequest(JSON.stringify({
        jsonrpc: '2.0', id: 3, method: 'agent/chat', params: { runId: 'chat-media', transcript: [message] },
      }))).toThrowError(expect.objectContaining<Partial<DesktopProtocolError>>({ code: 'INVALID_PARAMS' }));
    }
  });

  it('accepts a caller-selected continuation run identity', () => {
    expect(parseDesktopRpcRequest(JSON.stringify({
      jsonrpc: '2.0',
      id: 'continue',
      method: 'run/continue',
      params: { runId: 'source-run', continuationRunId: 'continuation-run' },
    }))).toMatchObject({
      method: 'run/continue',
      params: { runId: 'source-run', continuationRunId: 'continuation-run' },
    });
    expect(() => parseDesktopRpcRequest(JSON.stringify({
      jsonrpc: '2.0',
      id: 'bad-continue',
      method: 'run/continue',
      params: { runId: 'source-run', continuationRunId: '' },
    }))).toThrowError(expect.objectContaining<Partial<DesktopProtocolError>>({ code: 'INVALID_PARAMS' }));
  });

  it('validates configuration-driven runtime initialization', () => {
    expect(parseDesktopRpcRequest(JSON.stringify({
      jsonrpc: '2.0',
      id: 'runtime',
      method: 'runtime/initialize',
      params: { configurationDriven: true },
    }))).toMatchObject({ method: 'runtime/initialize' });
    expect(() => parseDesktopRpcRequest(JSON.stringify({
      jsonrpc: '2.0',
      id: 'runtime',
      method: 'runtime/initialize',
      params: { configurationDriven: 'yes' },
    }))).toThrowError(expect.objectContaining<Partial<DesktopProtocolError>>({ code: 'INVALID_PARAMS' }));
  });

  it('accepts only complete editable desktop settings', () => {
    const settings = {
      agent: { configPath: './agent.json', id: 'agent-1' },
      inference: { mode: 'byok', tier: 'medium' },
      workspace: { root: '/workspace', shellCwd: '/workspace/project' },
      interaction: { approvalMode: 'manual', clarificationMode: 'fail' },
    };
    expect(parseDesktopRpcRequest(JSON.stringify({
      jsonrpc: '2.0', id: 'settings', method: 'settings/update', params: { settings },
    }))).toMatchObject({ method: 'settings/update', params: { settings } });
    expect(parseDesktopRpcRequest(JSON.stringify({
      jsonrpc: '2.0', id: 'settings', method: 'settings/update', params: { settings: { ...settings, agent: { configPath: '', id: 'agent-1' } } },
    }))).toMatchObject({ method: 'settings/update' });
    expect(() => parseDesktopRpcRequest(JSON.stringify({
      jsonrpc: '2.0', id: 'settings', method: 'settings/update', params: { settings: { ...settings, workspace: { root: '', shellCwd: '/workspace' } } },
    }))).toThrowError(expect.objectContaining<Partial<DesktopProtocolError>>({ code: 'INVALID_PARAMS' }));
    expect(() => parseDesktopRpcRequest(JSON.stringify({
      jsonrpc: '2.0', id: 'settings', method: 'settings/update', params: { settings: { ...settings, agent: { configPath: './agent.json', id: '' } } },
    }))).toThrowError(expect.objectContaining<Partial<DesktopProtocolError>>({ code: 'INVALID_PARAMS' }));
  });

  it('requires the composite approval identity', () => {
    const envelope = (params: object) => JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'interaction/resolveApproval', params });
    expect(parseDesktopRpcRequest(envelope({ runId: 'child', approvalId: 'child:call', approved: true }))).toMatchObject({ method: 'interaction/resolveApproval' });
    expect(() => parseDesktopRpcRequest(envelope({ runId: 'child', approved: true }))).toThrowError(expect.objectContaining<Partial<DesktopProtocolError>>({ code: 'INVALID_PARAMS' }));
  });

  it('accepts only typed root-run and session history deletion targets', () => {
    const envelope = (method: 'history/previewDeletion' | 'history/delete', target: object) =>
      JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { target } });
    expect(parseDesktopRpcRequest(envelope('history/previewDeletion', { kind: 'root-run', rootRunId: 'root' })))
      .toMatchObject({ method: 'history/previewDeletion' });
    expect(parseDesktopRpcRequest(envelope('history/delete', { kind: 'session', sessionId: 'session' })))
      .toMatchObject({ method: 'history/delete' });
    for (const target of [{ kind: 'root-run' }, { kind: 'session' }, { kind: 'sql', statement: 'delete' }]) {
      expect(() => parseDesktopRpcRequest(envelope('history/delete', target)))
        .toThrowError(expect.objectContaining<Partial<DesktopProtocolError>>({ code: 'INVALID_PARAMS' }));
    }
  });

  it('recovers JSON-RPC string and numeric ids without coercion', () => {
    expect(rpcIdFromUnknownLine('{"jsonrpc":"2.0","id":"rpc-1"}')).toBe('rpc-1');
    expect(rpcIdFromUnknownLine('{"jsonrpc":"2.0","id":42}')).toBe(42);
    expect(rpcIdFromUnknownLine('{')).toBeNull();
  });
});
