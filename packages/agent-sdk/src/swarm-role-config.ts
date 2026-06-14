import type { AgentConfigFile } from './index.js';

export type SwarmRoleAgentKind = 'quality' | 'synthesizer';

export function createSwarmRoleAgentConfig(base: AgentConfigFile, role: SwarmRoleAgentKind): AgentConfigFile {
  const roleInstructions = role === 'quality'
    ? [
        'Swarm quality role: evaluate completed worker runs against the provided top-level objective and subtask objectives.',
        'Do not decompose the task, create subtasks, assign targetAgentId values, or return a plan.',
        'Return only the structured quality assessment requested by the output schema.',
      ].join(' ')
    : [
        'Swarm synthesizer role: produce the final answer or artifact for the top-level objective from worker outputs and quality assessments.',
        'Do not decompose the task, create subtasks, assign targetAgentId values, or return a plan.',
        'Do not return JSON containing subtasks or targetAgentId unless the user explicitly requested that JSON as the final deliverable.',
        'If the objective asks for a file or artifact, create the final artifact content using the available worker results and tools.',
      ].join(' ');
  const baseInstructions = base.systemInstructions?.trim();
  const systemInstructions = [
    roleInstructions,
    baseInstructions
      ? [
          'Base profile context follows for domain, style, safety, and tool-use preferences only.',
          `If it conflicts with the swarm ${role} role above, follow the swarm ${role} role.`,
          baseInstructions,
        ].join('\n')
      : undefined,
  ].filter(Boolean).join('\n\n');

  return {
    ...base,
    id: `${base.id}-${role}`,
    name: `${base.name} ${role}`,
    systemInstructions,
  };
}
