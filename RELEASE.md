# Release Guide

## Build

```bash
./scripts/build-release-tarball.sh
```

Expected output:

```bash
dist/openclaw-memory-layer-bundle-0.1.0.tar.gz
```

## Verify Archive Contents

```bash
tar -tzf dist/openclaw-memory-layer-bundle-0.1.0.tar.gz
```

The archive should contain only bundle files:
- `engine/`
- `plugin/`
- `install/`
- `templates/`
- `docs/`
- `README.md`
- `LICENSE`
- `RELEASE.md`

It must not contain:
- `.git/`
- `node_modules/`
- user memory data
- `openclaw.json`
- `.env`
- runtime state

## Publish

1. Create a Git tag like `v0.1.0`.
2. Push the tag.
3. Create a GitHub release from that tag.
4. Attach `dist/openclaw-memory-layer-bundle-0.1.0.tar.gz`.

## Known Limitations

- Linux x86_64 only for the bundled `sqlite-vec` binary
- requires Ollama and the `nomic-embed-text` model
- installer patches `~/.openclaw/openclaw.json` but writes a backup first
- retrieval stays empty until you ingest documents into the new memory DB

## Upgrade Notes

- this version introduces scoped Telegram memory fields
- migration is additive, not destructive
- direct in-place live DB migration is not the recommended first step
- prefer staged rollout using a copied DB and parallel engine path
- see `docs/ROLLOUT.md` and `docs/UPGRADE.md`

## Install From Release

```bash
tar -xzf openclaw-memory-layer-bundle-0.1.0.tar.gz
cd openclaw-memory-layer-bundle-0.1.0
./install/install-openclaw-memory-layer.sh
```
