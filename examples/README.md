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
| `BRAVE_SEARCH_API_KEY` | For web search tools | [Get key →](https://api.search.brave.com/app/keys) |

**Ollama requires no API key** — just have it running locally (`ollama serve`).

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

# Custom goal
bun run examples/run-agent.ts "Explain the architecture of this project"

# Use a different Ollama model
OLLAMA_MODEL=deepseek-r1:14b bun run examples/run-agent.ts

# Use OpenRouter
PROVIDER=openrouter OPENROUTER_API_KEY=sk-or-... bun run examples/run-agent.ts

# Use Mistral
PROVIDER=mistral MISTRAL_API_KEY=... bun run examples/run-agent.ts
```

## What the sample does

1. Creates a model adapter for your chosen provider
2. Registers built-in tools (`read_file`, `list_directory`, `write_file`, optionally `web_search` + `read_web_page`)
3. Loads skills from `examples/skills/` as delegate profiles
4. Runs the agent with your goal
5. Prints the result, event timeline, and any child runs

## Skills

Skills are defined as SKILL.md files with YAML frontmatter:

```
examples/skills/
├── researcher/SKILL.md      # web_search + read_web_page
└── file-analyst/SKILL.md    # read_file + list_directory
```

Skills are automatically converted to delegate profiles (`delegate.researcher`, `delegate.file-analyst`). The agent can choose to invoke them when it determines a sub-agent is appropriate for part of the task.

Skills whose required tools are unavailable (e.g. `researcher` when `BRAVE_SEARCH_API_KEY` is missing) are skipped automatically.
