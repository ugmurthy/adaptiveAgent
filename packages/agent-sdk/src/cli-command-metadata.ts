export const ADAPTIVE_AGENT_CLI_COMMANDS = [
  'run',
  'chat',
  'spec',
  'swarm-run',
  'ambient',
  'retry',
  'inspect',
  'resume',
  'recover',
  'continue',
  'interrupt',
  'replay',
  'eval',
  'config',
  'catalog',
  'init',
  'doctor',
  'update',
  'uninstall',
  'agent-create',
  'context',
  'version',
] as const;

export type AdaptiveAgentCliCommand = (typeof ADAPTIVE_AGENT_CLI_COMMANDS)[number];
export type AdaptiveAgentPositionalCommand = Exclude<AdaptiveAgentCliCommand, 'version'>;

export const ADAPTIVE_AGENT_POSITIONAL_COMMANDS: readonly AdaptiveAgentPositionalCommand[] =
  ADAPTIVE_AGENT_CLI_COMMANDS.filter(
    (command): command is AdaptiveAgentPositionalCommand => command !== 'version',
  );

export const ADAPTIVE_AGENT_CLI_SUBCOMMANDS = {
  ambient: ['start'],
  eval: ['cases', 'gaia'],
  context: ['create', 'list', 'show', 'delete'],
} as const satisfies Partial<Record<AdaptiveAgentCliCommand, readonly string[]>>;
