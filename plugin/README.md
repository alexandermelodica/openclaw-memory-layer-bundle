# global-memory plugin

OpenClaw plugin that injects narrow RAG recall into every user turn.

This plugin is designed to be installed together with the bundled Memory
Engine in the parent `openclaw-memory-layer-bundle` product.

It calls:

```bash
node <engineRoot>/bin/search.js --query "... " --limit N --json
```

and prepends a compact memory block before model dispatch.
