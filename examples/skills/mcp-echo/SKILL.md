---
name: mcp-echo
description: Call a simple MCP echo service through a handler-backed tool
handler: handler.ts
allowedTools: []
---

# MCP Echo

Use the `mcp_echo` tool when the task is to call the demo MCP service.

Guidelines:

- Prefer `mcp_echo` over free-form text when the user asks for an MCP-backed response.
- Pass the user's message through exactly unless they explicitly ask you to transform it.
- Return the tool result directly and mention that it came from the MCP service.
