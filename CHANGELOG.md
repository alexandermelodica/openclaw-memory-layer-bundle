# Changelog

All notable changes to `openclaw-memory-layer-bundle` are documented here.

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
- `docs/ROLLOUT.md` for staged production rollout.
- `docs/UPGRADE.md` for upgrading existing installations.
- `install/upgrade-to-scoped-memory.sh` for the post-validation production upgrade path.

### Changed
- Clean install and upgrade are now explicitly separated.
- Documentation now distinguishes new-host installation from upgrades of existing deployments.
- Release flow now targets the `0.2.0` artifact line.

### Notes
- This release is intended to upgrade existing `v0.1.0` deployments through a staged migration path.
- Full Telegram isolation still depends on enabling the scoped write path for new records.

## v0.1.0

### Added
- Initial public release of the bundle.
- Standalone Memory Engine.
- `global-memory` OpenClaw plugin.
- Installer, release tarball flow, and smoke-test path.

