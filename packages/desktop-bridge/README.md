# Adaptive Agent desktop bridge

`agent-runtime` is the local process boundary between a native desktop UI and
`@adaptive-agent/agent-sdk`. The sidecar owns execution loops, tools, provider
calls, profiles, and durable runtime access. Provider credentials and
`DATABASE_URL` are inherited from the process environment and are never
accepted in protocol messages.

## Transport and versions

The bridge reads one UTF-8 JSON object per line from stdin. It writes one JSON
object per line to stdout and reserves stderr for diagnostics. Requests may run
concurrently, so clients must correlate responses by `id` and process
notifications independently.

The bridge currently exposes protocol `1.10` over JSON-RPC 2.0. There is no
legacy custom-envelope compatibility: every request must use JSON-RPC,
including before initialization.

Protocol `1.10` is intentionally a string. In JSON, the numeric values `1.10`,
and `1.1` are indistinguishable, but those are different semantic versions.

At startup the bridge emits this JSON-RPC notification:

```json
{"jsonrpc":"2.0","method":"runtime/ready","params":{"protocolVersion":"1.10","bridgeVersion":"0.1.0","pid":1234}}
```

## Protocol 1.10 handshake

The first JSON-RPC request must negotiate the protocol. Once successful, the
connection is sticky: subsequent input and agent events use JSON-RPC only.

```json
{"jsonrpc":"2.0","id":"initialize","method":"initialize","params":{"protocolVersion":"1.10","clientInfo":{"name":"adaptive-agent-desktop","version":"1.0.0"},"capabilities":{}}}
```

The result advertises supported methods, notifications, and CLI commands:

```json
{"jsonrpc":"2.0","id":"initialize","result":{"protocolVersion":"1.10","bridgeVersion":"0.1.0","serverInfo":{"name":"@adaptive-agent/desktop-bridge","version":"0.1.0"},"capabilities":{"methods":["initialize","runtime/initialize","runtime/info","runtime/shutdown","agent/run","agent/chat","run/resume","run/retry","run/recover","run/continue","run/interrupt","run/inspect","run/replay","run/steer","interaction/resolveApproval","interaction/resolveClarification","cli/commands","cli/execute"],"notifications":["runtime/ready","agent/event","cli/output"]}}}
```

Initialize the persistent agent runtime separately. This allows setup,
inspection, and CLI commands to run without eagerly creating a model client or
database connection.

```json
{"jsonrpc":"2.0","id":"runtime","method":"runtime/initialize","params":{"cwd":"/workspace","agentConfigPath":"/profiles/agent.json","settingsConfigPath":"/profiles/agent.settings.json","runtimeMode":"postgres","provider":"openrouter","model":"openai/gpt-5","approvalMode":"manual","clarificationMode":"interactive"}}
```

## Typed JSON-RPC methods

Use typed methods for persistent desktop workflows. They share one `AgentSdk`,
stream `agent/event` notifications, and preserve approval, clarification,
steering, and in-memory run state.

| Method | Required params | Optional params |
| --- | --- | --- |
| `initialize` | `protocolVersion`, `clientInfo.name` | `clientInfo.version`, `capabilities` |
| `runtime/initialize` | - | `cwd`, `agentConfigPath`, `settingsConfigPath`, `runtimeMode`, `provider`, `model`, `approvalMode`, `clarificationMode` |
| `runtime/info` | - | - |
| `runtime/shutdown` | - | - |
| `agent/run` | `goal` | `sessionId`, `input` |
| `agent/chat` | `message` | `sessionId` |
| `run/resume` | `runId` | - |
| `run/retry` | `runId` | - |
| `run/recover` | `runId` | `strategy` (`auto`, `resume`, `retry`, `continue`), `dryRun` |
| `run/continue` | `runId` | - |
| `run/interrupt` | `runId` | - |
| `run/inspect` | `runId` | - |
| `run/replay` | `runId` | - |
| `run/steer` | `runId`, `message` | `role`, `metadata` |
| `interaction/resolveApproval` | `runId`, `approved` | - |
| `interaction/resolveClarification` | `runId`, `answer` | - |
| `cli/commands` | - | - |
| `cli/execute` | `argv` | `stdin`, `timeoutMs` (maximum 24 hours) |

Example run request:

```json
{"jsonrpc":"2.0","id":10,"method":"agent/run","params":{"goal":"Summarize this repository","sessionId":"desktop-session"}}
```

Events are notifications and have no `id`:

```json
{"jsonrpc":"2.0","method":"agent/event","params":{"schemaVersion":1,"type":"run.status_changed","runId":"..."}}
```

## CLI command coverage

`cli/execute` covers non-interactive CLI workflows without duplicating the
CLI parser in the desktop bridge. `argv` contains arguments after the
`adaptive-agent` executable name and is validated by the canonical
`parseCliArgs` implementation. The child is spawned directly without a shell,
cannot override environment variables, and defaults to `--output json` when no
output format is supplied.

```json
{"jsonrpc":"2.0","id":"catalog","method":"cli/execute","params":{"argv":["catalog","--cwd","/workspace"]}}
```

Child stdout and stderr are opaque lines carried in notifications. They can
never corrupt the parent protocol stream.

```json
{"jsonrpc":"2.0","method":"cli/output","params":{"requestId":"catalog","stream":"stdout","line":"{...}"}}
{"jsonrpc":"2.0","id":"catalog","result":{"command":"catalog","argv":["catalog","--cwd","/workspace","--output","json"],"exitCode":0,"timedOut":false}}
```

