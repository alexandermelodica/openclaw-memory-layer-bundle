# Changelog

All notable changes to `openclaw-memory-layer-bundle` are documented here.

## Unreleased

### Added
- Recent Telegram chat context loader for `global-memory`, so replies can use scoped local chat history alongside semantic recall.
- Full Telegram incoming message logging into the memory DB via `telegram_message` rows.
- Heuristic document-signal detection for Telegram payloads such as tickets, bookings, route sheets, invoices, and docs.

### Changed
- Telegram session ingest now writes both scoped chat-log rows and durable summary rows.
- Group-chat policy now explicitly allows one short proactive follow-up when a document-like payload is recognized.
- Telegram context inference now falls back to prompt metadata when OpenClaw does not pass Telegram runtime fields explicitly.
- Recommended Telegram ingest cadence on live hosts is now every 5 minutes instead of hourly to reduce chat-context lag.

### Fixed
- Telegram message ingest strips injected memory blocks and document-intake hints from logged user text to avoid recursive prompt pollution.

## v0.2.3

### Changed
- `global-memory` now infers Telegram scope from embedded prompt metadata when runtime `source/chat_id/user_id` fields are missing.
- Recommended host scheduling for Telegram ingest is tightened to `*/5 * * * *` to reduce recent-context lag between chat traffic and memory availability.

### Fixed
- Telegram replies no longer depend solely on explicit runtime channel metadata to load chat profiles and recent local chat context.

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

## v0.2.2

### Changed
- Telegram reply-context cleanup is now applied during forced reingest, including removal of stale low-value rows that no longer pass retention heuristics.
- Telegram session ingest now supports `--force` through the wrapper script for targeted refreshes after parser improvements.

### Fixed
- Reply-context and quoted-message blocks are stripped more aggressively from Telegram durable notes.
- Forced Telegram reingest can now delete stale rows that would otherwise survive incremental updates.

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
