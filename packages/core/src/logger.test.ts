import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createAdaptiveAgentLogger, DEFAULT_LOG_LEVEL } from './logger.js';

describe('createAdaptiveAgentLogger', () => {
  it('defaults to the silent log level', () => {
    const logger = createAdaptiveAgentLogger({ pretty: false });

    expect(DEFAULT_LOG_LEVEL).toBe('silent');
    expect(logger.level).toBe('silent');
  });

  it('writes logs to a file destination', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'adaptive-agent-logger-'));
    const logFilePath = join(tempDir, 'agent.log');

    try {
      const logger = createAdaptiveAgentLogger({
        destination: 'file',
        filePath: logFilePath,
        level: 'info',
        pretty: false,
      });

      logger.info({ runId: 'run-1' }, 'hello file logger');
      logger.flush();

      expect(logger.filePath).toBe(join(tempDir, `agent-${formatLogDate(new Date())}.log`));

      const lines = readFileSync(logger.filePath ?? logFilePath, 'utf8').trim().split('\n');
      const entry = JSON.parse(lines.at(-1) ?? '{}') as Record<string, unknown>;

      expect(entry.msg).toBe('hello file logger');
      expect(entry.runId).toBe('run-1');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('adds a same-day serial when the dated log file already exists', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'adaptive-agent-logger-'));
    const logFilePath = join(tempDir, 'agent.log');
    const dateStamp = formatLogDate(new Date());
    const firstLogPath = join(tempDir, `agent-${dateStamp}.log`);

    try {
      writeFileSync(firstLogPath, 'existing log\n');

      const logger = createAdaptiveAgentLogger({
        destination: 'file',
        filePath: logFilePath,
        level: 'info',
        pretty: false,
      });

      logger.info('rotated file logger');
      logger.flush();

      expect(logger.filePath).toBe(join(tempDir, `agent-${dateStamp}-2.log`));
      expect(existsSync(logger.filePath ?? '')).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

function formatLogDate(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
