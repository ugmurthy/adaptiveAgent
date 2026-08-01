# AdaptiveAgent Desktop

Minimal Tauri 2 desktop client for the compiled `@adaptive-agent/desktop-bridge` sidecar.

## Configuration

The sidecar uses the Agent SDK's normal lookup rules: `ADAPTIVE_AGENT_SETTINGS`, then
`agent.settings.json` in the launch working directory, then
`~/.adaptiveAgent/agent.settings.json`. The settings file selects a separate agent JSON
definition with `agent.configPath`; `agent.id`, when present, is a matching assertion.

This MVP accepts only configured BYOK inference, an agent whose
`defaultInvocationMode` is `run`, approval mode `auto` or `reject`, and clarification
mode `fail`. Provider credentials are inherited by the native sidecar. Only an
availability boolean reaches the webview.

## Native development and builds

Install the platform prerequisites for Tauri 2, then run from the repository root:

```sh
bun run desktop-app:dev
bun run desktop-app:build
```

`scripts/prepare-sidecar.ts` compiles `agent-runtime` for the native Rust target and
places it under Tauri's target-triple sidecar name. Native macOS (arm64/x64), Linux
(arm64/x64), and Windows x64 targets are mapped. CI can set `TAURI_TARGET_TRIPLE` or
pass a triple to `bun run sidecar:prepare -- <triple>`.

The renderer has only four application commands: state, reload settings, start run,
and stop run. It receives simplified progress/final events. No shell capability or
generic JSON-RPC command is granted to the webview.
