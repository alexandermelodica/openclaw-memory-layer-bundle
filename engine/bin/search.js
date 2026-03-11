#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { vectorSearch } = require("../lib/vector-search.js");
const { normalizeMemoryContext } = require("../lib/memory-scope.js");

function parseArgs(argv) {
  const args = { query: "", limit: 3, json: false, memoryContext: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--query" && argv[i + 1]) {
      args.query = argv[++i];
    } else if (arg === "--limit" && argv[i + 1]) {
      args.limit = Math.max(1, Number.parseInt(argv[++i], 10) || 3);
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

function decodeDocSource(sourceId) {
  const parts = String(sourceId).split("#");
  if (parts.length < 3) {
    return null;
  }
  return {
    path: parts[0],
  };
}

function snippetFromFile(meta, fallbackPath) {
  const filePath = meta.filePath || fallbackPath;
  if (!filePath || !fs.existsSync(filePath)) {
    return "";
  }
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  const start = Math.max(1, Number(meta.startLine || 1));
  const end = Math.max(start, Number(meta.endLine || start));
  return lines.slice(start - 1, end).join(" ").replace(/\s+/g, " ").trim();
}

function toResult(row) {
  const meta = row.meta_json ? JSON.parse(row.meta_json) : {};
  const decoded = decodeDocSource(row.source_id) || {};
  const telegramLabel =
    meta.label || meta.conversation?.group_subject || meta.sessionLabel || (row.chat_id ? `telegram:${row.chat_id}` : null);
  const filePath =
    meta.filePath ||
    telegramLabel ||
    decoded.path ||
    ((row.source_type === "telegram_summary" || row.source_type === "telegram_message")
      ? `telegram:${row.chat_id || row.user_id || "unknown"}`
      : row.source_id);
  const snippet =
    snippetFromFile(meta, decoded.path) ||
    meta.contentPreview ||
    (row.source_type === "telegram_message" && telegramLabel
      ? `Telegram message from ${telegramLabel}`
      : "") ||
    (row.source_type === "telegram_summary" && telegramLabel
      ? `Telegram ${row.kind || "memory"} note from ${telegramLabel}`
      : "") ||
    row.source_content ||
    meta.headingPath ||
    row.source_id;

  return {
    path: filePath,
    startLine: Number(meta.startLine || 1),
    endLine: Number(meta.endLine || meta.startLine || 1),
    score: Number((row.finalScore || 0).toFixed(3)),
    snippet: snippet.slice(0, 320),
    source: row.source_type,
    memorySource: row.source || null,
    scope: row.scope || null,
    status: row.status,
    kind: row.kind,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.query.trim()) {
    console.error('Usage: node bin/search.js --query "text" [--limit 3] [--json]');
    process.exit(1);
  }

  const rows = await vectorSearch(args.query, args.limit, { memoryContext: args.memoryContext });
  const results = rows.map(toResult);

  if (args.json) {
    process.stdout.write(JSON.stringify({ query: args.query, memoryContext: args.memoryContext, results }, null, 2));
    return;
  }

  for (const result of results) {
    console.log(`${result.path}:${result.startLine}-${result.endLine} score=${result.score}`);
    console.log(result.snippet);
    console.log("");
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
