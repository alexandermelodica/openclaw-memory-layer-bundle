#!/usr/bin/env node
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { v4: uuidv4 } = require("uuid");
const sqlite3 = require("sqlite3");
const { open } = require("sqlite");
const { getConfig } = require("../lib/config.js");
const {
  extractMessageText,
  extractTelegramMetadata,
  getTelegramSessionScope,
  deriveChatId,
  deriveUserId,
  deriveThreadId,
  isWorthKeeping,
  buildMemoryNote,
} = require("../lib/telegram-session-parser.js");

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

async function generateEmbedding(content) {
  const config = getConfig();
  try {
    const response = await fetch(`${config.ollamaUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.embedModel,
        input: content,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.statusText}`);
    }

    const data = await response.json();
    const vector = Array.isArray(data.embeddings) ? data.embeddings[0] : data.embedding;
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new Error("No embeddings returned from Ollama");
    }

    const float32 = new Float32Array(vector);
    return {
      json: Buffer.from(JSON.stringify(vector)),
      raw: Buffer.from(float32.buffer),
      dim: vector.length,
      status: "ok",
      error: null,
    };
  } catch (error) {
    return {
      json: null,
      raw: null,
      dim: null,
      status: "failed",
      error: error.message,
    };
  }
}

function parseArgs(argv) {
  const args = {
    sessionsFile: "",
    limit: 0,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!args.sessionsFile && !arg.startsWith("--")) {
      args.sessionsFile = arg;
    } else if (arg === "--limit" && argv[i + 1]) {
      args.limit = Math.max(0, Number.parseInt(argv[++i], 10) || 0);
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    }
  }

  return args;
}

