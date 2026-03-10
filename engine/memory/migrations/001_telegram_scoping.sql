-- Telegram scoped memory migration for the OpenClaw Memory Layer.
-- Apply this only once to an existing memory.sqlite database.

ALTER TABLE embeddings ADD COLUMN scope TEXT DEFAULT 'global';
ALTER TABLE embeddings ADD COLUMN source TEXT;
ALTER TABLE embeddings ADD COLUMN chat_id TEXT;
ALTER TABLE embeddings ADD COLUMN thread_id TEXT;
ALTER TABLE embeddings ADD COLUMN user_id TEXT;
ALTER TABLE embeddings ADD COLUMN session_id TEXT;

CREATE INDEX IF NOT EXISTS idx_embeddings_scope ON embeddings(scope);
CREATE INDEX IF NOT EXISTS idx_embeddings_source ON embeddings(source);
CREATE INDEX IF NOT EXISTS idx_embeddings_chat_scope ON embeddings(chat_id, scope);
CREATE INDEX IF NOT EXISTS idx_embeddings_thread_scope ON embeddings(chat_id, thread_id, scope);
CREATE INDEX IF NOT EXISTS idx_embeddings_user_scope ON embeddings(user_id, scope);
CREATE INDEX IF NOT EXISTS idx_embeddings_session_scope ON embeddings(session_id, scope);

-- Recommended values:
-- scope: global | user | chat | session
-- source: telegram | notion | filesystem | manual | api

