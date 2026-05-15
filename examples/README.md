# AdaptiveAgent Examples

## Quick Start

### 1. Set up environment variables

```bash
cp .env.example .env
```

Edit `.env` and fill in the keys you need:

| Variable | Required | Purpose |
|----------|----------|---------|
| `OPENROUTER_API_KEY` | If using OpenRouter | [Get key →](https://openrouter.ai/keys) |
| `MISTRAL_API_KEY` | If using Mistral | [Get key →](https://console.mistral.ai/api-keys) |
| `MESH_API_KEY` | If using Mesh | [Docs →](https://docs.meshapi.ai/) |
| `WEB_SEARCH_PROVIDER` | Optional | Set to `brave` or `duckduckgo` for `web_search` |
| `BRAVE_SEARCH_API_KEY` | If `WEB_SEARCH_PROVIDER=brave` | [Get key →](https://api.search.brave.com/app/keys) |
| `AGENT_MAX_STEPS` | Optional | Override the sample agent's max steps; when unset it uses the core default of 30 |
| `TOOL_TIMEOUT_MS` | Optional | Override the sample agent's default timeout for all tool calls in milliseconds; set to `0` to disable |
| `WEB_TOOL_TIMEOUT_MS` | Optional | Override the timeout for `web_search` and `read_web_page` in milliseconds |
| `MODEL_TIMEOUT_MS` | Optional | Override the agent-side timeout for each model turn in milliseconds; set to `0` to disable |

Mesh uses the OpenAI-compatible gateway documented at `docs.meshapi.ai` and defaults to `https://api.meshapi.ai/v1`, so only the base URL and API key differ from a standard OpenAI client setup.

**Ollama requires no API key** — just have it running locally (`ollama serve`). The example now relies on the runtime's longer default model timeout for `ollama` because local inference can take longer.

### 2. Ensure Ollama is running (for local usage)

```bash
# Pull a model if you haven't
ollama pull qwen3.5

# Ollama should be serving on http://localhost:11434
ollama serve
```

### 3. Run the sample

```bash
# Default: uses Ollama with qwen3.5
bun run examples/run-agent.ts

# Interactive chat demo
bun run examples/run-chat.ts

# Custom goal
bun run examples/run-agent.ts "Explain the architecture of this project"

# Use a different Ollama model
OLLAMA_MODEL=deepseek-r1:14b bun run examples/run-agent.ts

# Use OpenRouter
PROVIDER=openrouter OPENROUTER_API_KEY=sk-or-... bun run examples/run-agent.ts

# Use Mistral
PROVIDER=mistral MISTRAL_API_KEY=... bun run examples/run-agent.ts

# Use Mesh
PROVIDER=mesh MESH_API_KEY=... bun run examples/run-agent.ts

# Use DuckDuckGo for web_search instead of Brave
WEB_SEARCH_PROVIDER=duckduckgo bun run examples/run-agent.ts

# Give web tools more time for slower sites
WEB_TOOL_TIMEOUT_MS=120000 bun run examples/run-agent.ts

# Raise or disable the default timeout for all tool calls
TOOL_TIMEOUT_MS=120000 bun run examples/run-agent.ts
TOOL_TIMEOUT_MS=0 bun run examples/run-agent.ts

# Allow longer delegated research runs before MAX_STEPS
AGENT_MAX_STEPS=60 bun run examples/run-agent.ts

# Let model turns run longer, or disable the agent-side timeout entirely
MODEL_TIMEOUT_MS=300000 bun run examples/run-agent.ts
MODEL_TIMEOUT_MS=0 bun run examples/run-agent.ts

# Set a persistent chat persona
CHAT_SYSTEM_PROMPT="You are a terse staff engineer." bun run examples/run-chat.ts
```

## What the sample does

1. Creates a model adapter for your chosen provider
2. Registers built-in tools (`read_file`, `list_directory`, `write_file`, optionally `web_search` + `read_web_page`)
3. Loads skills from `examples/skills/` as delegate profiles
4. Runs the agent with your goal
5. Prints the result, event timeline, and any child runs

## Chat Demo

`examples/run-chat.ts` shows the smallest chat-style integration on top of `agent.chat(...)`.

- It keeps an in-memory transcript of `system`, `user`, and `assistant` messages.
- Each turn sends the full transcript back through `agent.chat({ messages })`.
- It uses no tools, so it behaves like a plain conversational assistant.
- `/clear` resets the transcript, `/history` prints the current transcript, and `/exit` quits.

## Skills

Skills are defined as SKILL.md files with YAML frontmatter:

```
examples/skills/
├── researcher/SKILL.md      # web_search + read_web_page
└── file-analyst/SKILL.md    # read_file + list_directory
```

Skills are automatically converted to delegate profiles (`delegate.researcher`, `delegate.file-analyst`). The agent can choose to invoke them when it determines a sub-agent is appropriate for part of the task.

Skills can also override child-run defaults with dotted frontmatter keys such as `defaults.toolTimeoutMs: 120000` or `defaults.modelTimeoutMs: 0`. That is the most precise way to give a delegate like `code-executor` more time without slowing down every other tool.

Skills may also declare `handler: handler.ts`. When present, the handler module is loaded as a child-run tool, which makes it a good fit for integrations such as MCP clients. See `examples/skills/mcp-echo/` for a minimal stdio MCP example that spawns a local server, sends `initialize` and `tools/call`, and returns the result to the delegated skill run.

`examples/skills/file-converter/` shows the same handler-backed pattern for local document conversion with `pandoc`, defaulting output to Markdown unless the caller requests a different target format.

Skills whose required tools are unavailable (e.g. `researcher` when `WEB_SEARCH_PROVIDER=brave` and `BRAVE_SEARCH_API_KEY` is missing) are skipped automatically.
