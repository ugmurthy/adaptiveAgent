import chalk from 'chalk';
import type { Component } from '@earendil-works/pi-tui';
import { Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { TuiMessageStyleConfig, TuiMessageType, TuiSettingsConfig, TuiTextStyleName } from '../../index.js';
import type { MessageEntry } from '../types.js';
import { defaultMarkdownTheme } from '../themes.js';

const MAX_MESSAGES = 100;
const MAX_LINES_PER_MESSAGE = 50;

const DEFAULT_MESSAGE_STYLES: Record<TuiMessageType, Required<Pick<TuiMessageStyleConfig, 'showPrefix'>> & Pick<TuiMessageStyleConfig, 'prefix' | 'body'>> = {
  user: { showPrefix: true, prefix: 'blue', body: 'default' },
  assistant: { showPrefix: true, prefix: 'green', body: 'default' },
  progress: { showPrefix: true, prefix: 'green', body: 'default' },
  run: { showPrefix: true, prefix: 'cyan', body: 'default' },
  system: { showPrefix: true, prefix: 'yellow', body: 'default' },
  event: { showPrefix: true, prefix: 'dim', body: 'default' },
};

export class MessageLog implements Component {
  private messages: MessageEntry[] = [];
  private cachedLines?: string[];
  private cachedWidth?: number;
  private scrollOffset = 0;
  private theme: TuiSettingsConfig;

  constructor(theme: TuiSettingsConfig = {}) {
    this.theme = theme;
  }

  addMessage(entry: MessageEntry): void {
    const wasAtBottom = this.scrollOffset === 0;
    this.messages.push(entry);
    if (this.messages.length > MAX_MESSAGES) {
      this.messages.shift();
    }
    if (wasAtBottom) {
      this.scrollOffset = 0;
    }
    this.invalidate();
  }

  clear(): void {
    this.messages = [];
    this.scrollOffset = 0;
    this.invalidate();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const lines: string[] = [];

    for (const entry of this.messages) {
      const style = this.getStyle(entry.type);
      const prefix = style.showPrefix ? this.getPrefix(entry.type, style) : '';
      const prefixWidth = visibleWidth(prefix);
      const contentWidth = style.showPrefix ? Math.max(1, width - prefixWidth - 1) : width;
      const continuationPrefix = style.showPrefix ? ' '.repeat(prefixWidth + 1) : '';
      const contentLines = this.formatContent(entry, contentWidth);

      for (let index = 0; index < contentLines.length && index < MAX_LINES_PER_MESSAGE; index += 1) {
        const linePrefix = style.showPrefix && index === 0 ? `${prefix} ` : continuationPrefix;
        lines.push(truncateToWidth(linePrefix + this.applyStyle(contentLines[index], style.body), width));
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

  renderViewport(width: number, height: number): string[] {
    const lines = this.render(width);
    const visibleHeight = Math.max(1, height);
    const maxOffset = Math.max(0, lines.length - visibleHeight);
    this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
    const start = Math.max(0, lines.length - visibleHeight - this.scrollOffset);
    return lines.slice(start, start + visibleHeight);
  }

  scrollUp(lines: number): void {
    this.scrollOffset = Math.max(0, this.scrollOffset + Math.max(1, lines));
  }

  scrollDown(lines: number): void {
    this.scrollOffset = Math.max(0, this.scrollOffset - Math.max(1, lines));
  }

  scrollToTop(width: number, height: number): void {
    this.scrollOffset = Math.max(0, this.render(width).length - Math.max(1, height));
  }

  scrollToBottom(): void {
    this.scrollOffset = 0;
  }

  getScrollOffset(): number {
    return this.scrollOffset;
  }

  private getStyle(type: TuiMessageType): Required<Pick<TuiMessageStyleConfig, 'showPrefix'>> & Pick<TuiMessageStyleConfig, 'prefix' | 'body'> {
    const fallback = DEFAULT_MESSAGE_STYLES[type];
    const override = this.theme.messages?.[type] ?? {};
    return {
      showPrefix: override.showPrefix ?? fallback.showPrefix,
      prefix: override.prefix ?? fallback.prefix,
      body: override.body ?? fallback.body,
    };
  }

  private getPrefix(type: MessageEntry['type'], style: TuiMessageStyleConfig): string {
    const label = type === 'user' ? 'you>' : `${type}>`;
    return this.applyStyle(label, style.prefix);
  }

  private applyStyle(text: string, style: TuiTextStyleName | TuiTextStyleName[] | undefined): string {
    const styles = Array.isArray(style) ? style : [style ?? 'default'];
    return styles.reduce((styled, styleName) => applyNamedStyle(styled, styleName), text);
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

function applyNamedStyle(text: string, style: TuiTextStyleName): string {
  switch (style) {
    case 'dim': return chalk.dim(text);
    case 'bold': return chalk.bold(text);
    case 'italic': return chalk.italic(text);
    case 'underline': return chalk.underline(text);
    case 'red': return chalk.red(text);
    case 'green': return chalk.green(text);
    case 'yellow': return chalk.yellow(text);
    case 'blue': return chalk.blue(text);
    case 'magenta': return chalk.magenta(text);
    case 'cyan': return chalk.cyan(text);
    case 'white': return chalk.white(text);
    case 'gray': return chalk.gray(text);
    case 'default': return text;
    default: return text;
  }
}
