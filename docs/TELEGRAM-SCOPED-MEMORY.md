# Telegram Scoped Memory

This document defines the recommended storage and retrieval model for using the
Memory Layer with multiple Telegram chats without context leakage.

## Goal

Keep memory global where useful, but isolate Telegram conversations so that:
- one group does not leak into another
- DMs do not leak into groups
- one forum topic does not leak into another
- user-specific memory stays attached to the correct person

## Storage Model

Every memory record that comes from Telegram should carry these metadata fields:

- `source`: `telegram`
- `scope`: `session | chat | user | global`
- `chat_id`
- `thread_id`
- `user_id`
- `session_id`
- `agent_id` if your runtime supports multiple agents

Recommended meaning:

- `session`: short-lived active conversation memory for the current thread
- `chat`: durable memory for one Telegram chat or group
- `user`: durable memory for one person
- `global`: shared durable knowledge, runbooks, docs, promoted facts

## What To Write

Write only durable or useful information:

- decisions
- preferences
- stable facts
- task status
- short summaries
- curated notes

Do not write raw durable memory for:

- every single message
- jokes, filler, chatter
- repetitive acknowledgements
- low-value operational noise

Recommended pipeline:

1. raw Telegram messages stay ephemeral
2. extract summaries/facts/preferences
3. persist only the extracted memory

## Retrieval Policy

Retrieval should be layered, not flat.

Priority order:

1. `session`
2. `chat`
3. `user`
4. `global`

Recommended recall assembly:

- up to 2 hits from `session/chat`
- up to 1 hit from `user`
- up to 1-2 hits from `global`

This is better than a single top-N across all scopes, because it preserves
local context while still allowing durable global knowledge to participate.

## Query-Time Filters

For Telegram turns, pass these scope filters to the memory search layer:

- `source = telegram`
- `chat_id = current_chat_id`
- `thread_id = current_thread_id` when available
- `user_id = current_user_id` for user-scope retrieval

Then merge in `global` results separately.

Recommended logic:

### Direct message

- `session`: same DM session
- `chat`: same DM chat
- `user`: same user
- `global`: shared durable knowledge

### Group chat

- `session`: current thread/topic if present
- `chat`: same group chat
- `user`: optional, for direct user preferences if relevant
- `global`: shared durable knowledge

### Forum topic / topic-based group

- `session`: current topic session
- `chat`: current topic or current group depending on granularity
- `global`: shared durable knowledge

## Recommended Scoring Bonus

Apply a scope bonus on top of semantic similarity:

- `session`: `+0.20`
- `chat`: `+0.15`
- `user`: `+0.10`
- `global`: `+0.00`

This combines with existing reranking:

- verified-first
- kind bonus
- recency bonus
- tag bonus
- context bonus

## Integration Points In This Bundle

To implement scoped Telegram memory in this bundle:

1. extend ingest/write flows to save `scope`, `source`, `chat_id`, `thread_id`, `user_id`, `session_id`
2. extend `engine/lib/vector-search.js` to filter and bonus by scope
3. extend the OpenClaw plugin context bridge so Telegram runtime metadata is passed into search

## Safety Rule

Never run Telegram retrieval as one shared pool without scope filters.

If you do that, memory will leak between:

- different groups
- groups and DMs
- different topics
- unrelated users

The correct rule is:

- write broadly enough to preserve useful memory
- retrieve narrowly enough to protect context boundaries

