#!/usr/bin/env bash
set -euo pipefail

TARGET_ROOT="${MEMORY_LAYER_HOME:-$HOME/.openclaw/memory-layer}"
ENGINE_TARGET="$TARGET_ROOT/engine"

node "$ENGINE_TARGET/bin/health-check.js"
node "$ENGINE_TARGET/bin/search.js" --query "memory layer health" --limit 3 --json || true
openclaw plugins list | rg "global-memory|loaded|enabled" || true
