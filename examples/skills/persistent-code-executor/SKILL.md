---
name: persistent-code-executor
description: Execute multiple related code cells in one persistent E2B sandbox for the duration of a delegated run.
handler: handler.ts
allowedTools: []
defaults.maxSteps: 16
defaults.toolTimeoutMs: 180000
defaults.modelTimeoutMs: 0
---

# Persistent Code Executor

Use this delegate when a task needs repeated code execution where later cells
depend on variables, imports, installed packages, files, or intermediate results
from earlier cells.

This delegate is intentionally separate from the existing `code-executor` so
callers can still choose one-shot isolated execution when persistence is not
needed.

Guidelines:

- Use the handler tool for all execution and sandbox file uploads.
- Prefer `action: "run"` for normal Python execution. The first run in a child
  run creates a sandbox; subsequent runs reuse the same sandbox and interpreter
  state.
- Include `files` on `action: "run"` when code needs local files or generated
  inline content. Files are uploaded before the code cell executes.
- Use `action: "upload"` to stage files in the sandbox without executing code.
  Each file must provide an absolute `sandboxPath` and exactly one of
  `sourcePath`, `content`, or `base64`.
- Keep related setup, imports, helper functions, and data files in the sandbox
  instead of recreating them in every tool call.
- Request `action: "status"` when you need the current sandbox id or lifecycle
  details.
- Always call `action: "close"` when execution is complete or when the task is
  abandoned. This releases the remote sandbox immediately instead of waiting for
  TTL expiry.
- If execution becomes unhealthy, call `action: "close"` and report the failure
  rather than continuing to spend sandbox time.
- Do not use this delegate for unrelated user requests; one child run should own
  one coherent execution session.

Safety and cost controls:

- The sandbox is created with an E2B timeout and `onTimeout: "kill"`.
- Each successful use extends the sandbox timeout only up to the configured idle
  TTL.
- The handler schedules local idle cleanup as a second line of defense.
- Runtime aborts and infrastructure errors attempt to kill the sandbox.
