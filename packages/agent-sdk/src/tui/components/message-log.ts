import chalk from 'chalk';
import type { Component } from '@earendil-works/pi-tui';
import { Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { TuiMessageType, TuiSettingsConfig } from '../../index.js';
import type { MessageEntry } from '../types.js';
import { applyStyle, resolveMessageStyle, resolvePrefixLabel, trimOuterBlankLines } from '../message-styles.js';
import { defaultMarkdownTheme } from '../themes.js';

const MAX_MESSAGES = 100;
const MAX_LINES_PER_MESSAGE = 50;

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
      const style = resolveMessageStyle(this.theme, entry.type);
      const prefix = this.getPrefix(entry.type, style);
      const prefixWidth = visibleWidth(prefix);
      const contentWidth = Math.max(1, width - prefixWidth - 1);
      const continuationPrefix = ' '.repeat(prefixWidth + 1);
      const contentLines = this.formatContent(entry, contentWidth);

      for (let index = 0; index < contentLines.length && index < MAX_LINES_PER_MESSAGE; index += 1) {
        const linePrefix = index === 0 ? `${prefix} ` : continuationPrefix;
        lines.push(truncateToWidth(linePrefix + applyStyle(contentLines[index], style.body), width));
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

  private getPrefix(type: TuiMessageType, style: ReturnType<typeof resolveMessageStyle>): string {
    return applyStyle(resolvePrefixLabel(type, style), style.prefix);
  }

  private formatContent(entry: MessageEntry, maxWidth: number): string[] {
    const content = String(entry.content ?? '');

    if (entry.type === 'assistant' || entry.type === 'progress' || entry.type === 'run') {
      const markdown = new Markdown(content, 0, 0, defaultMarkdownTheme);
      const rendered = markdown.render(maxWidth);
      return rendered.length > 0 ? trimOuterBlankLines([...rendered]) : [''];
    }

    const lines = trimOuterBlankLines(wrapTextWithAnsi(content, maxWidth));
    return lines.length > 0 ? lines : [''];
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.cachedWidth = undefined;
  }
}
