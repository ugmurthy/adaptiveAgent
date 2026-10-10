import type { SwarmSubtask, SwarmSubtaskResult } from '@adaptive-agent/core';

const ANSI_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]/g;

export function formatSwarmExecutionPlan(sessionId: string, coordinatorRunId: string, subtasks: readonly SwarmSubtask[], wrapWidth?: number): string {
  return [
    `orchestration: session=${sessionId} coordinator=${coordinatorRunId}`,
    formatSwarmSubtasks(subtasks, wrapWidth),
  ].join('\n');
}

export function formatSwarmSubtasks(subtasks: readonly SwarmSubtask[], wrapWidth = resolveDefaultWrapWidth()): string {
  const lines = ['subtasks:'];
  for (const [index, subtask] of subtasks.entries()) {
    const target = subtask.targetAgentId ? ` -> ${subtask.targetAgentId}` : '';
    const label = `  ${index + 1}. ${subtask.id}${target}: `;
    lines.push(...wrapLabeledPlainText(label, subtask.subObjective, wrapWidth));
  }
  return lines.join('\n');
}

export function formatSwarmRunStatuses(result: {
  subtaskResults: readonly Pick<SwarmSubtaskResult, 'subtaskId' | 'runId' | 'status' | 'errorCode'>[];
  qualityRunId?: string;
  synthesizerRunId?: string;
}): string {
  const lines = ['runs:'];
  if (result.subtaskResults.length === 0) {
    lines.push('  workers: (none)');
  } else {
    lines.push('  workers:');
    for (const subtask of result.subtaskResults) {
      const error = subtask.errorCode ? ` error=${subtask.errorCode}` : '';
      lines.push(`    - ${subtask.subtaskId}: run=${subtask.runId} status=${subtask.status}${error}`);
    }
  }
  if (result.qualityRunId) lines.push(`  quality: run=${result.qualityRunId}`);
  if (result.synthesizerRunId) lines.push(`  synthesizer: run=${result.synthesizerRunId}`);
  return lines.join('\n');
}

function wrapLabeledPlainText(label: string, value: string, wrapWidth: number): string[] {
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return [label.trimEnd()];

  const width = Number.isFinite(wrapWidth) && wrapWidth >= 20 ? Math.floor(wrapWidth) : Number.POSITIVE_INFINITY;
  if (visibleLength(label) + visibleLength(text) <= width) {
    return [`${label}${text}`];
  }

  const continuationIndent = ' '.repeat(visibleLength(label));
  const continuationIndentWidth = visibleLength(continuationIndent);
  const lines: string[] = [];
  let current = label;
  let currentWidth = visibleLength(label);
  let hasTextOnCurrentLine = false;

  for (const word of text.split(/\s+/)) {
    const separatorWidth = hasTextOnCurrentLine ? 1 : 0;
    const nextWidth = currentWidth + separatorWidth + visibleLength(word);
    if (hasTextOnCurrentLine && nextWidth > width) {
      lines.push(current.trimEnd());
      current = `${continuationIndent}${word}`;
      currentWidth = continuationIndentWidth + visibleLength(word);
      hasTextOnCurrentLine = true;
      continue;
    }

    if (hasTextOnCurrentLine) {
      current += ' ';
      currentWidth += 1;
    }
    current += word;
    currentWidth += visibleLength(word);
    hasTextOnCurrentLine = true;
  }

  if (hasTextOnCurrentLine) {
    lines.push(current.trimEnd());
  }
  return lines.length > 0 ? lines : [label.trimEnd()];
}

function visibleLength(value: string): number {
  return value.replace(ANSI_PATTERN, '').length;
}

function resolveDefaultWrapWidth(): number {
  const columns = typeof process.stderr.columns === 'number' && process.stderr.columns > 0
    ? process.stderr.columns
    : typeof process.stdout.columns === 'number' && process.stdout.columns > 0
      ? process.stdout.columns
      : 100;
  return Math.max(40, columns - 4);
}
