#!/usr/bin/env node
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
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
  buildChatLogNote,
  detectDocumentSignal,
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
    force: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!args.sessionsFile && !arg.startsWith("--")) {
      args.sessionsFile = arg;
    } else if (arg === "--limit" && argv[i + 1]) {
      args.limit = Math.max(0, Number.parseInt(argv[++i], 10) || 0);
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--force") {
      args.force = true;
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

function getStatePaths() {
  const config = getConfig();
  const stateDir = path.join(config.dataRoot, "state");
  return {
    stateDir,
    stateFile: path.join(stateDir, "telegram-ingest-state.json"),
    lockFile: path.join(stateDir, "telegram-ingest.lock"),
  };
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

function buildMessageSourceId(sessionId, messageId) {
  return `${sessionId}:msg:${messageId}`;
}

async function ensureStateDir() {
  const { stateDir } = getStatePaths();
  await fs.mkdir(stateDir, { recursive: true });
}

async function loadState() {
  const { stateFile } = getStatePaths();
  try {
    return await readJson(stateFile);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { sessions: {} };
    }
    throw error;
  }
}

async function saveState(state) {
  const { stateFile } = getStatePaths();
  await ensureStateDir();
  await fs.writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function acquireLock() {
  const { lockFile } = getStatePaths();
  await ensureStateDir();

  const tryOpen = async () => fs.open(lockFile, "wx");
  try {
    const handle = await tryOpen();
    await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, "utf8");
    await handle.close();
    return async () => {
      await fs.rm(lockFile, { force: true });
    };
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }

    const stat = await fs.stat(lockFile).catch(() => null);
    const staleMs = 60 * 60 * 1000;
    if (stat && Date.now() - stat.mtimeMs > staleMs) {
      await fs.rm(lockFile, { force: true });
      const handle = await tryOpen();
      await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, "utf8");
      await handle.close();
      return async () => {
        await fs.rm(lockFile, { force: true });
      };
    }

    throw new Error("telegram ingest already running");
  }
}

function shouldSkipSession(sessionFile, stat, state) {
  const entry = state.sessions?.[sessionFile];
  if (!entry) {
    return false;
  }
  return entry.mtimeMs === stat.mtimeMs && entry.size === stat.size;
}

function updateSessionState(state, sessionFile, stat) {
  if (!state.sessions) {
    state.sessions = {};
  }
  state.sessions[sessionFile] = {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    updatedAt: new Date().toISOString(),
  };
}

