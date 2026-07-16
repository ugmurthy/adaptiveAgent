export const DEFAULT_MESSAGE_PREVIEW_CHARS = 160;

const GLOBAL_OPTIONS = `Database options:
  --database-url <url>   Postgres connection string. Defaults to DATABASE_URL.
  --database-url-env <n> Read the connection string from this environment variable.
  --config <path>        Config containing connectionString/databaseUrl or urlEnv.
  --pgssl                Enable Postgres SSL with rejectUnauthorized=false.
  -h, --help             Show help.`;

export const USAGE = `Trace persisted AdaptiveAgent sessions and runs.

Usage:
  trace-session <command> [arguments] [options]

Commands:
  view         Inspect one persisted session or run tree.
  compare      Compare two focused runs.
  list         Discover persisted sessions and runs.
  aggregate    Aggregate performance across root traces.
  usage        Report usage for a session or run.
  maintenance  Generate reviewable maintenance output.

Run "trace-session <command> --help" for command-specific help.

${GLOBAL_OPTIONS}`;

const VIEW_USAGE = `Usage:
  trace-session view session <session-id> [--root-run <root-run-id>] [options]
  trace-session view root-run <root-run-id> [options]
  trace-session view run <run-id> [options]

View options:
  --report <name>        Report: summary (default), reliability, operations, brief,
                         output, investigate, policy, milestones, timeline, delegates,
                         messages, plans, or all. overview/performance are aliases.
  --focus-run <id>       Limit the report to a run subtree within the traced tree.
  --messages             Include snapshot-backed LLM message context.
  --reasoning            Include assistant reasoning. Implies --messages.
  --messages-view <mode> Message view: compact, delta, or full. Implies --messages.
  --system-only          Include only system messages. Implies --messages.
  --include-plans        Include plan execution and step details.
  --only-delegates       Print only delegate diagnostics in the human report.
  --preview-chars <n>    Limit free-form terminal previews. Default: ${DEFAULT_MESSAGE_PREVIEW_CHARS}.
  --json                 Print the report as JSON.
  --html <path>          Write a self-contained static HTML report.
  --fresh                Bypass cached data and replace it.
  --no-cache             Disable persistent cache reads and writes.
  --cache-ttl <duration> Override cache TTL (0 or a duration with ms/s/m/h/d).

${GLOBAL_OPTIONS}`;

const COMPARE_USAGE = `Usage:
  trace-session compare <baseline-run-id> <candidate-run-id> [options]

Compare options:
  --json                 Print the comparison as JSON.
  --html <path>          Write a self-contained static HTML comparison.
  --fresh                Bypass cached data and replace it.
  --no-cache             Disable persistent cache reads and writes.
  --cache-ttl <duration> Override cache TTL (0 or a duration with ms/s/m/h/d).

${GLOBAL_OPTIONS}`;

const LIST_USAGE = `Usage:
  trace-session list sessions [options]
  trace-session list traces [options]
  trace-session list sessionless-runs [--json] [database options]

List options (sessions and traces):
  --goal <text>          Filter goals by case-insensitive text (repeatable OR).
  --goal-regex <regex>   Filter goals by a case-insensitive regular expression.
  --has-goal             Show only entries with goals.
  --no-goal              Show only entries without goals.
  --status <status>      Filter run status (repeatable OR).
  --type <type>          Filter run, chat, swarm, or swarm-run (repeatable OR).
  --swarm-role <role>    Filter coordinator, worker, quality, or synthesizer.
  --since <time>         Include entries at/after a duration or ISO timestamp.
  --until <time>         Include entries at/before a duration or ISO timestamp.
  --limit <n>            Limit the number of entries.
  --preview-chars <n>    Limit free-form terminal previews. Default: ${DEFAULT_MESSAGE_PREVIEW_CHARS}.
  --json                 Print the list as JSON.

${GLOBAL_OPTIONS}`;

const AGGREGATE_USAGE = `Usage:
  trace-session aggregate <model|status|day> [options]

Aggregate options:
  --since <time>         Set the start of the duration or ISO time window.
  --until <time>         Set the end of the duration or ISO time window.
  --json                 Print the aggregate report as JSON.
  --html <path>          Write a self-contained static HTML aggregate report.

${GLOBAL_OPTIONS}`;

const USAGE_REPORT_USAGE = `Usage:
  trace-session usage session <session-id> [options]
  trace-session usage root-run <root-run-id> [options]
  trace-session usage run <run-id> [options]

Usage report options:
  --json                 Print usage as JSON.
  --fresh                Bypass cached data and replace it.
  --no-cache             Disable persistent cache reads and writes.
  --cache-ttl <duration> Override cache TTL (0 or a duration with ms/s/m/h/d).

${GLOBAL_OPTIONS}`;

const MAINTENANCE_USAGE = `Usage:
  trace-session maintenance empty-goal-sql [options]

Print reviewable legacy gateway SQL for sessions whose goals are empty or null.
No SQL is executed.

Maintenance options:
  --json                 Render using the JSON-compatible output mode.

${GLOBAL_OPTIONS}`;

export function usageForArgs(args: string[]): string {
  const normalized = args[0] === 'trace-session' ? args.slice(1) : args;
  switch (normalized[0]) {
    case 'view': return VIEW_USAGE;
    case 'compare': return COMPARE_USAGE;
    case 'list': return LIST_USAGE;
    case 'aggregate': return AGGREGATE_USAGE;
    case 'usage': return USAGE_REPORT_USAGE;
    case 'maintenance': return MAINTENANCE_USAGE;
    default: return USAGE;
  }
}
