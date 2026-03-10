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

```bash
git clone <repo-url>
cd openclaw-memory-layer-bundle
./install/install-openclaw-memory-layer.sh
```

## First Ingest

```bash
node "$HOME/.openclaw/memory-layer/engine/bin/ingest-docs.js" \
  "$HOME/.openclaw/workspace" \
  "**/*.md"
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
dist/openclaw-memory-layer-bundle-0.1.0.tar.gz
```

## Notes

- The engine is intentionally narrow and deterministic.
- If search returns nothing, the plugin injects nothing.
- The plugin works before model dispatch, so it is provider-agnostic.
- This bundle currently ships a Linux x86_64 `sqlite-vec` binary.
- Telegram chat isolation should use scoped memory; see `docs/TELEGRAM-SCOPED-MEMORY.md`.

## Rollout And Upgrade

- Production rollout: `docs/ROLLOUT.md`
- Upgrade from previous version: `docs/UPGRADE.md`
- Post-validation upgrade script: `install/upgrade-to-scoped-memory.sh`

## Known Limitations

- Linux x86_64 only for the bundled `sqlite-vec` binary in `engine/sqlite-vec/vec0.so`
- expects Ollama to be running and reachable
- expects the embedding model `nomic-embed-text` to be available
- installer patches `~/.openclaw/openclaw.json` and writes a timestamped backup before changes
- first useful recall appears only after document ingest
