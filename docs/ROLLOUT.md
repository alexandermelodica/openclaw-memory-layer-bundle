# Production Rollout

This runbook describes how to roll out the scoped Telegram memory architecture
without disrupting an existing OpenClaw deployment.

## Goal

Move from the current global memory layer to a scoped Telegram-aware memory
layer with:

- no immediate cutover
- no live DB mutation at the first step
- fast rollback

## Phase 1. Freeze And Backup

Before changing anything:

1. confirm the live memory DB path
2. back up the live DB
3. back up `~/.openclaw/openclaw.json`
4. confirm the live gateway is healthy

Keep the current plugin path unchanged during this phase.

## Phase 2. Parallel Scoped Path

Set up the new scoped bundle in a separate path, for example:

```text
~/.openclaw/memory-layer-scope-staging/
```

Do not switch the live plugin yet.

Create a copy of the current live memory DB and apply the scoped migration only
to that copy:

```text
engine/memory/migrations/001_telegram_scoping.sql
```

## Phase 3. Scoped Write Path

Start writing new Telegram memory into the new scoped path only.

Write only useful durable memory:

- summaries
- preferences
- decisions
- promoted facts

Do not write every raw Telegram message as durable memory.

## Phase 4. Shadow Mode

Run the new scoped retrieval path in parallel without using it for final prompt
injection.

Compare:

- current live recall
- new scoped recall

This phase is for observing:

- leakage risk
- recall quality
- latency
- unexpected regressions

## Phase 5. Validation Gates

Do not cut over until all of these are true:

- scoped retrieval works
- no cross-chat leakage
- no topic leakage
- no DM/group leakage
- global recall still works
- latency is acceptable
- rollback path is ready

## Phase 6. Soft Cutover

Switch only the plugin `engineRoot` to the new scoped engine path.

Do not delete the old engine or old DB.

Keep rollback simple:

1. restore the previous plugin config
2. point `engineRoot` back to the old path
3. restart the gateway

## Phase 7. Observation Window

Watch production after cutover:

- retrieval quality
- leakage
- latency
- noisy recall
- Telegram-specific edge cases

## Phase 8. Cleanup

Only after the new scoped path is stable:

- archive the old engine path
- archive the old DB path if no longer needed
- keep backups for rollback confidence

## Recommended Rollout Strategy

The safest path is:

1. current live memory remains unchanged
2. new scoped engine is deployed in parallel
3. live DB is copied, not mutated
4. scoped write path starts on the new path
5. shadow mode validation runs
6. soft cutover switches only plugin engine root
7. old path remains as rollback
