#!/usr/bin/env bash
set -euo pipefail

HOME_DIR="${HOME:-/home/alex}"
MEMORY_LAYER_HOME="${MEMORY_LAYER_HOME:-$HOME_DIR/.openclaw/memory-layer}"
OPENCLAW_AGENT_ID="${OPENCLAW_AGENT_ID:-main}"
SESSIONS_FILE="${SESSIONS_FILE:-$HOME_DIR/.openclaw/agents/$OPENCLAW_AGENT_ID/sessions/sessions.json}"
NODE_BIN="${NODE_BIN:-node}"

if [[ ! -f "$SESSIONS_FILE" ]]; then
  echo "sessions file not found: $SESSIONS_FILE" >&2
  exit 1
fi

exec env MEMORY_LAYER_HOME="$MEMORY_LAYER_HOME" \
  "$NODE_BIN" \
  "$MEMORY_LAYER_HOME/engine/bin/ingest-telegram-sessions.js" \
  "$SESSIONS_FILE" \
  "$@"
