export const DEFAULT_MESSAGE_PREVIEW_CHARS = 160;

export const USAGE = `Usage:
  adaptive-agent-trace-session <sessionId> [options]
  adaptive-agent-trace-session --root-run <rootRunId> [options]
  adaptive-agent-trace-session --run <runId> [options]
  adaptive-agent-trace-session --ls [options]
  adaptive-agent-trace-session --lsp [options]
  adaptive-agent-trace-session --ls-sessionless [options]
  adaptive-agent-trace-session --delete [options]
  adaptive-agent-trace-session <sessionId> --usage [options]
  trace-session <sessionId> [options]
  bun run ./src/trace-session.ts <sessionId> [options]

Options:
  --ls                   List sessions and associated goals, newest first.
  --lsp                  List sessions/runs as compact performance cards.
  --goal <text>          Filter list goals by case-insensitive text (repeatable OR).
  --goal-regex <regex>   Filter list goals by a case-insensitive regular expression.
  --has-goal             Show only list entries with goals; --no-goal shows those without.
  --status <status>      Filter list run status (repeatable OR).
  --type <type>          Filter list type: run, chat, swarm, or swarm-run (repeatable OR).
  --swarm-role <role>    Filter swarm role: coordinator, worker, quality, or synthesizer.
  --limit <n>            Limit --ls sessions or --lsp run cards.
  --ls-sessionless       List root runs that are not linked to any session.
  --delete               Print legacy gateway SQL to delete sessions whose goals are empty or null.
  --usage                Print usage totals for the session and all linked root runs.
  --fresh                Bypass cached data and replace it when caching is enabled.
  --no-cache             Disable persistent cache reads and writes.
  --cache-ttl <duration> Override cache TTL (0 or a duration with ms/s/m/h/d).
  --database-url <url>   Postgres connection string. Defaults to DATABASE_URL.
  --database-url-env <n> Read the Postgres connection string from this env var instead of DATABASE_URL.
  --pgssl                Enable Postgres SSL with rejectUnauthorized=false.
  --messages             Include the current snapshot-backed LLM message context.
  --reasoning            Include assistant reasoning from snapshots in message reports. Implies --messages.
  --messages-view <mode> Message view: compact, delta, or full. Default: compact.
  --system-only          Include only system messages in the LLM message view.
  --view <name>          View: summary (default), reliability, operations, brief, output, investigate, policy, milestones, timeline, delegates, messages, plans, or all. overview/performance are aliases.
  --focus-run <id>       Limit the rendered report to a run subtree within the traced tree.
  --preview-chars <n>    Preview length for --ls goals and compact/delta message views. Default: ${DEFAULT_MESSAGE_PREVIEW_CHARS}
  --json                 Print the trace report as JSON.
  --html <path>          Write a self-contained static HTML trace report.
  --root-run <id>        Restrict a session trace to one root run, or trace that root run directly.
  --run <id>             Trace the root run tree that contains this run id.
  --include-plans        Include plan execution and step details.
  --only-delegates       Print only delegate diagnostics in the human report.
  --config <path>        Optional trace config path. Accepts connectionString/databaseUrl or urlEnv.
  --help                 Show this help.`;
