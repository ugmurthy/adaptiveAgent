# AdaptiveAgent

## What is AdaptiveAgent?

AdaptiveAgent is the operating layer for reliable AI agents.

It is a Bun + TypeScript runtime and CLI stack for running goal-oriented agents with typed tools, structured events, approvals, resumable runs, retries, child-run delegation, and multi-model support. It helps teams move from fragile agent demos to controlled, inspectable, recoverable production workflows.

## Getting Started in 60secs

### 1. Install

macOS:

```bash
curl -fsSL https://github.com/ugmurthy/adaptiveAgent/releases/latest/download/install.sh | sh
```

Linux:

```bash
curl -fsSL https://github.com/ugmurthy/adaptiveAgent/releases/latest/download/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://github.com/ugmurthy/adaptiveAgent/releases/latest/download/install.ps1 | iex
```

If the installer says `adaptive-agent` is not on your `PATH`, run the exact PATH command it prints.

### 2. Add an API key

The default hosted quickstart uses OpenRouter:

```bash
export OPENROUTER_API_KEY="<your-key>"
```

Windows PowerShell:

```powershell
$env:OPENROUTER_API_KEY = "<your-key>"
```

Other supported providers use their own keys:

- OpenRouter: `OPENROUTER_API_KEY`
- Mistral: `MISTRAL_API_KEY`
- Mesh: `MESH_API_KEY`
- Ollama: no API key, but Ollama must be running locally

### 3. Init and run

```bash
adaptive-agent init
adaptive-agent doctor --provider-check
adaptive-agent run "Hello, confirm you are working"
```

That is it. You now have a configured local agent that can run goals, use tools, and produce inspectable runtime history.

## Repository packages

This monorepo is intentionally small:

- `@adaptive-agent/core` in `packages/core`: runtime semantics, durable stores, events, snapshots, tools, delegation, retry, and continuation.
- `@adaptive-agent/agent-sdk` in `packages/agent-sdk`: user-facing `adaptive-agent` CLI, config loading, built-in tool registration, install/update flows, and evaluation helpers.
- `@adaptive-agent/trace-session` in `packages/trace-session`: standalone Postgres trace reporter for core runtime runs and optional legacy gateway session tables.

Useful local commands:

```bash
bun run core:test
bun run agent:build
bun run trace-session --run <run-id>
```
