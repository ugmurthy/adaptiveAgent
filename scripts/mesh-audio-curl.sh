#!/usr/bin/env zsh

set -euo pipefail

if [[ $# -gt 1 ]]; then
  echo "Usage: $0 [audio-path]" >&2
  exit 1
fi

if [[ -z "${MESH_API_KEY:-}" ]]; then
  echo "MESH_API_KEY is required." >&2
  exit 1
fi

AUDIO_PATH="${1:-${AUDIO_PATH:-}}"
if [[ -z "${AUDIO_PATH}" ]]; then
  echo "Provide an audio path as the first argument or set AUDIO_PATH." >&2
  exit 1
fi

if [[ ! -f "${AUDIO_PATH}" ]]; then
  echo "Audio file not found: ${AUDIO_PATH}" >&2
  exit 1
fi

MODEL="${MODEL:-google/gemini-3-flash-preview}"
MESH_BASE_URL="${MESH_BASE_URL:-https://api.meshapi.ai/v1}"
GOAL="${GOAL:-Convert the attached audio to text and then translate it to hindi}"
INPUT_TICKET_ID="${INPUT_TICKET_ID:-audio 001}"
INSTRUCTION_TEXT="${INSTRUCTION_TEXT:-Ensure that you present the text in table form indicate language}"

audio_ext="${AUDIO_PATH##*.}"
audio_ext="${audio_ext:l}"

case "${audio_ext}" in
  mp3|wav|flac|m4a|ogg|aiff|aac|pcm16|pcm24)
    AUDIO_FORMAT="${AUDIO_FORMAT:-${audio_ext}}"
    ;;
  *)
    AUDIO_FORMAT="${AUDIO_FORMAT:-mp3}"
    ;;
esac

audio_b64="$(base64 < "${AUDIO_PATH}" | tr -d '\n')"
payload_file="$(mktemp)"

cleanup() {
  rm -f "${payload_file}"
}
trap cleanup EXIT

cat > "${payload_file}" <<EOF
{
  "model": "${MODEL}",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "{\n  \"goal\": \"${GOAL}\",\n  \"input\": {\n    \"ticketId\": \"${INPUT_TICKET_ID}\"\n  },\n  \"context\": {}\n}"
        },
        {
          "type": "text",
          "text": "${INSTRUCTION_TEXT}"
        },
        {
          "type": "input_audio",
          "input_audio": {
            "data": "${audio_b64}",
            "format": "${AUDIO_FORMAT}"
          }
        }
      ]
    }
  ],
  "stream": false
}
EOF

echo "POST ${MESH_BASE_URL}/chat/completions" >&2
echo "model=${MODEL} format=${AUDIO_FORMAT} audio=${AUDIO_PATH}" >&2

curl --silent --show-error --location \
  --request POST "${MESH_BASE_URL}/chat/completions" \
  --header "Authorization: Bearer ${MESH_API_KEY}" \
  --header "Content-Type: application/json" \
  --data-binary "@${payload_file}"
