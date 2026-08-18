import { describe, expect, test } from 'bun:test';
import { compareTimestamps, formatTimestamp, normalizeTimestamp, UNKNOWN_TIMESTAMP } from './timestamp';

describe('persisted timestamp normalization', () => {
  const epoch = 1_786_970_096_789;
  const iso = '2026-08-17T12:34:56.789Z';

  test('normalizes ISO, numeric, and epoch-millisecond strings identically', () => {
    expect(normalizeTimestamp(iso)).toBe(epoch);
    expect(normalizeTimestamp(epoch)).toBe(epoch);
    expect(normalizeTimestamp(String(epoch))).toBe(epoch);
    expect(compareTimestamps(iso, epoch)).toBe(0);
  });

  test('uses one stable fallback for blank and invalid values', () => {
    for (const value of ['', 'not-a-timestamp', null, undefined, Number.NaN]) {
      expect(normalizeTimestamp(value)).toBeNull();
      expect(formatTimestamp(value)).toBe(UNKNOWN_TIMESTAMP);
    }
  });
});
