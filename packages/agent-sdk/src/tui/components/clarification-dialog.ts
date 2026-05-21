import chalk from 'chalk';
import {
  Editor,
  type TUI,
  type Component,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui';
import type { ClarificationInfo } from '../types.js';
import { defaultEditorTheme } from '../themes.js';
import { renderBottomBorder, renderFrameLine, renderSeparator, renderTopBorder } from './box-frame.js';

export class ClarificationDialog implements Component {
  private clarificationInfo: ClarificationInfo;
  private editor: Editor;

  constructor(tui: TUI, clarificationInfo: ClarificationInfo) {
    this.clarificationInfo = clarificationInfo;
    this.editor = new Editor(tui, defaultEditorTheme);
  }

  onClarificationResolved?: (message: string) => void;
  onCancel?: () => void;

  getEditor(): Editor {
    return this.editor;
  }

  getClarificationInfo(): ClarificationInfo {
    return this.clarificationInfo;
  }

  invalidate(): void {
    this.editor.invalidate();
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 4);
    const lines: string[] = [];

    lines.push(renderTopBorder(width, { border: chalk.cyan }, 'Clarification Needed'));
    lines.push(this.frameLine(chalk.dim(`runId: ${this.clarificationInfo.runId}`), innerWidth));
    lines.push(renderSeparator(width, { border: chalk.dim }));

    for (const line of wrapTextWithAnsi(this.clarificationInfo.message, innerWidth)) {
      lines.push(this.frameLine(line, innerWidth));
    }

    if (this.clarificationInfo.suggestedQuestions.length > 0) {
      lines.push(this.frameLine('', innerWidth));
      lines.push(this.frameLine(chalk.dim('Suggested prompts:'), innerWidth));
      for (const [index, question] of this.clarificationInfo.suggestedQuestions.entries()) {
        for (const line of wrapTextWithAnsi(`${index + 1}. ${question}`, innerWidth)) {
          lines.push(this.frameLine(line, innerWidth));
        }
      }
    }

    lines.push(renderSeparator(width, { border: chalk.dim }));
    for (const line of this.editor.render(innerWidth)) {
      lines.push(this.frameLine(line, innerWidth));
    }
    lines.push(renderSeparator(width, { border: chalk.dim }));
    lines.push(this.frameLine(chalk.dim('Enter submit | Esc cancel'), innerWidth));
    lines.push(renderBottomBorder(width, { border: chalk.cyan }));

    return lines;
  }

  private frameLine(content: string, width: number): string {
    return renderFrameLine(` ${content} `, width + 2, { border: chalk.cyan });
  }
}

export function createClarificationDialog(
  tui: TUI,
  clarificationInfo: ClarificationInfo
): ClarificationDialog {
  return new ClarificationDialog(tui, clarificationInfo);
}
