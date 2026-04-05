#!/usr/bin/env -S bun run

import { markedTerminal } from "marked-terminal";
import { marked } from "marked";
import * as fs from "fs";

// Configure marked-terminal to style the markdown output
marked.setOptions({
  ...markedTerminal(),
});

// Get the markdown file path from command line arguments
const filePath = process.argv[2];

if (!filePath) {
  console.error("Usage: bun run scripts/render-md.ts <markdown-file>");
  process.exit(1);
}

// Check if file exists
if (!fs.existsSync(filePath)) {
  console.error(`Error: File not found: ${filePath}`);
  process.exit(1);
}

// Read and parse the markdown file
const markdownContent = fs.readFileSync(filePath, "utf-8");
const html = marked(markdownContent);

// Render to terminal
console.log(html);
