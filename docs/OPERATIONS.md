# Operations

## Re-ingest docs

```bash
node "$HOME/.openclaw/memory-layer/engine/bin/ingest-docs.js" \
  "$HOME/.openclaw/workspace" \
  "**/*.md"
```

## Health

```bash
node "$HOME/.openclaw/memory-layer/engine/bin/health-check.js"
```

## Direct search

```bash
node "$HOME/.openclaw/memory-layer/engine/bin/search.js" \
  --query "telegram group policy" \
  --limit 3 \
  --json
```
