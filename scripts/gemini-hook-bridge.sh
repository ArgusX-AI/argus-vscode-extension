#!/usr/bin/env bash
# Gemini CLI hook bridge - translates command-based hooks to HTTP POSTs for Argus.
EVENT_NAME="$1"
SERVER_URL="$2"
PAYLOAD=$(cat)
USER="${USER:-${USERNAME:-unknown}}"
curl -s -X POST "$SERVER_URL/hooks/$EVENT_NAME" \
  -H "Content-Type: application/json" \
  -H "X-Argus-User: $USER" \
  -H "X-Argus-Source: gemini-cli" \
  -d "$PAYLOAD" \
  -o /dev/null --max-time 5 2>/dev/null || true
echo '{}'
exit 0
