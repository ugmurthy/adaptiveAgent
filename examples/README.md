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

Skills whose required tools are unavailable (e.g. `researcher` when `WEB_SEARCH_PROVIDER=brave` and `BRAVE_SEARCH_API_KEY` is missing) are skipped automatically.

## IPL Bulletin

`examples/ipl-bulletin.ts` produces a styled IPL 2026 bulletin (points table, recent matches, upcoming matches, Monte Carlo playoff/winner predictions) end-to-end. It is the deterministic successor to `examples/ipl2.sh`.

### Why this exists

The `21-april-log.md` post-mortem shows the prior IPL run failing at step 5 with a 76-minute model timeout. The root cause was almost certainly the LLM trying to "do" the Monte Carlo simulation by emitting tokens — model providers cannot reliably roll thousands of dice in their output stream. The bulletin pipeline replaces that token-driven simulation with two deterministic skills:

- **`examples/skills/cricket-analyst/`** — `delegate.cricket-analyst` returns IPL points table, fixtures, and player form from a curated JSON source (or bundled fixture). Removes the brittle scraping that ipl2.sh had to blacklist (`espncricinfo.com`, `iplt20.com`).
- **`examples/skills/monte-carlo/`** — `delegate.monte-carlo` runs `simulate_match` (Bradley-Terry probability) and `simulate_tournament` (10,000 rollouts in TypeScript) deterministically. 10k iterations on the full remainder runs in well under 2 seconds.

### Run it

```bash
# Default: today's date, online (uses curated mirror if CRICKET_DATA_BASE_URL is set, else fixture)
bun run examples/ipl-bulletin.ts

# Frozen date for reproducibility
bun run examples/ipl-bulletin.ts --date 2026-04-28

# Offline / fixtures only — useful in CI and for repeatable bulletins
bun run examples/ipl-bulletin.ts --no-network
```

### Env

| Variable                | Required | Purpose |
| ----------------------- | -------- | ------- |
| `PROVIDER`              | No       | `ollama` (default), `openrouter`, `mistral`, or `mesh`. |
| `OLLAMA_MODEL`          | No       | Default `qwen3.5`. |
| `CRICKET_DATA_BASE_URL` | No       | Optional JSON mirror serving `/ipl-2026-points-table.json`, `/ipl-2026-fixtures.json`, `/ipl-2026-player-form.json`. When unset, the bundled fixtures are used. |

### Output

Writes to `sport-bulletin-<date>.html` in the current working directory. The HTML matches the visual style of `sport.html` (Arial, light-gray container, blue headings) and embeds an attribution footer linking to [@murthyug](https://twitter.com/murthyug).

### Determinism

Same `--date` plus same fixture data plus same seed produces a bit-identical bulletin. The default seed is derived from the date so two runs on the same day match without specifying `--seed`. See `examples/skills/monte-carlo/seeding.test.ts` for the reproducibility contract.