The protocol tracks the CLI surface below. Repeatable options remain
repeatable in `argv`.

| Command | Positionals/subcommands | Command options |
| --- | --- | --- |
| `run` | `<goal...>` | `--file`, `--input-json`, `--context-ref`, `--context-bundle`, `--image`, `--audio`, `--file-attachment`, `--orchestrate`, `--catalog`, common agent/run options |
| `chat` | `[message...]` | `--file`, `--context-ref`, `--context-bundle`, common agent/run options; an inline message, file, or `stdin` is required |
| `spec` | `<path>` or `--spec` | `--mode`, `--orchestrate`, `--catalog`, common agent/run options |
| `swarm-run` | `<task...>` | `--file`, `--agent`, `--worker-catalog`, `--input-json`, attachments, `--quality-agent`, `--synthesizer-agent`, `--max-workers`, `--session-id`, common runtime/run options |
| `ambient start` | `start` | `--config`, `--dry-run`, common agent options; advertised but not executable through the sidecar |
| `retry` | `<sessionId>` or `--run-id` | swarm retry uses `--agent`, `--worker-catalog`, `--quality-agent`, `--synthesizer-agent`, `--max-workers`; common agent/run options |
| `inspect` | `<runId>` or `--run-id` | common agent options |
| `resume` | `<runId>` or `--run-id` | common agent/run options |
| `recover` | `<runId>` or `--run-id` | `--strategy`, `--dry-run`, common agent/run options |
| `continue` | `<runId>` or `--run-id` | common agent/run options |
| `interrupt` | `<runId>` or `--run-id` | common agent options |
| `replay` | `<runId>` or `--run-id` | common agent options |
| `eval cases` | `cases` | `--input`, `--out`, `--artifacts`, `--resume`, `--fail-fast`, `--swarm`, `--limit`, `--offset`, `--ids`, `--level`, `--split`, `--orchestrate`, `--catalog`, common agent/run options |
| `eval gaia` | `gaia` | all `eval cases` options plus `--files-dir`, `--type` |
| `config` | - | common agent options |
| `catalog` | - | common agent options |
| `init` | - | `--provider`, `--model`, `--api-key-env`, `--profile`, `--minimal`, `--bundle`, `--install-agent`, `--install-skill`, `--install-manifest`, `--yes`, `--force`, `--dry-run`; `--yes` is required by `cli/execute` |
| `doctor` | - | `--agent`, `--settings`, `--runtime`, `--provider`, `--model`, `--network`, `--provider-check`, `--strict` |
| `update` | - | `--check`, `--version`, `--channel`, `--force`, `--yes`, `--repo`, `--base-url`; advertised but not executable through the sidecar |
| `uninstall` | - | `--dry-run`; advertised but not executable through the sidecar |
| `agent-create` | `<description...>` | `--file`, `--generator-agent`, `--id`, `--provider`, `--model`, `--yes`, `--force`, `--dry-run`; `--yes` is required by `cli/execute` |
| `context create` | `create <name>` | `--ref`, `--description`, `--force`, `--dry-run`, `--cwd`, `--output` |
| `context list` | `list` | `--cwd`, `--output` |
| `context show` | `show <name>` | `--cwd`, `--output` |
| `context delete` | `delete <name>` | `--dry-run`, `--cwd`, `--output` |
| `version` | `--version` | - |

Common agent options are `--cwd`, `--agent`, `--settings`, `--runtime`,
`--provider`, `--model`, `--approval`, and `--clarification`. Common run/output
options are `--progress`, `--events`, `--show-lines`, `--wrap-width`,
`--dry-run`, `--inspect`, and `--output`.

`ambient start`, `update`, and `uninstall` are denied by `cli/execute` because a
generic request must not start an unmanaged daemon or replace/remove installed
binaries. Help requests remain safe. Dedicated lifecycle methods can be added
in a later protocol version.

A CLI child is a separate process. It cannot observe a persistent runtime that
uses `memory`; use the corresponding typed method for run operations, or use a
Postgres runtime for cross-process inspection and recovery.

## Errors

Protocol 1.10 uses standard JSON-RPC codes and adds a stable protocol code in
`error.data.protocolCode`.

| JSON-RPC code | Meaning |
| --- | --- |
| `-32700` | Invalid JSON |
| `-32600` | Invalid request or unsupported batch |
| `-32601` | Unknown method |
| `-32602` | Invalid method params or CLI arguments |
| `-32603` | Unexpected internal error |
| `-32002` | Protocol or agent runtime not initialized |
| `-32003` | Protocol or agent runtime already initialized |
| `-32004` | Runtime is shutting down |
| `-32010` | CLI command rejected by sidecar policy |
| `-32011` | CLI command execution failed to start |

JSON-RPC batch requests and request notifications are not supported. Request
ids may be strings or finite numbers and are echoed without coercion.

## Build and smoke test

```sh
bun run compile
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"1.10","clientInfo":{"name":"smoke"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"cli/execute","params":{"argv":["--version"]}}' \
  | dist/agent-runtime
```

The removed protocol-v1 shape, such as
`{"version":1,"id":"hello","type":"hello"}`, is rejected with the same
JSON-RPC `INVALID_REQUEST` response before and after initialization.
