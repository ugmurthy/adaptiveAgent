import chalk from 'chalk';
import type { Component, Editor } from '@earendil-works/pi-tui';
import type { TuiClientState } from '../types.js';
import { renderBottomBorder, renderFrameLine, renderTopBorder } from './box-frame.js';

const STALE_EVENT_THRESHOLD_MS = 5000;
const MODEL_THINKING_EVENT_TYPES = new Set(['model.started']);

export class InputPanel implements Component {
  private state: TuiClientState;
  private editor: Editor;

  constructor(state: TuiClientState, editor: Editor) {
    this.state = state;
    this.editor = editor;
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 2);
    const lines: string[] = [];
    lines.push(renderTopBorder(width, { border: chalk.dim }));
    lines.push(this.frameLine(this.formatPrimaryStatus(), innerWidth));
    lines.push(this.frameLine(this.formatConnectionContext(), innerWidth));

    const eventLine = this.formatEventStatus();
    if (eventLine) {
      lines.push(this.frameLine(eventLine, innerWidth));
    }

    for (const editorLine of this.editor.render(innerWidth)) {
      lines.push(this.frameLine(editorLine, innerWidth));
    }

    lines.push(this.frameLine(chalk.dim('Enter to send | \\ + Enter for newline | /help for commands'), innerWidth));
    lines.push(renderBottomBorder(width, { border: chalk.dim }));

    return lines;
  }

  invalidate(): void {
    this.editor.invalidate();
  }

  private frameLine(content: string, width: number): string {
    return renderFrameLine(content, width, { border: chalk.dim });
  }

  private formatPrimaryStatus(): string {
    const parts = [
      this.state.busy ? chalk.yellow('running') : chalk.green('ready'),
      `agent ${this.state.agentId}`,
      `mode ${this.state.invocationMode}`,
    ];

    if (this.state.currentRunId) {
      parts.push(`run ${this.state.currentRunId.slice(0, 12)}`);
    }

    parts.push(`events ${this.state.eventMode}`);

    if (this.state.pendingApprovalRunId) {
      parts.push(chalk.yellow(`approval ${this.state.pendingApprovalRunId.slice(0, 8)}`));
    }

    if (this.state.pendingClarificationRunId) {
      parts.push(chalk.yellow(`clarify ${this.state.pendingClarificationRunId.slice(0, 8)}`));
    }

    return parts.join(chalk.dim(' | '));
  }

  private formatConnectionContext(): string {
    const parts = [
      `runtime ${this.state.runtimeMode}`,
      `model ${this.state.provider ?? 'provider?'}/${this.state.model ?? 'model?'}`,
    ];

    return parts.join(chalk.dim(' | '));
  }

  private formatEventStatus(): string | undefined {
    const event = this.state.latestAgentEvent;
    if (!event) {
      return chalk.dim('live event none yet');
    }

    const elapsedMs = Date.now() - event.timestamp.getTime();
    const parts = [chalk.dim('live'), event.compactText];

    if (MODEL_THINKING_EVENT_TYPES.has(event.eventType)) {
      parts.push(chalk.yellow(`thinking ${formatElapsed(elapsedMs)}`));
    } else if (elapsedMs >= STALE_EVENT_THRESHOLD_MS) {
      parts.push(chalk.dim(`(idle ${formatElapsed(elapsedMs)})`));
    }

    return parts.join(chalk.dim(' | '));
  }
}

function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return '0s';
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m${remainingSeconds}s`;
}
