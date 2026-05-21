import chalk from 'chalk';
import type { Component } from '@earendil-works/pi-tui';
import { truncateToWidth } from '@earendil-works/pi-tui';
import type { TuiClientState } from '../types.js';

export class StatusBar implements Component {
  private state: TuiClientState;
  private cachedLines?: string[];
  private cachedWidth?: number;

  constructor(state: TuiClientState) {
    this.state = state;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const parts: string[] = [];

    const status = this.state.busy ? chalk.yellow('[running]') : chalk.green('[ready]');
    parts.push(status);

    parts.push(`${this.state.agentId}`);
    parts.push(`${this.state.provider ?? 'provider?'}/${this.state.model ?? 'model?'}`);
    parts.push(`runtime: ${this.state.runtimeMode}`);
    parts.push(`mode: ${this.state.invocationMode}`);

    if (this.state.currentRunId && typeof this.state.currentRunId === 'string') {
      const shortId = this.state.currentRunId.slice(0, 12);
      parts.push(`run: ${shortId}`);
    }

    if (this.state.eventMode !== 'off') {
      parts.push(chalk.dim(`events: ${this.state.eventMode}`));
    }

    if (this.state.pendingApprovalRunId) {
      parts.push(chalk.yellow('[approval pending]'));
    }

    if (this.state.pendingClarificationRunId) {
      parts.push(chalk.yellow('[clarification pending]'));
    }

    let line = parts.join(' | ');
    line = truncateToWidth(line, width);

    this.cachedLines = [line];
    this.cachedWidth = width;
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.cachedWidth = undefined;
  }
}
