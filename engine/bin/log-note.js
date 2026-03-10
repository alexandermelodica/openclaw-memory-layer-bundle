#!/usr/bin/env node
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { getConfig } = require("../lib/config.js");

const payload = process.argv.slice(2).join(" ").trim();
if (!payload) {
  console.error('Usage: node bin/log-note.js "text"');
  process.exit(1);
}

const config = getConfig();
const id = crypto.randomUUID();
const ts = new Date().toISOString();
const esc = (value) => value.replace(/'/g, "''");
const sql = `
INSERT INTO embeddings (
  id, ts, source_type, source_id, content_hash, vector, vector_raw, vector_dim,
  model, meta_json, status, error_text, kind, created_at, ttl_until,
  project, service, env, tags, tags_norm
) VALUES (
  '${id}',
  '${ts}',
  'note',
  'note:${id}',
  '${crypto.createHash("sha256").update(payload).digest("hex")}',
  NULL,
  NULL,
  NULL,
  NULL,
  '{"inline":true}',
  'failed',
  'log-note does not generate embeddings; use ingest-docs or direct embedding flow',
  'note',
  '${ts.replace("T", " ").substring(0, 19)}',
  NULL,
  '${esc(config.project)}',
  NULL,
  '${esc(config.env)}',
  '',
  ''
);
`;

try {
  execFileSync("sqlite3", [config.dbPath, sql], { stdio: "inherit" });
  console.log(`Logged note stub: ${id}`);
} catch (error) {
  console.error("Failed to write note stub.");
  console.error(error.message);
  process.exit(1);
}
