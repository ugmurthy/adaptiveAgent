export const DEFAULT_MESSAGE_PREVIEW_CHARS = 160;

export const DEFAULT_TRACE_CONFIG_PATH = '~/.adaptiveAgent/config/gateway.json';

export const USAGE = `Usage:
  bun run trace-session <sessionId> [options]
  bun run trace-session --root-run <rootRunId> [options]
  bun run trace-session --run <runId> [options]
  bun run trace-session --ls [options]
  bun run trace-session --ls-sessionless [options]
  bun run trace-session --delete [options]
  bun run trace-session <sessionId> --usage [options]
  bun run ./src/trace-session.ts trace-session <sessionId> [options]

Options:
  --ls                   List sessions and associated goals, newest first.
  --ls-sessionless       List root runs that are not linked to any gateway session.
  --delete               Print SQL to delete sessions whose goals are empty or null.
  --usage                Print usage totals for the session and all linked root runs.
  --messages             Include the current snapshot-backed LLM message context.
  --messages-view <mode> Message view: compact, delta, or full. Default: compact.
  --system-only          Include only system messages in the LLM message view.
  --view <name>          Report view: overview, milestones, timeline, delegates, messages, plans, or all.
  --focus-run <id>       Limit the rendered report to a run subtree within the traced tree.
  --preview-chars <n>    Preview length for compact and delta message views. Default: ${DEFAULT_MESSAGE_PREVIEW_CHARS}
  --json                 Print the trace report as JSON.
  --root-run <id>        Restrict a session trace to one root run, or trace that root run directly.
  --run <id>             Trace the root run tree that contains this run id.
  --include-plans        Include plan execution and step details.
  --only-delegates       Print only delegate diagnostics in the human report.
  --config <path>        Gateway config path. Default: ${DEFAULT_TRACE_CONFIG_PATH}
  --help                 Show this help.`;
