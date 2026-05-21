import chalk from 'chalk';
import type { Component } from '@earendil-works/pi-tui';
import { Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { MessageEntry } from '../types.js';
import { defaultMarkdownTheme } from '../themes.js';

const MAX_MESSAGES = 100;
const MAX_LINES_PER_MESSAGE = 50;

export class MessageLog implements Component {
  private messages: MessageEntry[] = [];
  private cachedLines?: string[];
  private cachedWidth?: number;

  addMessage(entry: MessageEntry): void {
    this.messages.push(entry);
    if (this.messages.length > MAX_MESSAGES) {
      this.messages.shift();
    }
    this.invalidate();
  }

  clear(): void {
    this.messages = [];
    this.invalidate();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const lines: string[] = [];

    for (const entry of this.messages) {
      const prefix = this.getPrefix(entry.type);
      const prefixWidth = visibleWidth(prefix);
      const continuationPrefix = ' '.repeat(prefixWidth + 1);
      const contentLines = this.formatContent(entry, Math.max(1, width - prefixWidth - 1));

      for (let index = 0; index < contentLines.length && index < MAX_LINES_PER_MESSAGE; index += 1) {
        const linePrefix = index === 0 ? `${prefix} ` : continuationPrefix;
        lines.push(truncateToWidth(linePrefix + contentLines[index], width));
      }

      if (contentLines.length > MAX_LINES_PER_MESSAGE) {
        lines.push(truncateToWidth(continuationPrefix + chalk.dim('...'), width));
      }
    }

    if (lines.length === 0) {
      lines.push(truncateToWidth(chalk.dim('No messages yet. Type a message or /help for commands.'), width));
    }

    this.cachedLines = lines;
    this.cachedWidth = width;
    return this.cachedLines;
  }

  private getPrefix(type: MessageEntry['type']): string {
    switch (type) {
      case 'user':
        return chalk.blue('you>');
      case 'assistant':
        return chalk.green('assistant>');
      case 'progress':
        return chalk.green('progress>');
      case 'run':
        return chalk.cyan('run>');
      case 'system':
        return chalk.yellow('system>');
      case 'event':
        return chalk.dim('event>');
      default:
        return chalk.dim('>');
    }
  }

  private formatContent(entry: MessageEntry, maxWidth: number): string[] {
    const content = String(entry.content ?? '');

    if (entry.type === 'assistant' || entry.type === 'progress' || entry.type === 'run') {
      const markdown = new Markdown(content, 0, 0, defaultMarkdownTheme);
      const rendered = markdown.render(maxWidth);
      return rendered.length > 0 ? rendered : [''];
    }

    const lines = wrapTextWithAnsi(content, maxWidth);
    return lines.length > 0 ? lines : [''];
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.cachedWidth = undefined;
  }
}
