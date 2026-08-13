# AdaptiveAgent Desktop

Minimal Tauri 2 desktop client for the compiled `@adaptive-agent/desktop-bridge` sidecar.

## Configuration

The sidecar uses the Agent SDK's normal lookup rules: `ADAPTIVE_AGENT_SETTINGS`, then
`agent.settings.json` in the launch working directory, then
`~/.adaptiveAgent/agent.settings.json`. The settings file selects a separate agent JSON
definition with `agent.configPath`; `agent.id`, when present, is a matching assertion.

The Agent Studio opens one native workspace window per agent. It allows three agent
windows by default; set `ADAPTIVE_AGENT_MAX_WINDOWS` to a positive integer before
launch to change the limit. Invalid values fall back to three and appear in catalog
diagnostics.

Release candidates must complete the automated and cross-platform checks in
[`RELEASE-CHECKLIST.md`](RELEASE-CHECKLIST.md).

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

The renderer uses a narrow set of typed workbench commands for runs, chats, approvals,
recovery, history, trace privacy, and shutdown. It receives simplified progress/final
events. No shell capability or generic JSON-RPC command is granted to the webview.

## Product decisions and current limitations

- **Create / Auto:** Auto is deterministic: prompts beginning with `chat:`, `discuss:`,
  or `talk about` create a chat; everything else starts a task. Explicit Task and Chat
  modes bypass this heuristic. Attachments are unavailable.
- **Steering and recovery:** steering appears only while a run is steerable and affects
  the next model step. Eligible failed and interrupted runs expose one Recover action;
  core selects the safe same-run recovery strategy from current durable state. New-run
  continuation is not exposed as a desktop recovery control.
- **Results:** Run artifacts are inferred from structured `files`/`artifacts` arrays or
  recognizable filenames in the result. The artifact library includes only artifacts from
  runs represented by the rail's currently filtered History items. Clicking a filename opens
  a confined in-app preview for text, rendered HTML/Markdown, JSON, images, and supported
  videos. Export downloads either the privacy-projected Inspector Overview as JSON or the final
  displayed result as Markdown.
- **Search:** history search covers task titles and chat titles/messages already loaded
  by the desktop app; it is not a backend-wide or file-content search. Saved items are not
  modeled or shown.
- **Privacy:** sensitive messages, reasoning, and raw tool payloads are opt-in under
  Inspector Diagnostics and may expose private data locally.
- **Capacity and windows:** each agent has its own three-run execution capacity. Selecting
  an agent creates or focuses its native workspace window; closing that window does not
  stop active runs. On narrow windows navigation and Inspector become overlay drawers.
