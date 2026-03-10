#!/usr/bin/env node
const fs = require("node:fs");
const sqlite3 = require("sqlite3");
const { open } = require("sqlite");
const { getConfig } = require("../lib/config.js");

async function main() {
  const config = getConfig();
  const status = {
    dbPath: config.dbPath,
    dbExists: fs.existsSync(config.dbPath),
    vecExtPath: config.vecExtPath,
    vecExtExists: fs.existsSync(config.vecExtPath),
    ollamaUrl: config.ollamaUrl,
    embeddingModel: config.embedModel,
  };

  if (!status.dbExists) {
    console.error(JSON.stringify({ ok: false, status, error: "Database missing" }, null, 2));
    process.exit(1);
  }

  const db = await open({ filename: config.dbPath, driver: sqlite3.Database });
  const summary = await db.get(
    "SELECT COUNT(*) AS total, SUM(CASE WHEN status IN ('ok','verified') THEN 1 ELSE 0 END) AS healthy FROM embeddings"
  );
  await db.close();

  process.stdout.write(JSON.stringify({ ok: true, status, summary }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
});
