import chalk from 'chalk';
import {
  SelectList,
  type TUI,
  type SelectListTheme,
  type Component,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui';
import type { ApprovalInfo } from '../types.js';
import { renderBottomBorder, renderFrameLine, renderSeparator, renderTopBorder } from './box-frame.js';

const approvalTheme: SelectListTheme = {
  selectedPrefix: (text) => chalk.green(text),
  selectedText: (text) => chalk.green(text),
  description: (text) => chalk.dim(text),
  scrollInfo: (text) => chalk.dim(text),
  noMatch: (text) => chalk.yellow(text),
};

export class ApprovalDialog implements Component {
  private approvalInfo: ApprovalInfo;
  private selectList: SelectList;

  constructor(_tui: TUI, approvalInfo: ApprovalInfo) {
    this.approvalInfo = approvalInfo;

    this.selectList = new SelectList(
      [
        { value: 'yes', label: 'Approve and resume', description: 'Allow this action to proceed' },
        { value: 'no', label: 'Reject', description: 'Deny this action' },
      ],
      2,
      approvalTheme
    );
  }

  onApprovalResolved?: (approved: boolean) => void;
  onCancel?: () => void;

  getSelectList(): SelectList {
    return this.selectList;
  }

  getApprovalInfo(): ApprovalInfo {
    return this.approvalInfo;
  }

  invalidate(): void {
    this.selectList.invalidate();
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 4);
    const lines: string[] = [];

    lines.push(renderTopBorder(width, { border: chalk.yellow }, `Approval Required${this.approvalInfo.toolName ? `: ${this.approvalInfo.toolName}` : ''}`));
    lines.push(this.frameLine(chalk.dim(`runId: ${this.approvalInfo.runId}`), innerWidth));
    if (this.approvalInfo.toolName) {
      lines.push(this.frameLine(`tool: ${this.approvalInfo.toolName}`, innerWidth));
    }
    lines.push(renderSeparator(width, { border: chalk.dim }));

    const reason = this.approvalInfo.reason ?? 'The agent is waiting for permission before continuing.';
    for (const line of wrapTextWithAnsi(`Reason: ${reason}`, innerWidth)) {
      lines.push(this.frameLine(line, innerWidth));
    }

    lines.push(this.frameLine('', innerWidth));
    for (const line of this.selectList.render(innerWidth)) {
      lines.push(this.frameLine(line, innerWidth));
    }
    lines.push(renderSeparator(width, { border: chalk.dim }));
    lines.push(this.frameLine(chalk.dim('Enter submit | Esc cancel'), innerWidth));
    lines.push(renderBottomBorder(width, { border: chalk.yellow }));

    return lines;
  }

  private frameLine(content: string, width: number): string {
    return renderFrameLine(` ${content} `, width + 2, { border: chalk.yellow });
  }
}

export function createApprovalDialog(
  tui: TUI,
  approvalInfo: ApprovalInfo
): { dialog: ApprovalDialog; selectList: SelectList } {
  const dialog = new ApprovalDialog(tui, approvalInfo);
  const selectList = dialog.getSelectList();

  return { dialog, selectList };
}
