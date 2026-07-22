import { describe, expect, it } from 'vitest';

import { DesktopProtocolError, commandIdFromUnknownLine, parseDesktopCommand } from './protocol.js';

describe('desktop bridge protocol', () => {
  it('parses a supported command', () => {
    expect(parseDesktopCommand('{"version":1,"id":"request-1","type":"hello"}')).toEqual({
      version: 1,
      id: 'request-1',
      type: 'hello',
    });
  });

  it('rejects malformed JSON with a stable error code', () => {
    expect(() => parseDesktopCommand('{')).toThrowError(expect.objectContaining<Partial<DesktopProtocolError>>({
      code: 'INVALID_JSON',
    }));
  });

  it('rejects unsupported protocol versions', () => {
    expect(() => parseDesktopCommand('{"version":2,"id":"request-1","type":"hello"}')).toThrowError(
      expect.objectContaining<Partial<DesktopProtocolError>>({ code: 'UNSUPPORTED_PROTOCOL_VERSION' }),
    );
  });

  it('recovers a request id for parse errors', () => {
    expect(commandIdFromUnknownLine('{"id":"request-1"}')).toBe('request-1');
    expect(commandIdFromUnknownLine('{')).toBe('unknown');
  });

  it('validates command-specific fields', () => {
    expect(() => parseDesktopCommand('{"version":1,"id":"request-1","type":"run.start"}')).toThrowError(
      expect.objectContaining<Partial<DesktopProtocolError>>({ code: 'INVALID_COMMAND' }),
    );
    expect(() => parseDesktopCommand('{"version":1,"id":"request-1","type":"approval.resolve","runId":"run-1","approved":"yes"}')).toThrowError(
      expect.objectContaining<Partial<DesktopProtocolError>>({ code: 'INVALID_COMMAND' }),
    );
  });

  it('rejects unknown commands before dispatch', () => {
    expect(() => parseDesktopCommand('{"version":1,"id":"request-1","type":"unknown"}')).toThrowError(
      expect.objectContaining<Partial<DesktopProtocolError>>({ code: 'UNKNOWN_COMMAND' }),
    );
  });
});
