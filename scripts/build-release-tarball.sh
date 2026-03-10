#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="openclaw-memory-layer-bundle"
VERSION="$(node -p "require('$ROOT/engine/package.json').version")"
STAGE="$ROOT/dist/${NAME}-${VERSION}"
ARCHIVE="$ROOT/dist/${NAME}-${VERSION}.tar.gz"

rm -rf "$STAGE"
mkdir -p "$STAGE"
mkdir -p "$ROOT/dist"

cp -R "$ROOT/engine" "$STAGE/engine"
cp -R "$ROOT/plugin" "$STAGE/plugin"
cp -R "$ROOT/install" "$STAGE/install"
cp -R "$ROOT/templates" "$STAGE/templates"
cp -R "$ROOT/docs" "$STAGE/docs"
cp "$ROOT/CHANGELOG.md" "$STAGE/CHANGELOG.md"
cp "$ROOT/README.md" "$STAGE/README.md"
cp "$ROOT/LICENSE" "$STAGE/LICENSE"
cp "$ROOT/RELEASE.md" "$STAGE/RELEASE.md"

find "$STAGE" -name '.DS_Store' -delete
find "$STAGE" -name 'node_modules' -type d -prune -exec rm -rf {} +
find "$STAGE" -name '.git' -type d -prune -exec rm -rf {} +

tar -C "$ROOT/dist" -czf "$ARCHIVE" "${NAME}-${VERSION}"
echo "$ARCHIVE"
