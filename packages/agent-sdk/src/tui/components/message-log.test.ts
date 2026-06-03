import { describe, expect, it } from 'vitest';

import { MessageLog } from './message-log.js';

function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

describe('MessageLog', () => {
  it('renders assistant content as markdown instead of raw markdown source', () => {
    const log = new MessageLog();

    log.addMessage({
      type: 'assistant',
      content: '# Summary\n\n- first item',
      timestamp: new Date(),
    });

    const rendered = log.render(80).map(stripAnsi);

    expect(rendered.some((line) => line.includes('assistant> Summary'))).toBe(true);
    expect(rendered.some((line) => line.includes('assistant> # Summary'))).toBe(false);
  });

  it('renders progress content with a progress prefix', () => {
    const log = new MessageLog();

    log.addMessage({
      type: 'progress',
      content: 'Checking available data',
      timestamp: new Date(),
    });

    const rendered = log.render(80).map(stripAnsi);

    expect(rendered.some((line) => line.includes('progress> Checking available data'))).toBe(true);
  });

  it('falls back to default text when a configured style name is unsupported', () => {
    const log = new MessageLog({
      messages: {
        progress: { showPrefix: false, body: ['green', 'italics' as 'italic'] },
      },
    });

    log.addMessage({
      type: 'progress',
      content: 'Checking available data',
      timestamp: new Date(),
    });

    const rendered = log.render(80).map(stripAnsi);

    expect(rendered.some((line) => line.includes('\u29bf Checking available data'))).toBe(true);
    expect(rendered.some((line) => line.includes('undefined'))).toBe(false);
  });

  it('truncates only the oversized message and still renders later messages', () => {
    const log = new MessageLog();
    const longMessage = Array.from({ length: 55 }, (_, index) => `line ${index + 1}`).join('\n');

    log.addMessage({
      type: 'assistant',
      content: longMessage,
      timestamp: new Date(),
    });
    log.addMessage({
      type: 'system',
      content: '/help still works',
      timestamp: new Date(),
    });

    const rendered = log.render(80).map(stripAnsi);

    expect(rendered.some((line) => line.includes('...'))).toBe(true);
    expect(rendered.some((line) => line.includes('system> /help still works'))).toBe(true);
  });

  it('does not leave extra blank lines between rendered messages', () => {
    const log = new MessageLog();

    log.addMessage({
      type: 'assistant',
      content: 'First message',
      timestamp: new Date(),
    });
    log.addMessage({
      type: 'system',
      content: 'Second message',
      timestamp: new Date(),
    });

    const rendered = log.render(80).map(stripAnsi);
    const assistantIndex = rendered.findIndex((line) => line.includes('assistant> First message'));
    const systemIndex = rendered.findIndex((line) => line.includes('system> Second message'));

    expect(assistantIndex).toBeGreaterThanOrEqual(0);
    expect(systemIndex).toBe(assistantIndex + 1);
  });
});
