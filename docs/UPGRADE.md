# Upgrade Guide

This guide describes how to update from the previous bundle version to the new
scoped Telegram-aware memory layer.

Use this guide only if a previous memory-layer version is already installed.

If this is a first-time installation, do not use the upgrade path. Use:

```bash
./install/install-openclaw-memory-layer.sh
```

## Supported Upgrade Paths

This document covers:

- `v0.1.0` to `v0.2.0`
- `v0.2.0` to `v0.2.1`

## Previous Version

Previous versions used a global memory model without Telegram-specific scoped
isolation.

That means:

- memory retrieval was global-first
- Telegram chats were not explicitly partitioned by `chat_id` or `thread_id`
- the schema did not contain the new scope fields

## New Version

`v0.2.0` introduces:

- `scope`
- `source`
- `chat_id`
- `thread_id`
- `user_id`
- `session_id`

And adds scope-aware retrieval policy:

- `session`
- `chat`
- `user`
- `global`

`v0.2.1` adds:

- a Telegram session writer for scoped durable notes
- a host-safe ingest wrapper for cron/systemd scheduling
- ranking changes so Telegram-local memory is preferred over irrelevant global noise

## Safe Upgrade Path

### 1. Back Up The Live DB

Do this before any migration:

```bash
cp ~/.openclaw/workspace/memory/db/memory.sqlite ~/.openclaw/workspace/memory/db/memory.sqlite.backup-$(date +%Y%m%d-%H%M%S)
```

### 2. Deploy The New Bundle In Parallel

Do not replace the live path immediately.

Install the new bundle into a separate path and keep the current plugin config
unchanged at first.

### 3. Copy The Live DB

Create a production-candidate copy:

```bash
mkdir -p ~/.openclaw/memory-layer-scope-staging/db
cp ~/.openclaw/workspace/memory/db/memory.sqlite ~/.openclaw/memory-layer-scope-staging/db/memory.sqlite
```

### 4. Apply The Migration To The Copy

```bash
sqlite3 ~/.openclaw/memory-layer-scope-staging/db/memory.sqlite < engine/memory/migrations/001_telegram_scoping.sql
```

### 5. Validate The New Engine On The Copied DB

Run:

```bash
MEMORY_LAYER_HOME=~/.openclaw/memory-layer-scope-staging node engine/bin/health-check.js
MEMORY_LAYER_HOME=~/.openclaw/memory-layer-scope-staging node engine/bin/search.js --query "telegram group policy" --json
```

### 6. Start Scoped Writes On The New Path

Only the new path should receive new scoped Telegram memory.

### 7. Run Shadow Validation

Compare old and new retrieval behavior before switching live prompt injection.

### 8. Switch Plugin Engine Root

Only after validation, point the live plugin to the new engine path.

If staging validation already passed and you want the scripted production
upgrade sequence for an existing installation, use:

```bash
./install/upgrade-to-scoped-memory.sh
```

This script does the successful post-validation sequence:

- backups live DB
- backups live config
- deploys the new engine
- copies the live DB into the scoped engine path
- applies the additive migration
- runs a health check
- patches `openclaw.json` to point `global-memory` to the new `engineRoot`

It does **not** restart the gateway automatically.

It also refuses to run on a clean host without an existing installation.

### 9. Keep Rollback Simple

Do not delete the previous engine or previous DB immediately.

Rollback should only require:

- restoring the previous plugin config
- restarting the gateway

## Migration Notes

- The SQL migration is additive.
- Existing records remain usable.
- Old records will usually stay `global` unless explicitly backfilled.
- Full Telegram isolation requires scoped writes for new memory records.

## Recommended Release Note

When publishing these upgrades, call out:

- scoped Telegram memory support
- additive schema migration
- no immediate in-place live DB migration recommended
- staged rollout is preferred over direct cutover
- `v0.2.1` adds token-free host scheduling for Telegram scoped ingest
