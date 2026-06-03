import chalk from 'chalk';

import type { TuiMessageStyleConfig, TuiMessageType, TuiSettingsConfig, TuiTextStyleName } from '../index.js';

export type ResolvedTuiMessageStyle = Required<Pick<TuiMessageStyleConfig, 'showPrefix'>> & Pick<TuiMessageStyleConfig, 'prefix' | 'body'>;
export const PREFIX_PLACEHOLDER = '\u29bf';

export const DEFAULT_MESSAGE_STYLES: Record<TuiMessageType, ResolvedTuiMessageStyle> = {
  user: { showPrefix: true, prefix: 'blue', body: 'default' },
  assistant: { showPrefix: true, prefix: 'green', body: 'default' },
  progress: { showPrefix: true, prefix: 'green', body: 'default' },
  run: { showPrefix: true, prefix: 'cyan', body: 'default' },
  system: { showPrefix: true, prefix: 'yellow', body: 'default' },
  event: { showPrefix: true, prefix: 'dim', body: 'default' },
};

export function resolveMessageStyle(
  theme: TuiSettingsConfig,
  type: TuiMessageType,
): ResolvedTuiMessageStyle {
  const fallback = DEFAULT_MESSAGE_STYLES[type];
  const override = theme.messages?.[type] ?? {};
  return {
    showPrefix: override.showPrefix ?? fallback.showPrefix,
    prefix: override.prefix ?? fallback.prefix,
    body: override.body ?? fallback.body,
  };
}

export function formatMessageLabel(type: TuiMessageType): string {
  return type === 'user' ? 'you>' : `${type}>`;
}

export function resolvePrefixLabel(
  type: TuiMessageType,
  style: Pick<ResolvedTuiMessageStyle, 'showPrefix'>,
): string {
  return style.showPrefix ? formatMessageLabel(type) : PREFIX_PLACEHOLDER;
}

export function applyNamedStyle(text: string, style: TuiTextStyleName): string {
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

export function applyStyle(text: string, style: TuiTextStyleName | TuiTextStyleName[] | undefined): string {
  const styles = Array.isArray(style) ? style : [style ?? 'default'];
  return styles.reduce((styled, styleName) => applyNamedStyle(styled, styleName), text);
}

export function formatStyledMessageBlock(
  type: TuiMessageType,
  content: string,
  theme: TuiSettingsConfig = {},
): string {
  const style = resolveMessageStyle(theme, type);
  const prefixLabel = resolvePrefixLabel(type, style);
  const prefix = applyStyle(prefixLabel, style.prefix);
  const continuationPrefix = ' '.repeat(prefixLabel.length + 1);
  const lines = trimOuterBlankLines(content.split(/\r?\n/));

  return lines.map((line, index) => {
    const linePrefix = index === 0 ? `${prefix} ` : continuationPrefix;
    return `${linePrefix}${applyStyle(line, style.body)}`;
  }).join('\n');
}

export function trimOuterBlankLines(lines: string[]): string[] {
  while (lines.length > 1 && lines[0] === '') {
    lines.shift();
  }
  while (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}
