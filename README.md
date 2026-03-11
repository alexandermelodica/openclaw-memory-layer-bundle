# openclaw-memory-layer-bundle

Portable product bundle for adding a full RAG memory layer to OpenClaw.

What is included:
- a standalone Memory Engine
- a `global-memory` OpenClaw plugin
- installer scripts
- config templates
- smoke checks

What is not included:
- your memory database
- your workspace files
- your `openclaw.json`
- your `.env`
- runtime sessions or secrets

## Product Shape

```text
openclaw-memory-layer-bundle/
├── engine/      # DB, embeddings, search, ingest, health
├── plugin/      # before_prompt_build integration
├── install/     # installer + config patcher + smoke test
└── templates/   # config snippets and env examples
```

## What Happens After Install

1. The installer copies the engine into `~/.openclaw/memory-layer/engine`.
2. It installs engine dependencies and initializes a local SQLite memory DB.
3. It installs the OpenClaw plugin from `plugin/`.
4. It patches `openclaw.json` to allow and enable `global-memory`.
5. The plugin starts calling `engine/bin/search.js` before every user turn.
6. After you ingest documents, OpenClaw gets compact recall blocks automatically.

## Requirements

- OpenClaw installed on the host
- Node.js and npm
- `sqlite3`
- Ollama running locally or reachable by URL
- embedding model available, default: `nomic-embed-text`
- Linux x86_64 for the bundled `sqlite-vec` binary

## Install

For first-time installation only:

```bash
git clone <repo-url>
cd openclaw-memory-layer-bundle
./install/install-openclaw-memory-layer.sh
```

If a previous version is already installed, do not use the clean install path.
Use the upgrade flow described in:

- `docs/UPGRADE.md`
- `install/upgrade-to-scoped-memory.sh`

## First Ingest

```bash
node "$HOME/.openclaw/memory-layer/engine/bin/ingest-docs.js" \
  "$HOME/.openclaw/workspace" \
  "**/*.md"
```

For Telegram-scoped durable notes:

```bash
"$HOME/.openclaw/memory-layer/engine/bin/ingest-telegram-sessions.sh"
```

## Smoke Test

```bash
./install/smoke-test.sh
```

## Release Tarball

Build a release archive locally:

```bash
./scripts/build-release-tarball.sh
```

Expected output:

```bash
dist/openclaw-memory-layer-bundle-0.2.1.tar.gz
```

## Notes

- The engine is intentionally narrow and deterministic.
- If search returns nothing, the plugin injects nothing.
- The plugin works before model dispatch, so it is provider-agnostic.
- This bundle currently ships a Linux x86_64 `sqlite-vec` binary.
- Telegram chat isolation should use scoped memory; see `docs/TELEGRAM-SCOPED-MEMORY.md`.

## Telegram Chat Context Separation

Starting with `v0.2.0`, Telegram memory is designed to be scoped instead of
treated as one shared pool.

That means the bundle now supports separating memory by:

- `chat_id`
- `thread_id`
- `user_id`
- `session_id`

The intended behavior is:

- one Telegram chat should not leak context into another chat
- group topics should not mix context with other topics
- direct messages should stay separate from group memory
- shared durable knowledge can still be stored as `global` memory

This is the foundation for safer Telegram bot memory in OpenClaw, especially
when one bot is present in multiple chats.

The bundle now ships a dedicated Telegram session writer that:

- reads OpenClaw `sessions.json` and session JSONL files
- extracts Telegram metadata from user turns
- keeps only durable summaries, facts, decisions, and preferences
- writes scoped memory rows with `chat_id`, `thread_id`, `user_id`, and `session_id`

It is intentionally narrow: it does not ingest every raw Telegram message into
durable memory.

Recommended regular sync on a live host:

```bash
"$HOME/.openclaw/memory-layer/engine/bin/ingest-telegram-sessions.sh"
```

Run that from host cron or a systemd timer. This path does not need an LLM and
does not spend model tokens.

## Rollout And Upgrade

- Production rollout: `docs/ROLLOUT.md`
- Upgrade from previous version: `docs/UPGRADE.md`
- Post-validation upgrade script for existing installs: `install/upgrade-to-scoped-memory.sh`
- Change history: `CHANGELOG.md`

## Versioning Notes

- `v0.1.0` is the initial public bundle release.
- `v0.2.0` adds scoped Telegram-aware memory architecture, rollout guidance, and the scripted upgrade path.
- `v0.2.1` adds the scoped Telegram session writer, token-free host scheduling, and ranking improvements for Telegram-local recall.
- Use the clean install script only for new hosts.
- Use the upgrade script only when a previous memory-layer installation already exists.

## Known Limitations

- Linux x86_64 only for the bundled `sqlite-vec` binary in `engine/sqlite-vec/vec0.so`
- expects Ollama to be running and reachable
- expects the embedding model `nomic-embed-text` to be available
- installer patches `~/.openclaw/openclaw.json` and writes a timestamped backup before changes
- first useful recall appears only after document ingest
- Telegram scoped isolation for new turns depends on running the Telegram session ingest path