function pairConversationTurns(events) {
  const pairs = [];
  let pendingUser = null;
  let assistantParts = [];

  for (const event of events) {
    if (event?.type !== "message" || !event.message?.role) {
      continue;
    }

    const role = event.message.role;
    if (role === "user") {
      if (pendingUser && assistantParts.length > 0) {
        pairs.push({ userEvent: pendingUser, assistantText: assistantParts.join("\n\n").trim() });
      }
      pendingUser = event;
      assistantParts = [];
      continue;
    }

    if (role === "assistant" && pendingUser) {
      const text = extractMessageText(event.message);
      if (text) {
        assistantParts.push(text);
      }
    }
  }

  if (pendingUser && assistantParts.length > 0) {
    pairs.push({ userEvent: pendingUser, assistantText: assistantParts.join("\n\n").trim() });
  }

  return pairs;
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
    crypto.randomUUID(),
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

async function upsertTelegramMessage(db, row, dryRun) {
  const existing = await db.get(
    "SELECT id, content_hash FROM embeddings WHERE source_type = ? AND source_id = ?",
    "telegram_message",
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
    crypto.randomUUID(),
    row.ts,
    "telegram_message",
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

async function deleteTelegramNoteBySourceId(db, sourceId, dryRun) {
  const existing = await db.get(
    "SELECT id FROM embeddings WHERE source_type = ? AND source_id = ?",
    "telegram_summary",
    sourceId,
  );
  if (!existing) {
    return false;
  }
  if (!dryRun) {
    await db.run("DELETE FROM embeddings WHERE id = ?", existing.id);
  }
  return true;
}

function tagsForKind(kind) {
  const tags = ["telegram", "scoped-memory", kind];
  return {
    tags: tags.join(","),
    tagsNorm: tags.join(","),
  };
}

function mergeTags(...parts) {
  return [...new Set(parts.flat().filter(Boolean))];
}

async function ingestUserMessages(db, sessionEntry, events, sessionFile, options) {
  const sessionId = String(sessionEntry.sessionId || "");
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;

  for (const event of events) {
    if (event?.type !== "message" || event.message?.role !== "user") {
      continue;
    }

    const rawUserText = extractMessageText(event.message);
    if (!rawUserText.trim()) {
      continue;
    }

    const { conversation, sender, attachments, cleanedText } = extractTelegramMetadata(rawUserText);
    const normalizedText = normalizeNote(cleanedText);
    if (!normalizedText) {
      continue;
    }

    const scope = getTelegramSessionScope(sessionEntry, conversation);
    const chatId = deriveChatId(sessionEntry, conversation);
    const threadId = deriveThreadId(sessionEntry, conversation);
    const userId = deriveUserId(sessionEntry, conversation, sender);
    const docSignal = detectDocumentSignal(normalizedText, attachments);
    const { kind, note } = buildChatLogNote({
      sessionEntry,
      conversation,
      sender,
      userText: normalizedText,
      docSignal,
    });
    const normalizedNote = normalizeNote(note);
    const contentHash = crypto.createHash("sha256").update(normalizedNote).digest("hex");
    const embedding = options.dryRun
      ? { json: null, raw: null, dim: null, status: "ok", error: null }
      : await generateEmbedding(normalizedNote);
    const ts = event.timestamp || new Date().toISOString();
    const createdAt = String(ts).replace("T", " ").slice(0, 19);
    const baseTags = ["telegram", "chat-log", scope];
    if (kind === "document_signal") {
      baseTags.push("document-signal");
    }
    const mergedTags = mergeTags(baseTags, docSignal.tags);
    const metaJson = JSON.stringify({
      conversation,
      sender,
      attachments,
      docSignal,
      sessionKey: sessionEntry.key || null,
      sessionLabel: sessionEntry.label || null,
      sessionFile,
      userMessageId: event.id,
      role: "user",
      contentPreview: normalizedNote.slice(0, 400),
      label: conversation?.group_subject || sessionEntry?.subject || sessionEntry?.label || "Telegram",
    });

    const result = await upsertTelegramMessage(
      db,
      {
        ts,
        sourceId: buildMessageSourceId(sessionId, event.id),
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
        tags: mergedTags.join(","),
        tagsNorm: mergedTags.join(","),
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

  return { inserted, updated, unchanged };
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
  const stat = await fs.stat(sessionFile);
  if (!options.force && shouldSkipSession(sessionFile, stat, options.state)) {
    return { inserted: 0, updated: 0, unchanged: 0, skipped: 0, sessionSkippedByState: true };
  }
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let skipped = 0;
  let deleted = 0;

  const turnPairs = pairConversationTurns(events);
  const messageResult = await ingestUserMessages(db, sessionEntry, events, sessionFile, options);
  inserted += messageResult.inserted;
  updated += messageResult.updated;
  unchanged += messageResult.unchanged;
  for (const pair of turnPairs) {
    const current = pair.userEvent;
    const currentMessage = current?.message;
    const rawUserText = extractMessageText(currentMessage);
    const assistantText = pair.assistantText;
    const { conversation, sender, cleanedText } = extractTelegramMetadata(rawUserText);
    const sessionId = String(sessionEntry.sessionId || "");
    const sourceId = buildSourceId(sessionId, current.id);

    if (!isWorthKeeping(cleanedText, assistantText)) {
      if (options.force) {
        const removed = await deleteTelegramNoteBySourceId(db, sourceId, options.dryRun);
        if (removed) {
          deleted += 1;
        }
      }
      skipped += 1;
      continue;
    }

    const scope = getTelegramSessionScope(sessionEntry, conversation);
    const chatId = deriveChatId(sessionEntry, conversation);
    const threadId = deriveThreadId(sessionEntry, conversation);
    const userId = deriveUserId(sessionEntry, conversation, sender);
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
    const ts = current.timestamp || new Date().toISOString();
    const createdAt = String(ts).replace("T", " ").slice(0, 19);
    const { tags, tagsNorm } = tagsForKind(kind);
    const metaJson = JSON.stringify({
      conversation,
      sender,
      sessionKey: sessionEntry.key || null,
      sessionLabel: sessionEntry.label || null,
      sessionFile,
      userMessageId: current.id,
      assistantMessageId: null,
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

  if (!options.dryRun) {
    updateSessionState(options.state, sessionFile, stat);
  }

  return { inserted, updated, unchanged, skipped, deleted };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.sessionsFile) {
    console.error("Usage: node bin/ingest-telegram-sessions.js <sessions.json> [--limit N] [--dry-run]");
    process.exit(1);
  }

  const sessionsFile = path.resolve(args.sessionsFile);
  const sessionsIndex = await readJson(sessionsFile);
  const releaseLock = await acquireLock();
  const state = await loadState();
  const sessionEntries = getSessionEntries(sessionsIndex).filter(
    (entry) => entry && (entry.origin?.provider === "telegram" || String(entry.key || "").includes(":telegram:")),
  );

  const selectedEntries = args.limit > 0 ? sessionEntries.slice(0, args.limit) : sessionEntries;
  const db = await getDb();
  let totals = { inserted: 0, updated: 0, unchanged: 0, skipped: 0, deleted: 0, missingSessionFiles: 0, skippedByState: 0 };

  try {
    for (const sessionEntry of selectedEntries) {
      const result = await ingestSession(db, sessionEntry, sessionsFile, { dryRun: args.dryRun, state, force: args.force });
      totals.inserted += result.inserted;
      totals.updated += result.updated;
      totals.unchanged += result.unchanged;
      totals.skipped += result.skipped;
      totals.deleted += result.deleted || 0;
      totals.missingSessionFiles += result.missingSessionFile ? 1 : 0;
      totals.skippedByState += result.sessionSkippedByState ? 1 : 0;
    }

    if (!args.dryRun) {
      await saveState(state);
    }
  } finally {
    await db.close();
    await releaseLock();
  }

  console.log(
    JSON.stringify(
      {
        sessions: selectedEntries.length,
        dryRun: args.dryRun,
        force: args.force,
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
