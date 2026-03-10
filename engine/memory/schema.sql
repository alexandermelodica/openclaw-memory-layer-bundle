PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS embeddings (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  vector BLOB,
  vector_raw BLOB,
  vector_dim INTEGER,
  model TEXT,
  meta_json TEXT,
  status TEXT NOT NULL DEFAULT 'ok',
  error_text TEXT,
  kind TEXT NOT NULL DEFAULT 'doc',
  created_at TEXT,
  ttl_until TEXT,
  project TEXT,
  service TEXT,
  env TEXT,
  source TEXT DEFAULT 'filesystem',
  scope TEXT DEFAULT 'global',
  chat_id TEXT,
  thread_id TEXT,
  user_id TEXT,
  session_id TEXT,
  tags TEXT,
  tags_norm TEXT,
  CHECK(
    (status IN ('ok', 'verified') AND vector_raw IS NOT NULL AND vector_dim IS NOT NULL AND vector_dim > 0)
    OR (status = 'failed' AND vector_raw IS NULL AND vector_dim IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_embeddings_source ON embeddings(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_embeddings_kind ON embeddings(kind);
CREATE INDEX IF NOT EXISTS idx_embeddings_status ON embeddings(status);
CREATE INDEX IF NOT EXISTS idx_embeddings_project_service_env ON embeddings(project, service, env);
CREATE INDEX IF NOT EXISTS idx_embeddings_scope ON embeddings(scope);
CREATE INDEX IF NOT EXISTS idx_embeddings_source ON embeddings(source);
CREATE INDEX IF NOT EXISTS idx_embeddings_chat_scope ON embeddings(chat_id, scope);
CREATE INDEX IF NOT EXISTS idx_embeddings_thread_scope ON embeddings(chat_id, thread_id, scope);
CREATE INDEX IF NOT EXISTS idx_embeddings_user_scope ON embeddings(user_id, scope);
CREATE INDEX IF NOT EXISTS idx_embeddings_session_scope ON embeddings(session_id, scope);
CREATE INDEX IF NOT EXISTS idx_embeddings_tags_norm ON embeddings(tags_norm);
CREATE INDEX IF NOT EXISTS idx_embeddings_created_at ON embeddings(created_at);

CREATE TABLE IF NOT EXISTS ingested_sources (
  source_path TEXT PRIMARY KEY,
  content_sha256 TEXT NOT NULL,
  last_ingested_ts TEXT NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS code_snapshots (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  file_path TEXT NOT NULL,
  git_commit_hash TEXT,
  content TEXT NOT NULL,
  meta_json TEXT
);
