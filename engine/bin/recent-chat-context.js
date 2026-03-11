#!/usr/bin/env node
const sqlite3 = require("sqlite3");
const { open } = require("sqlite");
const { getConfig } = require("../lib/config.js");
const { normalizeMemoryContext } = require("../lib/memory-scope.js");

function parseArgs(argv) {
  const args = {
    limit: 6,
    maxChars: 900,
    json: false,
    memoryContext: {},
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--limit" && argv[i + 1]) {
      args.limit = Math.max(1, Number.parseInt(argv[++i], 10) || 6);
    } else if (arg === "--max-chars" && argv[i + 1]) {
      args.maxChars = Math.max(200, Number.parseInt(argv[++i], 10) || 900);
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--source" && argv[i + 1]) {
      args.memoryContext.source = argv[++i];
    } else if (arg === "--scope" && argv[i + 1]) {
      args.memoryContext.scope = argv[++i];
    } else if (arg === "--chat-id" && argv[i + 1]) {
      args.memoryContext.chatId = argv[++i];
    } else if (arg === "--thread-id" && argv[i + 1]) {
      args.memoryContext.threadId = argv[++i];
    } else if (arg === "--user-id" && argv[i + 1]) {
      args.memoryContext.userId = argv[++i];
    } else if (arg === "--session-id" && argv[i + 1]) {
      args.memoryContext.sessionId = argv[++i];
    }
  }

  args.memoryContext = normalizeMemoryContext(args.memoryContext);
  return args;
}

async function getDb() {
  const config = getConfig();
  const db = await open({
    filename: config.dbPath,
    driver: sqlite3.Database,
  });
  await db.exec("PRAGMA busy_timeout = 5000;");
  await db.exec("PRAGMA journal_mode = WAL;");
  return db;
}

function buildWhere(memoryContext, limit) {
  const where = [
    "e.source = 'telegram'",
    "e.source_type = 'telegram_message'",
  ];
  const params = [];

  if (memoryContext.threadId) {
    where.push("e.chat_id = ?");
    where.push("e.thread_id = ?");
    params.push(memoryContext.chatId || "", memoryContext.threadId);
  } else if (memoryContext.chatId) {
    where.push("e.chat_id = ?");
    params.push(memoryContext.chatId);
  } else if (memoryContext.userId) {
    where.push("e.user_id = ?");
    params.push(memoryContext.userId);
  } else {
    where.push("1 = 0");
  }

  params.push(limit);
  return { where, params };
}

function sanitizeSnippet(text, maxChars) {
  const cleaned = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= maxChars) {
    return cleaned;
  }
  return `${cleaned.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function toEntry(row, maxChars) {
  const meta = row.meta_json ? JSON.parse(row.meta_json) : {};
  const label = meta.label || (row.chat_id ? `telegram:${row.chat_id}` : "telegram");
  const preview = sanitizeSnippet(meta.contentPreview || row.source_id, maxChars);
  return {
    path: label,
    ts: row.ts,
    scope: row.scope,
    kind: row.kind,
    snippet: preview,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.memoryContext.source !== "telegram") {
    const payload = { memoryContext: args.memoryContext, results: [] };
    process.stdout.write(args.json ? JSON.stringify(payload, null, 2) : "");
    return;
  }

  const db = await getDb();
  try {
    const { where, params } = buildWhere(args.memoryContext, args.limit);
    const rows = await db.all(
      `SELECT e.ts, e.scope, e.kind, e.chat_id, e.meta_json, e.source_id
       FROM embeddings e
       WHERE ${where.join(" AND ")}
       ORDER BY datetime(e.ts) DESC
       LIMIT ?`,
      params,
    );

    const chronological = rows.reverse().map((row) => toEntry(row, args.maxChars));
    const payload = {
      memoryContext: args.memoryContext,
      results: chronological,
    };

    if (args.json) {
      process.stdout.write(JSON.stringify(payload, null, 2));
      return;
    }

    for (const entry of chronological) {
      console.log(`[${entry.ts}] ${entry.path} ${entry.kind}`);
      console.log(entry.snippet);
      console.log("");
    }
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
