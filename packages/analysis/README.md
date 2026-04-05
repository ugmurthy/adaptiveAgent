# @adaptive-agent/analysis

`@adaptive-agent/analysis` is a Bun + TypeScript workspace for analyzing adaptive-agent NDJSON logs. It can scan one or more log files, reconstruct runs, summarize failures and bottlenecks, compare cohorts by provider/model/delegate, and export reports in terminal, JSON, Markdown, HTML, and CSV formats.

## Requirements

- Bun
- adaptive-agent logs in newline-delimited JSON format

## Quick Start

From the repository root:

```bash
bun install
bun packages/analysis/src/cli.ts --help
```

Analyze the sample log already checked into this repo:

```bash
bun packages/analysis/src/cli.ts analyze logs/adaptive-agent-example-day4.log
```

Build the packaged CLI and run it from `dist/`:

```bash
bun run --cwd packages/analysis build
./packages/analysis/dist/cli.js analyze logs/adaptive-agent-example-day4.log
```

## CLI Usage

```bash
analysis analyze [options] <file|directory|glob> [more inputs...]
```

Inputs can be:

- a single file such as `logs/day4.log`
- a directory such as `logs/`
- a glob such as `logs/**/*.log`

Common options:

- `--format, -f <formats>`: `terminal`, `json`, `markdown`, `html`, `csv`, `csv:runs`, `csv:tools`, `csv:failures`, `csv:cohorts`
- `--output, -o <path>`: write one file, or a directory when multiple formats are selected
- `--config <path>`: load defaults from `analysis.config.json` or another config file
- `--profile <name>`: use a built-in or config-defined profile
- `--watch`: poll for file changes and re-run analysis
- `--watch-interval <ms>`: polling interval, default `1000`
- `--window <hour|day>`: cohort comparison window, default `day`
- `--run <runId>`: drill into one run
- `--root-run <rootRunId>`: drill into an entire root run tree

## Common Examples

Analyze one file and print the terminal report:

```bash
bun packages/analysis/src/cli.ts analyze logs/adaptive-agent-example-day4.log
```

Analyze every matching log and emit Markdown, HTML, and all CSV reports into a directory:

```bash
bun packages/analysis/src/cli.ts analyze \
  --format markdown,html,csv \
  --output artifacts/analysis-reports \
  "logs/**/*.log"
```

Write a single JSON report to a file:

```bash
bun packages/analysis/src/cli.ts analyze \
  --format json \
  --output artifacts/analysis.json \
  logs/adaptive-agent-example-day4.log
```

Watch a directory for new or updated logs:

```bash
bun packages/analysis/src/cli.ts analyze \
  --watch \
  --watch-interval 2000 \
  logs/
```

Inspect a specific root run from the sample log:

```bash
bun packages/analysis/src/cli.ts analyze \
  --root-run a6d9e997-e7e3-4feb-b003-ac0a660df3f1 \
  logs/adaptive-agent-example-day4.log
```

## Output Formats

When you select one format and provide `--output`, the CLI writes exactly one file at that path.

When you select multiple formats and provide `--output`, the CLI treats that path as a directory and writes default filenames:

- `terminal` -> `analysis.txt`
- `json` -> `analysis.json`
- `markdown` -> `analysis.md`
- `html` -> `analysis.html`
- `csv:runs` -> `runs.csv`
- `csv:tools` -> `tools.csv`
- `csv:failures` -> `failures.csv`
- `csv:cohorts` -> `cohorts.csv`

`csv` is a shortcut that expands to all four CSV exports.

## Built-In Profiles

The CLI includes these built-in profiles:

- `overview`: terminal overview report
- `failures`: terminal report plus `csv:failures`
- `bottlenecks`: terminal report plus `csv:runs`
- `compare`: terminal report plus `csv:cohorts`, with a default `day` window

Example:

```bash
bun packages/analysis/src/cli.ts analyze \
  --profile compare \
  logs/adaptive-agent-example-day4.log
```

## Configuration File

If you do not pass `--config`, the CLI looks for `analysis.config.json` in the current working directory. Command-line values override config values.

Example config:

```json
{
  "inputs": ["logs/**/*.log"],
  "profile": "compare",
  "outputs": {
    "formats": ["terminal", "csv:cohorts"],
    "output": "artifacts/analysis"
  },
  "thresholds": {
    "durationMultiplier": 1.5,
    "successRateDrop": 0.15,
    "tokenMultiplier": 1.5,
    "toolCountMultiplier": 1.5,
    "minimumBaselineRuns": 1
  },
  "compare": {
    "timeWindow": "day"
  },
  "watch": {
    "pollIntervalMs": 1000
  },
  "profiles": {
    "focused-failures": {
      "view": "failures",
      "formats": ["html", "csv:failures"],
      "output": "artifacts/failures",
      "watchPollIntervalMs": 2500
    }
  }
}
```

Run with config defaults only:

```bash
bun packages/analysis/src/cli.ts analyze --config analysis.config.json
```

Or select a custom profile from that config:

```bash
bun packages/analysis/src/cli.ts analyze \
  --config analysis.config.json \
  --profile focused-failures
```

## Drill-Down Reports

`--run` and `--root-run` switch the CLI from overview mode into single-run drill-down mode. Drill-down reports include:

- the selected run
- related child or parent runs
- a timeline of run and tool events
- failure clusters tied to that run tree

Drill-down mode supports `terminal`, `json`, `markdown`, and `html`. CSV exporters are intentionally rejected in drill-down mode.

## Development Commands

From the repository root:

```bash
bun run --cwd packages/analysis build
bun run --cwd packages/analysis test
bun run --cwd packages/analysis typecheck
```

## Programmatic Usage

The package also exports the analysis pipeline for direct use in TypeScript:

```ts
import { analyzeLogInputs, buildAnalysisBundle } from '@adaptive-agent/analysis'

const analysis = await analyzeLogInputs(['logs/adaptive-agent-example-day4.log'])

const report = buildAnalysisBundle(
  {
    inputCount: 1,
    fileCount: analysis.discovery.files.length,
    eventCount: analysis.parseResult.events.length,
    malformedLineCount: analysis.parseResult.malformedLineCount,
    diagnostics: analysis.diagnostics,
    runGraph: analysis.runGraph,
  },
  {
    timeWindow: 'day',
  },
)

console.log(report.summary)
```
