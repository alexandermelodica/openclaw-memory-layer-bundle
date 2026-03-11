# Changelog

All notable changes to `openclaw-memory-layer-bundle` are documented here.

## v0.2.1

### Added
- Scoped Telegram memory writer for OpenClaw session logs.
- Host-safe wrapper script for token-free Telegram memory ingest scheduling.

### Changed
- Telegram-scoped retrieval ranking now prioritizes matching `chat` and `user` memory over irrelevant global noise.
- Search output for Telegram memory now returns human-readable labels/snippets instead of raw `source_id`.
- Documentation now describes token-free host cron/systemd scheduling for Telegram scoped ingest.

### Fixed
- `global-memory` search parsing now tolerates non-JSON stray output more safely.
- Telegram session ingest is now idempotent across repeat runs.

## v0.2.0

### Added
- Scoped Telegram-aware memory architecture.
- New memory fields for scoped retrieval:
  - `source`
  - `scope`
  - `chat_id`
  - `thread_id`
  - `user_id`
  - `session_id`
- Scope-aware retrieval and reranking support in the Memory Engine.
- `engine/bin/ingest-telegram-sessions.js` for writing scoped Telegram memory from OpenClaw session logs.
- `docs/ROLLOUT.md` for staged production rollout.
- `docs/UPGRADE.md` for upgrading existing installations.
- `install/upgrade-to-scoped-memory.sh` for the post-validation production upgrade path.

### Changed
- Clean install and upgrade are now explicitly separated.
- Documentation now distinguishes new-host installation from upgrades of existing deployments.
- Release flow now targets the `0.2.0` artifact line.
- Telegram-scoped write path now includes a dedicated session ingester intended for host cron/systemd scheduling without LLM tokens.

### Notes
- This release is intended to upgrade existing `v0.1.0` deployments through a staged migration path.
- Full Telegram isolation for new turns depends on running the Telegram session ingest path as part of operations.

## v0.1.0

### Added
- Initial public release of the bundle.
- Standalone Memory Engine.
- `global-memory` OpenClaw plugin.
- Installer, release tarball flow, and smoke-test path.
