import { stdin, stderr } from 'node:process';

import type { JsonObject, JsonValue } from '@adaptive-agent/core';
import type { AgentCreatePrepared, AgentCreateReport } from '@adaptive-agent/agent-sdk/agent-create';

import { promptYesNo } from './terminal-interactions.js';

export type AgentCreateOutputFormat = 'pretty' | 'json' | 'jsonl';

export function renderAgentCreateReport(report: AgentCreateReport, output: AgentCreateOutputFormat = 'pretty'): string {
  if (output === 'json') {
    return JSON.stringify(agentCreateReportJson(report), null, 2);
  }

  if (output === 'jsonl') {
    return JSON.stringify(agentCreateReportJson(report));
  }

  const lines = report.prompted
    ? [
        report.message,
        `path: ${report.prepared.path}`,
      ]
    : [
        renderAgentCreatePreview(report.prepared),
        '',
        report.message,
      ];
  return lines.join('\n');
}

export function renderAgentCreatePreview(prepared: AgentCreatePrepared): string {
  const agent = prepared.agent;
  const model = agent.model;
  const lines = [
    'New agent config',
    '',
    'Path:',
    `  ${prepared.path}`,
    '',
    'Generator:',
    `  ${prepared.generatorAgent.id} (${prepared.generatorAgent.name})`,
    '',
    'Identity:',
    `  id: ${agent.id}`,
    `  name: ${agent.name}`,
    `  description: ${agent.description ?? '(none)'}`,
    '',
    'Runtime:',
    `  provider: ${model.provider ?? '(from settings)'}`,
    `  model: ${model.model ?? '(from settings)'}`,
    `  invocationModes: ${agent.invocationModes.join(', ')}`,
    `  defaultInvocationMode: ${agent.defaultInvocationMode}`,
    `  workspaceRoot: ${agent.workspaceRoot ?? agent.workspace?.root ?? '(current workspace)'}`,
    '',
    'Tools:',
    ...formatList(agent.tools),
    '',
    'Delegates:',
    ...formatList(agent.delegates ?? []),
    '',
    'System instructions:',
    ...indentBlock(agent.systemInstructions),
  ];

  if (prepared.notes.length > 0) {
    lines.push('', 'Notes:', ...formatList(prepared.notes));
  }

  if (prepared.recommendations.length > 0) {
    lines.push('', 'Recommendations:', ...formatList(prepared.recommendations));
  }

  return lines.join('\n');
}

export async function confirmAgentCreateInTerminal(prepared: AgentCreatePrepared): Promise<boolean> {
  stderr.write(`${renderAgentCreatePreview(prepared)}\n\n`);
  if (!stdin.isTTY) {
    throw new Error('agent-create requires --yes to write in a non-interactive terminal.');
  }
  return promptYesNo('Write this agent config? [y/N] ');
}

function agentCreateReportJson(report: AgentCreateReport): JsonObject {
  return {
    command: report.command,
    status: report.status,
    dryRun: report.dryRun,
    yes: report.yes,
    force: report.force,
    prompted: report.prompted,
    message: report.message,
    path: report.prepared.path,
    agentsDir: report.prepared.agentsDir,
    generatorAgent: report.prepared.generatorAgent,
    agent: report.prepared.agent as unknown as JsonValue,
    notes: report.prepared.notes,
    recommendations: report.prepared.recommendations,
  };
}

function formatList(values: readonly string[]): string[] {
  if (values.length === 0) return ['  none'];
  return values.map((value) => `  - ${value}`);
}

function indentBlock(value: string | undefined): string[] {
  const lines = value?.trim().split(/\r?\n/) ?? [];
  if (lines.length === 0) return ['  (none)'];
  return lines.map((line) => `  ${line}`);
}
