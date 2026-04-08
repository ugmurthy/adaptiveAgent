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
      context: { tenantId: 'acme' },
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
    expect(createProtocolErrorFrame(createUnsupportedFrameError('session.open'))).toEqual({
      type: 'error',
      code: 'unsupported_frame',
      message: 'Inbound frame type "session.open" is valid but not implemented yet.',
      requestType: 'session.open',
      details: undefined,
    });
  });
});
