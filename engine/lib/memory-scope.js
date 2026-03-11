const TELEGRAM_SOURCE = "telegram";
const DEFAULT_SOURCE = "filesystem";
const DEFAULT_SCOPE = "global";

function normalizeOptional(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function normalizeScope(scope) {
  const value = normalizeOptional(scope);
  if (!value) {
    return DEFAULT_SCOPE;
  }
  if (["session", "chat", "user", "global"].includes(value)) {
    return value;
  }
  return DEFAULT_SCOPE;
}

function normalizeMemoryContext(raw = {}) {
  return {
    source: normalizeOptional(raw.source) || DEFAULT_SOURCE,
    scope: normalizeScope(raw.scope),
    chatId: normalizeOptional(raw.chatId),
    threadId: normalizeOptional(raw.threadId),
    userId: normalizeOptional(raw.userId),
    sessionId: normalizeOptional(raw.sessionId),
  };
}

function scopeBonus(row, context) {
  const rowScope = normalizeScope(row.scope);
  const rowSource = normalizeOptional(row.source);

  if (context.source === TELEGRAM_SOURCE) {
    if (rowScope === "session" && context.sessionId && row.session_id === context.sessionId) return 0.35;
    if (rowScope === "chat" && context.chatId && row.chat_id === context.chatId) {
      if (row.thread_id && context.threadId && row.thread_id === context.threadId) return 0.32;
      if (!row.thread_id) return 0.28;
    }
    if (rowScope === "user" && context.userId && row.user_id === context.userId) return 0.22;
    if (rowScope === "global") {
      if (rowSource === TELEGRAM_SOURCE) return 0.02;
      if (["decision", "runbook", "config", "postmortem"].includes(String(row.kind || ""))) return -0.02;
      return -0.18;
    }
    return Number.NEGATIVE_INFINITY;
  }

  if (rowScope === "global") {
    return 0;
  }
  return Number.NEGATIVE_INFINITY;
}

function allowRowForContext(row, context) {
  const bonus = scopeBonus(row, context);
  return Number.isFinite(bonus);
}

function scopeRank(row, context) {
  const rowScope = normalizeScope(row.scope);

  if (context.source === TELEGRAM_SOURCE) {
    if (rowScope === "session" && context.sessionId && row.session_id === context.sessionId) return 4;
    if (rowScope === "chat" && context.chatId && row.chat_id === context.chatId) return row.thread_id && context.threadId && row.thread_id === context.threadId ? 3 : 3;
    if (rowScope === "user" && context.userId && row.user_id === context.userId) return 2;
    if (rowScope === "global") return 1;
    return 0;
  }

  return rowScope === "global" ? 1 : 0;
}

function sourceFilterClause(context, whereConditions, queryParams) {
  if (!context.source) {
    return;
  }

  if (context.source === TELEGRAM_SOURCE) {
    whereConditions.push(
      "((e.source = ?) OR (e.scope = 'global' AND e.kind IN ('decision', 'runbook', 'config', 'postmortem') AND (e.source IS NULL OR e.source != ?)))",
    );
    queryParams.push(TELEGRAM_SOURCE, TELEGRAM_SOURCE);
    return;
  }

  whereConditions.push("(e.source = ? OR e.source IS NULL)");
  queryParams.push(context.source);
}

module.exports = {
  DEFAULT_SCOPE,
  DEFAULT_SOURCE,
  TELEGRAM_SOURCE,
  normalizeMemoryContext,
  allowRowForContext,
  scopeBonus,
  scopeRank,
  sourceFilterClause,
};
