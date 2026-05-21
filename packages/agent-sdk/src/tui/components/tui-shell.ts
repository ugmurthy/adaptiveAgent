import type { Component, Terminal } from '@earendil-works/pi-tui';
import type { MessageLog } from './message-log.js';

export class TuiShell implements Component {
  private terminal: Terminal;
  private statusBar: Component;
  private messageLog: MessageLog;
  private inputPanel: Component;

  constructor(terminal: Terminal, statusBar: Component, messageLog: MessageLog, inputPanel: Component) {
    this.terminal = terminal;
    this.statusBar = statusBar;
    this.messageLog = messageLog;
    this.inputPanel = inputPanel;
  }

  render(width: number): string[] {
    const statusLines = this.statusBar.render(width);
    const inputLines = this.inputPanel.render(width);
    const availableMessageLines = Math.max(1, this.terminal.rows - statusLines.length - inputLines.length);
    const messageLines = this.messageLog.renderViewport(width, availableMessageLines);
    const paddingLines = Array.from(
      { length: Math.max(0, availableMessageLines - messageLines.length) },
      () => '',
    );

    return [...paddingLines, ...messageLines, ...statusLines, ...inputLines];
  }

  invalidate(): void {
    this.statusBar.invalidate();
    this.messageLog.invalidate();
    this.inputPanel.invalidate();
  }
}
