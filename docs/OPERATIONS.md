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

## Telegram scoped memory

For multi-chat Telegram deployments, do not use one shared recall pool.

Use scoped memory metadata and retrieval layering as described in:

- `docs/TELEGRAM-SCOPED-MEMORY.md`
- `engine/memory/migrations/001_telegram_scoping.sql`
