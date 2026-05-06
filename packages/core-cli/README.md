# @adaptive-agent/core-cli

Local-only CLI host for `@adaptive-agent/core`. It loads one explicit agent JSON file, resolves local built-in tools and optional delegate skills, then runs an AdaptiveAgent directly in-process without the Fastify gateway, WebSockets, JWT auth, channel routing, or gateway-owned stores.

## Usage

```bash
bun run packages/core-cli/src/cli.ts --agent ./agent.json run "Summarize this repo"
ADAPTIVE_AGENT_CONFIG=./agent.json bun run packages/core-cli/src/cli.ts chat
bun run packages/core-cli/src/cli.ts --agent ~/.adaptiveAgent/agents/default-agent.json config
```

To make the CLI executable from any folder, link the workspace package once:

```bash
bun run core:cli:link
```

Then run `core:cli`, `core-agent`, or `adaptive-agent-core` from any directory on your machine. Config lookup still uses the directory where you invoke the command, so `./agent.json` resolves relative to your current shell location.

Agent config lookup order:

1. `--agent <path>` or `--agent-config <path>`
2. `ADAPTIVE_AGENT_CONFIG`
3. `./agent.json`
4. `~/.adaptiveAgent/agents/default-agent.json`

## Agent JSON

```json
{
  "id": "local-agent",
  "name": "Local Agent",
  "invocationModes": ["chat", "run"],
  "defaultInvocationMode": "run",
  "model": {
    "provider": "ollama",
    "model": "qwen3.5"
  },
  "workspaceRoot": "$HOME/riding-amp/AgentSmith",
  "systemInstructions": "You are a local coding assistant.",
  "tools": ["read_file", "list_directory", "write_file", "shell_exec"],
  "delegates": [],
  "defaults": {
    "maxSteps": 30,
    "capture": "summary"
  }
}
```

Supported local tools are `read_file`, `list_directory`, `write_file`, `shell_exec`, `web_search`, and `read_web_page`. File and shell tools are rooted at `workspaceRoot`.

`openrouter`, `mistral`, and `mesh` model configs may use `apiKey` or `apiKeyEnv`; when neither is supplied the CLI also checks `OPENROUTER_API_KEY`, `MISTRAL_API_KEY`, or `MESH_API_KEY` for the matching provider.

## Commands

```bash
core-agent run <goal>
core-agent chat
core-agent chat <message>
core-agent resume <run-id>
core-agent retry <run-id>
core-agent inspect <run-id>
core-agent config
```

By default the CLI uses in-memory core runtime stores. `--runtime postgres` enables durable core runtime stores using `DATABASE_URL` and runs the core runtime migrations before creating the agent.
