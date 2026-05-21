import chalk from 'chalk';
import type { EditorTheme, MarkdownTheme, SelectListTheme } from '@earendil-works/pi-tui';

export const defaultSelectListTheme: SelectListTheme = {
  selectedPrefix: (text: string) => chalk.green(text),
  selectedText: (text: string) => chalk.green(text),
  description: (text: string) => chalk.dim(text),
  scrollInfo: (text: string) => chalk.dim(text),
  noMatch: (text: string) => chalk.yellow(text),
};

export const defaultEditorTheme: EditorTheme = {
  borderColor: (s: string) => chalk.dim(s),
  selectList: defaultSelectListTheme,
};

export const defaultMarkdownTheme: MarkdownTheme = {
  heading: (text: string) => chalk.bold(text),
  link: (text: string) => chalk.cyan.underline(text),
  linkUrl: (text: string) => chalk.dim(text),
  code: (text: string) => chalk.green(text),
  codeBlock: (text: string) => chalk.green(text),
  codeBlockBorder: (text: string) => chalk.dim(text),
  quote: (text: string) => chalk.italic(text),
  quoteBorder: (text: string) => chalk.dim(text),
  hr: (text: string) => chalk.dim(text),
  listBullet: (text: string) => chalk.dim(text),
  bold: (text: string) => chalk.bold(text),
  italic: (text: string) => chalk.italic(text),
  strikethrough: (text: string) => chalk.strikethrough(text),
  underline: (text: string) => chalk.underline(text),
};

export const connectionStatusTheme = {
  connected: (text: string) => chalk.green(text),
  disconnected: (text: string) => chalk.red(text),
  connecting: (text: string) => chalk.yellow(text),
};

export const statusBarTheme = {
  background: (text: string) => chalk.bgBlue.black(text),
  text: (text: string) => chalk.blue(text),
  accent: (text: string) => chalk.cyan(text),
};
