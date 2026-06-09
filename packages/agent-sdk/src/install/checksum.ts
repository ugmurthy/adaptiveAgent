import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export interface ChecksumEntry {
  algorithm: 'sha256';
  hash: string;
  fileName: string;
}

export function parseChecksums(text: string): ChecksumEntry[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line);
      if (!match) throw new Error(`Invalid checksum line: ${line}`);
      return { algorithm: 'sha256' as const, hash: match[1]!.toLowerCase(), fileName: match[2]!.trim() };
    });
}

export function findChecksum(text: string, fileName: string): ChecksumEntry | undefined {
  return parseChecksums(text).find((entry) => entry.fileName === fileName || entry.fileName.endsWith(`/${fileName}`));
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

export async function verifySha256File(path: string, checksumsText: string, fileName: string): Promise<string> {
  const expected = findChecksum(checksumsText, fileName);
  if (!expected) throw new Error(`Checksum for ${fileName} not found in checksums.txt`);
  const actual = await sha256File(path);
  if (actual !== expected.hash) throw new Error(`Checksum mismatch for ${fileName}`);
  return actual;
}
