import { describe, expect, it } from 'vitest';

import {
  ProtocolValidationError,
  createPongFrame,
  createProtocolErrorFrame,
  createUnsupportedFrameError,
  parseInboundFrame,
} from './protocol.js';

describe('gateway protocol validation', () => {
  it('parses valid inbound frames', () => {
    const frame = parseInboundFrame(
      JSON.stringify({
        type: 'run.start',
        goal: 'Summarize recent incidents',
        input: { severity: 'high' },
        context: { tenantId: 'acme' },
      }),
    );

    expect(frame).toEqual({
      type: 'run.start',
      sessionId: undefined,
      agentId: undefined,
      goal: 'Summarize recent incidents',
      input: { severity: 'high' },
      images: undefined,
      context: { tenantId: 'acme' },
      metadata: undefined,
    });
  });

  it('parses image inputs on chat and run frames', () => {
    const chatFrame = parseInboundFrame(
      JSON.stringify({
        type: 'message.send',
        sessionId: 'session-1',
        content: 'What is in this image?',
        images: [{ path: '/tmp/receipt.jpg', mimeType: 'image/jpeg', detail: 'high', name: 'receipt' }],
      }),
    );
    const runFrame = parseInboundFrame(
      JSON.stringify({
        type: 'run.start',
        goal: 'Read the receipt total',
        images: [{ uploadId: '019ddcf3-e4c8-7000-8000-3f3a8f4e51f6', detail: 'low', name: 'receipt.png' }],
      }),
    );

    expect(chatFrame).toMatchObject({
      type: 'message.send',
      images: [{ path: '/tmp/receipt.jpg', mimeType: 'image/jpeg', detail: 'high', name: 'receipt' }],
    });
    expect(runFrame).toMatchObject({
      type: 'run.start',
      images: [{ uploadId: '019ddcf3-e4c8-7000-8000-3f3a8f4e51f6', detail: 'low', name: 'receipt.png' }],
    });
  });

  it('rejects image inputs without exactly one source', () => {
    expectInvalidFrameIssue(() => parseInboundFrame(JSON.stringify({
      type: 'message.send',
      sessionId: 'session-1',
      content: 'Bad image',
      images: [{ detail: 'high' }],
    })), 'frame.images[0] must include either path or uploadId.');

    expectInvalidFrameIssue(() => parseInboundFrame(JSON.stringify({
      type: 'run.start',
      goal: 'Bad image',
      images: [{ path: '/tmp/receipt.png', uploadId: '019ddcf3-e4c8-7000-8000-3f3a8f4e51f6' }],
    })), 'frame.images[0] cannot include both path and uploadId.');
  });

  it('parses run.retry frames', () => {
    const frame = parseInboundFrame(
      JSON.stringify({
        type: 'run.retry',
        sessionId: 'session-1',
        runId: 'run-1',
      }),
    );

    expect(frame).toEqual({
      type: 'run.retry',
      sessionId: 'session-1',
      runId: 'run-1',
      metadata: undefined,
    });
  });

  it('parses sessionless run.retry frames for root-run retry', () => {
    const frame = parseInboundFrame(
      JSON.stringify({
        type: 'run.retry',
        runId: 'root-1',
      }),
    );

    expect(frame).toEqual({
      type: 'run.retry',
      sessionId: undefined,
      runId: 'root-1',
      metadata: undefined,
    });
  });

  it('maps invalid JSON to a stable protocol error', () => {
    expect(() => parseInboundFrame('{"type":"ping"')).toThrowError(ProtocolValidationError);

    try {
      parseInboundFrame('{"type":"ping"');
      throw new Error('expected parseInboundFrame to throw');
    } catch (error) {
      const protocolError = error as ProtocolValidationError;
      expect(createProtocolErrorFrame(protocolError)).toMatchObject({
        type: 'error',
        code: 'invalid_json',
      });
    }
  });

  it('maps unknown frame types to a stable protocol error', () => {
    try {
      parseInboundFrame(JSON.stringify({ type: 'mystery.frame' }));
      throw new Error('expected parseInboundFrame to throw');
    } catch (error) {
      const protocolError = error as ProtocolValidationError;
      expect(createProtocolErrorFrame(protocolError)).toEqual({
        type: 'error',
        code: 'unknown_frame_type',
        message: 'Unknown inbound frame type "mystery.frame".',
        requestType: 'mystery.frame',
        details: undefined,
      });
    }
  });

  it('maps malformed known frames to validation issues', () => {
    try {
      parseInboundFrame(
        JSON.stringify({
          type: 'message.send',
          sessionId: '',
        }),
      );
      throw new Error('expected parseInboundFrame to throw');
    } catch (error) {
      const protocolError = error as ProtocolValidationError;
      expect(createProtocolErrorFrame(protocolError)).toMatchObject({
        type: 'error',
        code: 'invalid_frame',
        requestType: 'message.send',
        details: {
          issues: [
            'frame.sessionId must be a non-empty string.',
            'frame.content must be a non-empty string.',
          ],
        },
      });
    }
  });

  it('creates pong and unsupported-frame responses with stable shapes', () => {
    expect(createPongFrame({ type: 'ping', id: 'abc' })).toEqual({
      type: 'pong',
      id: 'abc',
    });
    expect(createProtocolErrorFrame(createUnsupportedFrameError('run.start'))).toEqual({
      type: 'error',
      code: 'unsupported_frame',
      message: 'Inbound frame type "run.start" is valid but not implemented yet.',
      requestType: 'run.start',
      details: undefined,
    });
  });
});

function expectInvalidFrameIssue(callback: () => void, issue: string): void {
  try {
    callback();
    throw new Error('expected parseInboundFrame to throw');
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolValidationError);
    const details = (error as ProtocolValidationError).details;
    expect(details?.issues).toContain(issue);
  }
}
