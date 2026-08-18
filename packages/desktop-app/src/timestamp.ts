export const UNKNOWN_TIMESTAMP = 'Not recorded';

export function normalizeTimestamp(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function compareTimestamps(left: unknown, right: unknown): number {
  return (normalizeTimestamp(left) ?? 0) - (normalizeTimestamp(right) ?? 0);
}

export function formatTimestamp(
  value: unknown,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
  fallback = UNKNOWN_TIMESTAMP,
): string {
  const timestamp = normalizeTimestamp(value);
  return timestamp === null ? fallback : new Intl.DateTimeFormat(undefined, options).format(timestamp);
}
