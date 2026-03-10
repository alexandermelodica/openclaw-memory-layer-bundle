#!/usr/bin/env bash
set -euo pipefail

BUNDLE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_ROOT="${MEMORY_LAYER_HOME:-$HOME/.openclaw/memory-layer}"
ENGINE_TARGET="$TARGET_ROOT/engine"
OPENCLAW_CONFIG="${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}"
ALLOW_OVERWRITE="${ALLOW_OVERWRITE_INSTALL:-false}"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

need node
need npm
need sqlite3
need openclaw

if [[ -e "$ENGINE_TARGET" || -e "$TARGET_ROOT/db/memory.sqlite" ]]; then
  if [[ "$ALLOW_OVERWRITE" != "true" ]]; then
    cat <<EOF
Existing memory-layer installation detected at:
- $ENGINE_TARGET
- $TARGET_ROOT/db/memory.sqlite

This script is for first-time installation only.

If you are updating from a previous version, use:
  ./install/upgrade-to-scoped-memory.sh

If you intentionally want to overwrite this installation, rerun with:
  ALLOW_OVERWRITE_INSTALL=true ./install/install-openclaw-memory-layer.sh
EOF
    exit 1
  fi
fi

mkdir -p "$TARGET_ROOT"
rm -rf "$ENGINE_TARGET"
cp -R "$BUNDLE_ROOT/engine" "$ENGINE_TARGET"

(
  cd "$ENGINE_TARGET"
  npm install --omit=dev
  node bin/init-db.js
)

openclaw plugins install "$BUNDLE_ROOT/plugin"
node "$BUNDLE_ROOT/install/patch-openclaw-config.js" "$OPENCLAW_CONFIG" "$ENGINE_TARGET"

echo
echo "Installed OpenClaw Memory Layer."
echo "Engine root: $ENGINE_TARGET"
echo "Config patched: $OPENCLAW_CONFIG"
echo
echo "Next steps:"
echo "1. Ensure Ollama is running and model 'nomic-embed-text' is available."
echo "2. Ingest docs:"
echo "   node \"$ENGINE_TARGET/bin/ingest-docs.js\" \"$HOME/.openclaw/workspace\" \"**/*.md\""
echo "3. Restart the OpenClaw gateway."
echo "4. Run smoke test:"
echo "   \"$BUNDLE_ROOT/install/smoke-test.sh\""
