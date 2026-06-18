#!/bin/bash

# Usage: ./examples/writing-adaptive-agent.sh "Your topic here"
# Example: ./examples/writing-adaptive-agent.sh "The impact of Grok 4 on open source AI"
#
# This variant uses the adaptive-agent CLI instead of examples/run-agent.ts.
# Set ADAPTIVE_AGENT_BIN to override the executable path when needed.

set -euo pipefail

TOPIC="${1:-}"

# Check if topic is provided
if [ -z "$TOPIC" ]; then
  echo "Error: Please provide a quoted topic string."
  echo "Usage: $0 \"Your topic goes here\""
  exit 1
fi

# Create TOPIC_TITLE: Take first 10 characters and replace spaces with _
TOPIC_TITLE=$(echo "${TOPIC:0:10}" | tr ' ' '_' | tr -dc '[:alnum:]_')

# Get current date in YYYYMMMDD format (e.g., 2026Apr11)
DATE=$(date +%Y%b%d)

# Now properly substitute the variables
REQ=$(cat << PROMPT
Here is a style of writing from Simon Willison see url https://x.com/i/grok?conversation=2042828370938122497.
 A title followed by a high-level summary, then supported by pairs of (comments from Simon, quotes with website reference or names of authors or links to articles). The quotes are styled as proper quotes.

A series of summaries followed by supported pairs forms an article.

Write an article on "${TOPIC}" in the Simon Willison style and write to file ${DATE}-${TOPIC_TITLE}.html
- While selecting news ensure that they are no older than 7 days from today
- In the footer make no mention of styles used but do mention a disclaimer and inform that this is produced by AdaptiveAgent and point them to the author of AdaptiveAgent on twitter with handle @murthyug

PROMPT
)

echo "$REQ"

if [ -n "${ADAPTIVE_AGENT_BIN:-}" ]; then
  ADAPTIVE_AGENT_CMD=("$ADAPTIVE_AGENT_BIN")
elif command -v adaptive-agent >/dev/null 2>&1; then
  ADAPTIVE_AGENT_CMD=(adaptive-agent)
else
  ADAPTIVE_AGENT_CMD=(bun run ./packages/agent-sdk/src/adaptive-agent.ts)
fi

"${ADAPTIVE_AGENT_CMD[@]}" run "$REQ" --approval auto --events --progress
