import { describe, expect, it } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SAMPLE_PATH = join(HERE, 'sample-bulletin.html');

describe('sample-bulletin.html artifact', () => {
  it('exists on disk', async () => {
    const s = await stat(SAMPLE_PATH);
    expect(s.size).toBeGreaterThan(500);
  });

  it('is well-formed HTML matching the US-012 contract', async () => {
    const html = await readFile(SAMPLE_PATH, 'utf-8');
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
    expect((html.match(/<html\b/g) ?? []).length).toBe(1);
    expect((html.match(/<\/html>/g) ?? []).length).toBe(1);
    expect((html.match(/<body\b/g) ?? []).length).toBe(1);
    expect((html.match(/<\/body>/g) ?? []).length).toBe(1);
  });

  it('contains all 10 IPL teams and the AdaptiveAgent attribution', async () => {
    const html = await readFile(SAMPLE_PATH, 'utf-8');
    for (const name of [
      'Rajasthan Royals',
      'Kolkata Knight Riders',
      'Chennai Super Kings',
      'Sunrisers Hyderabad',
      'Lucknow Super Giants',
      'Delhi Capitals',
      'Mumbai Indians',
      'Royal Challengers Bengaluru',
      'Punjab Kings',
      'Gujarat Titans',
    ]) {
      expect(html).toContain(name);
    }
    expect(html).toContain('AdaptiveAgent');
    expect(html).toContain('https://twitter.com/murthyug');
  });
});