function normalizeNote(text) {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function readJsonLines(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function getSessionEntries(sessionsIndex) {
  if (Array.isArray(sessionsIndex)) {
    return sessionsIndex;
  }
  return Object.entries(sessionsIndex || {}).map(([key, value]) => ({ ...value, key }));
}

function extractSessionFile(sessionEntry, sessionsFile) {
  if (sessionEntry.sessionFile) {
    return sessionEntry.sessionFile;
  }
  if (!sessionEntry.sessionId) {
    return null;
  }
  return path.join(path.dirname(sessionsFile), `${sessionEntry.sessionId}.jsonl`);
}

function buildSourceId(sessionId, userMessageId) {
  return `${sessionId}:${userMessageId}`;
}

async function upsertTelegramNote(db, row, dryRun) {
  const existing = await db.get(
    "SELECT id, content_hash FROM embeddings WHERE source_type = ? AND source_id = ?",
    "telegram_summary",
    row.sourceId,
  );

  if (existing && existing.content_hash === row.contentHash) {
    return "unchanged";
  }

  if (existing && !dryRun) {
    await db.run("DELETE FROM embeddings WHERE id = ?", existing.id);
  }

  if (dryRun) {
    return existing ? "would-update" : "would-insert";
  }

  await db.run(
    `INSERT INTO embeddings
      (id, ts, source_type, source_id, content_hash, vector, vector_raw, vector_dim, model, meta_json,
       status, error_text, kind, created_at, ttl_until, project, service, env, source, scope,
       chat_id, thread_id, user_id, session_id, tags, tags_norm)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    uuidv4(),
    row.ts,
    "telegram_summary",
    row.sourceId,
    row.contentHash,
    row.vector,
    row.vectorRaw,
    row.vectorDim,
    row.model,
    row.metaJson,
    row.status,
    row.errorText,
    row.kind,
    row.createdAt,
    null,
    row.project,
    null,
    row.env,
    row.source,
    row.scope,
    row.chatId,
    row.threadId,
    row.userId,
    row.sessionId,
    row.tags,
    row.tagsNorm,
  );

  return existing ? "updated" : "inserted";
}

function tagsForKind(kind) {
  const tags = ["telegram", "scoped-memory", kind];
  return {
    tags: tags.join(","),
    tagsNorm: tags.join(","),
  };
}

async function ingestSession(db, sessionEntry, sessionsFile, options) {
  const sessionFile = extractSessionFile(sessionEntry, sessionsFile);
  if (!sessionFile) {
    return { inserted: 0, updated: 0, unchanged: 0, skipped: 0 };
  }

  let events;
  try {
    events = await readJsonLines(sessionFile);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { inserted: 0, updated: 0, unchanged: 0, skipped: 0, missingSessionFile: sessionFile };
    }
    throw error;
  }
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let skipped = 0;

  for (let i = 0; i < events.length - 1; i += 1) {
    const current = events[i];
    const next = events[i + 1];
    const currentMessage = current?.message;
    const nextMessage = next?.message;

    if (current?.type !== "message" || next?.type !== "message") {
      continue;
    }
    if (currentMessage?.role !== "user" || nextMessage?.role !== "assistant") {
      continue;
    }

    const rawUserText = extractMessageText(currentMessage);
    const assistantText = extractMessageText(nextMessage);
    const { conversation, sender, cleanedText } = extractTelegramMetadata(rawUserText);

    if (!isWorthKeeping(cleanedText, assistantText)) {
      skipped += 1;
      continue;
    }

    const scope = getTelegramSessionScope(sessionEntry, conversation);
    const chatId = deriveChatId(sessionEntry, conversation);
    const threadId = deriveThreadId(sessionEntry, conversation);
    const userId = deriveUserId(sessionEntry, conversation, sender);
    const sessionId = String(sessionEntry.sessionId || "");
    const sourceId = buildSourceId(sessionId, current.id);
    const { kind, note } = buildMemoryNote({
      sessionEntry,
      conversation,
      sender,
      userText: cleanedText,
      assistantText,
    });
    const normalized = normalizeNote(note);
    const contentHash = crypto.createHash("sha256").update(normalized).digest("hex");
    const embedding = options.dryRun
      ? { json: null, raw: null, dim: null, status: "ok", error: null }
      : await generateEmbedding(normalized);
    const ts = next.timestamp || current.timestamp || new Date().toISOString();
    const createdAt = String(ts).replace("T", " ").slice(0, 19);
    const { tags, tagsNorm } = tagsForKind(kind);
    const metaJson = JSON.stringify({
      conversation,
      sender,
      sessionKey: sessionEntry.key || null,
      sessionLabel: sessionEntry.label || null,
      sessionFile,
      userMessageId: current.id,
      assistantMessageId: next.id,
      contentPreview: normalized.slice(0, 400),
      label: conversation?.group_subject || sessionEntry?.subject || sessionEntry?.label || "Telegram",
    });

    const result = await upsertTelegramNote(
      db,
      {
        ts,
        sourceId,
        contentHash,
        vector: embedding.json,
        vectorRaw: embedding.raw,
        vectorDim: embedding.dim,
        model: getConfig().embedModel,
        metaJson,
        status: options.dryRun ? "ok" : embedding.status === "ok" ? "ok" : "failed",
        errorText: embedding.error,
        kind,
        createdAt,
        project: getConfig().project,
        env: getConfig().env,
        source: "telegram",
        scope,
        chatId,
        threadId,
        userId,
        sessionId,
        tags,
        tagsNorm,
      },
      options.dryRun,
    );

    if (result === "inserted" || result === "would-insert") {
      inserted += 1;
    } else if (result === "updated" || result === "would-update") {
      updated += 1;
    } else if (result === "unchanged") {
      unchanged += 1;
    }
  }

  return { inserted, updated, unchanged, skipped };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.sessionsFile) {
    console.error("Usage: node bin/ingest-telegram-sessions.js <sessions.json> [--limit N] [--dry-run]");
    process.exit(1);
  }

  const sessionsFile = path.resolve(args.sessionsFile);
  const sessionsIndex = await readJson(sessionsFile);
  const sessionEntries = getSessionEntries(sessionsIndex).filter(
    (entry) => entry && (entry.origin?.provider === "telegram" || String(entry.key || "").includes(":telegram:")),
  );

  const selectedEntries = args.limit > 0 ? sessionEntries.slice(0, args.limit) : sessionEntries;
  const db = await getDb();
  let totals = { inserted: 0, updated: 0, unchanged: 0, skipped: 0, missingSessionFiles: 0 };

  for (const sessionEntry of selectedEntries) {
    const result = await ingestSession(db, sessionEntry, sessionsFile, { dryRun: args.dryRun });
    totals.inserted += result.inserted;
    totals.updated += result.updated;
    totals.unchanged += result.unchanged;
    totals.skipped += result.skipped;
    totals.missingSessionFiles += result.missingSessionFile ? 1 : 0;
  }

  await db.close();
  console.log(
    JSON.stringify(
      {
        sessions: selectedEntries.length,
        dryRun: args.dryRun,
        ...totals,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
