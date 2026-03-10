#!/usr/bin/env bash
set -euo pipefail

BUNDLE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIVE_CONFIG="${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}"
LIVE_DB="${LIVE_MEMORY_DB_PATH:-$HOME/.openclaw/workspace/memory/db/memory.sqlite}"
TARGET_ROOT="${SCOPED_MEMORY_LAYER_HOME:-$HOME/.openclaw/memory-layer}"
TARGET_ENGINE="$TARGET_ROOT/engine"
TARGET_DB="$TARGET_ROOT/db/memory.sqlite"
MIGRATION_SQL="$BUNDLE_ROOT/engine/memory/migrations/001_telegram_scoping.sql"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

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

if [[ ! -f "$LIVE_DB" ]]; then
  echo "Live memory DB not found: $LIVE_DB" >&2
  exit 1
fi

if [[ ! -f "$LIVE_CONFIG" ]]; then
  echo "OpenClaw config not found: $LIVE_CONFIG" >&2
  exit 1
fi

echo "==> Backing up live DB and config"
mkdir -p "$(dirname "$TARGET_DB")"
cp "$LIVE_DB" "${LIVE_DB}.backup-before-scoped-upgrade-${TIMESTAMP}"
cp "$LIVE_CONFIG" "${LIVE_CONFIG}.backup-before-scoped-upgrade-${TIMESTAMP}"

echo "==> Deploying new scoped engine to $TARGET_ENGINE"
rm -rf "$TARGET_ENGINE"
cp -R "$BUNDLE_ROOT/engine" "$TARGET_ENGINE"

echo "==> Installing engine dependencies"
(
  cd "$TARGET_ENGINE"
  npm install --omit=dev
)

echo "==> Copying live DB into scoped engine path"
cp "$LIVE_DB" "$TARGET_DB"

echo "==> Applying additive scoped migration"
sqlite3 "$TARGET_DB" < "$MIGRATION_SQL"

echo "==> Verifying scoped engine health"
MEMORY_LAYER_HOME="$TARGET_ROOT" node "$TARGET_ENGINE/bin/health-check.js"

echo "==> Patching OpenClaw config to point global-memory at scoped engine"
node "$BUNDLE_ROOT/install/patch-openclaw-config.js" "$LIVE_CONFIG" "$TARGET_ENGINE"

cat <<EOF

Scoped memory upgrade assets are ready.

What was done:
- live DB backup created
- live config backup created
- new engine deployed at: $TARGET_ENGINE
- copied DB migrated at: $TARGET_DB
- openclaw.json updated to use engineRoot: $TARGET_ENGINE

Manual next steps:
1. Review the updated OpenClaw config:
   cat "$LIVE_CONFIG"
2. Restart the gateway when you are ready:
   systemctl --user restart openclaw-gateway.service
3. Verify plugin and retrieval:
   openclaw plugins list
   MEMORY_LAYER_HOME="$TARGET_ROOT" node "$TARGET_ENGINE/bin/search.js" --query "telegram group policy" --json

Fast rollback:
1. Restore config backup:
   cp "${LIVE_CONFIG}.backup-before-scoped-upgrade-${TIMESTAMP}" "$LIVE_CONFIG"
2. Restart the gateway:
   systemctl --user restart openclaw-gateway.service

EOF
