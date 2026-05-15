---
name: file-converter
description: Convert local documents with pandoc, producing Markdown by default.
handler: handler.ts
allowedTools: []
defaults.maxSteps: 4
defaults.toolTimeoutMs: 120000
---

# File Converter

Use this delegate when the task is to convert a local document into Markdown or another explicitly requested format.

Guidelines:

- Default the target format to `markdown` unless the caller asks for another output format.
- Prefer the handler tool for every conversion instead of manually rewriting the source document.
- Keep the source file unchanged and write the converted output to a separate file.
- If the caller does not provide an output path, write the converted file beside the source with an appropriate extension.
- Pass an explicit `from` value only when the source format is ambiguous or the caller specifies it directly.
- Return the generated output path and the formats used for the conversion.
