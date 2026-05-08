#!/usr/bin/env bash
set -euo pipefail

# steer-run.sh — inject a user message into an in-progress agent run via the
# gateway's POST /api/runs/:runId/steer endpoint.
#
# The message lands at the next step boundary (after any in-flight tool calls
# drain) as a role:user model message and a `run.steered` event is emitted.
#
# Required environment:
#   GATEWAY_URL        Base URL of the gateway (e.g. http://localhost:3000)
#   GATEWAY_TOKEN      Admin JWT bearer token for the gateway
#
# Optional:
#   STEER_ROLE         "user" (default) or "system"
#   STEER_METADATA     Inline JSON object passed as metadata.
#                      Example: '{"source":"cli"}'

usage() {
  cat >&2 <<'USAGE'
Usage: steer-run.sh <run-id> <message...>

Required env:
  GATEWAY_URL    Base URL of the gateway, e.g. http://localhost:3000
  GATEWAY_TOKEN  Admin JWT for the gateway

Optional env:
  STEER_ROLE     "user" (default) or "system"
  STEER_METADATA Inline JSON object, e.g. '{"source":"cli"}'

Examples:
  GATEWAY_URL=http://localhost:3000 GATEWAY_TOKEN=$JWT \
    steer-run.sh 7c1f... "Switch focus to performance benchmarks."

  STEER_ROLE=system STEER_METADATA='{"source":"ops"}' \
    steer-run.sh 7c1f... "Prefer cached results for the next 5 minutes."
USAGE
}

if [[ $# -lt 2 ]]; then
  usage
  exit 2
fi

run_id=$1
shift
message=$*

if [[ -z "${GATEWAY_URL:-}" ]]; then
  echo "Error: GATEWAY_URL is not set." >&2
  exit 1
fi

if [[ -z "${GATEWAY_TOKEN:-}" ]]; then
  echo "Error: GATEWAY_TOKEN is not set." >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq is required to build the request body." >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "Error: curl is required." >&2
  exit 1
fi

role=${STEER_ROLE:-user}
case "$role" in
  user|system) ;;
  *)
    echo "Error: STEER_ROLE must be 'user' or 'system' (got '$role')." >&2
    exit 1
    ;;
esac

if [[ -n "${STEER_METADATA:-}" ]]; then
  if ! echo "$STEER_METADATA" | jq -e 'type == "object"' >/dev/null 2>&1; then
    echo "Error: STEER_METADATA must be a JSON object." >&2
    exit 1
  fi
  body=$(jq -n \
    --arg message "$message" \
    --arg role "$role" \
    --argjson metadata "$STEER_METADATA" \
    '{message: $message, role: $role, metadata: $metadata}')
else
  body=$(jq -n \
    --arg message "$message" \
    --arg role "$role" \
    '{message: $message, role: $role}')
fi

base_url=${GATEWAY_URL%/}
url="$base_url/api/runs/$run_id/steer"

response_file=$(mktemp)
trap 'rm -f "$response_file"' EXIT

http_code=$(curl --silent --show-error \
  --output "$response_file" \
  --write-out '%{http_code}' \
  --request POST \
  --header "Authorization: Bearer $GATEWAY_TOKEN" \
  --header 'Content-Type: application/json' \
  --data "$body" \
  "$url")

if [[ "$http_code" -ge 200 && "$http_code" -lt 300 ]]; then
  jq . "$response_file" 2>/dev/null || cat "$response_file"
  echo
  exit 0
fi

echo "Error: gateway responded with HTTP $http_code" >&2
jq . "$response_file" >&2 2>/dev/null || cat "$response_file" >&2
echo >&2
exit 1
