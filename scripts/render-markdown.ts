import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import { readFileSync } from 'fs';

// Configure marked with terminal theme
marked.use(markedTerminal());

// Get the markdown file path from command line argument
const filePath = process.argv[2];

if (!filePath) {
  console.error('Usage: bun run scripts/render-markdown.ts <markdown-file>');
  process.exit(1);
}

// Read the markdown file
const markdownContent = readFileSync(filePath, 'utf-8');

// Parse and render to terminal
const rendered = marked.parse(markdownContent);
console.log(rendered);
