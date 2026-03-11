import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

type SearchHit = {
  path?: string;
  startLine?: number;
  endLine?: number;
  score?: number;
  snippet?: string;
  source?: string;
};

type RuntimeMemoryContext = {
  source?: string;
  scope?: string;
  chatId?: string;
  threadId?: string;
  userId?: string;
  sessionId?: string;
};

type PluginConfig = {
  engineRoot: string;
  nodeBin: string;
  minPromptChars: number;
  maxResults: number;
  recentChatMaxItems: number;
  recentChatMaxChars: number;
  minScore: number;
  maxChars: number;
  maxSnippetChars: number;
  timeoutMs: number;
  userTriggersOnly: boolean;
};

const DEFAULT_CONFIG: PluginConfig = {
  engineRoot: path.join(process.env.HOME || ".", ".openclaw", "memory-layer", "engine"),
  nodeBin: process.execPath,
  minPromptChars: 12,
  maxResults: 3,
  recentChatMaxItems: 4,
  recentChatMaxChars: 900,
  minScore: 0.3,
  maxChars: 1400,
  maxSnippetChars: 360,
  timeoutMs: 12000,
  userTriggersOnly: true,
};

const CACHE_TTL_MS = 60_000;
const resultCache = new Map<string, { expiresAt: number; value: string | null }>();
const execFileAsync = promisify(execFile);

function normalizeConfig(raw: Record<string, unknown> | undefined): PluginConfig {
  const cfg = raw ?? {};
  return {
    engineRoot: typeof cfg.engineRoot === "string" && cfg.engineRoot.trim() ? cfg.engineRoot.trim() : DEFAULT_CONFIG.engineRoot,
    nodeBin: typeof cfg.nodeBin === "string" && cfg.nodeBin.trim() ? cfg.nodeBin.trim() : DEFAULT_CONFIG.nodeBin,
    minPromptChars:
      typeof cfg.minPromptChars === "number" ? Math.max(1, Math.floor(cfg.minPromptChars)) : DEFAULT_CONFIG.minPromptChars,
    maxResults: typeof cfg.maxResults === "number" ? Math.max(1, Math.floor(cfg.maxResults)) : DEFAULT_CONFIG.maxResults,
    recentChatMaxItems:
      typeof cfg.recentChatMaxItems === "number"
        ? Math.max(1, Math.floor(cfg.recentChatMaxItems))
        : DEFAULT_CONFIG.recentChatMaxItems,
    recentChatMaxChars:
      typeof cfg.recentChatMaxChars === "number"
        ? Math.max(200, Math.floor(cfg.recentChatMaxChars))
        : DEFAULT_CONFIG.recentChatMaxChars,
    minScore: typeof cfg.minScore === "number" ? cfg.minScore : DEFAULT_CONFIG.minScore,
    maxChars: typeof cfg.maxChars === "number" ? Math.max(200, Math.floor(cfg.maxChars)) : DEFAULT_CONFIG.maxChars,
    maxSnippetChars:
      typeof cfg.maxSnippetChars === "number"
        ? Math.max(120, Math.floor(cfg.maxSnippetChars))
        : DEFAULT_CONFIG.maxSnippetChars,
    timeoutMs: typeof cfg.timeoutMs === "number" ? Math.max(1000, Math.floor(cfg.timeoutMs)) : DEFAULT_CONFIG.timeoutMs,
    userTriggersOnly: typeof cfg.userTriggersOnly === "boolean" ? cfg.userTriggersOnly : DEFAULT_CONFIG.userTriggersOnly,
  };
}

function normalizeQuery(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim();
}

function normalizeOptional(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const normalized = String(value).trim();
  return normalized || undefined;
}

function extractRuntimeMemoryContext(event: any, ctx: any): RuntimeMemoryContext {
  const combined = {
    ...(ctx ?? {}),
    ...(ctx?.message ?? {}),
    ...(ctx?.telegram ?? {}),
    ...(event?.metadata ?? {}),
  };

  const source =
    normalizeOptional(combined.source) ||
    normalizeOptional(combined.channel) ||
    normalizeOptional(combined.platform);
  const chatId =
    normalizeOptional(combined.chatId) ||
    normalizeOptional(combined.chat_id);
  const threadId =
    normalizeOptional(combined.threadId) ||
    normalizeOptional(combined.thread_id) ||
    normalizeOptional(combined.topicId) ||
    normalizeOptional(combined.topic_id);
  const userId =
    normalizeOptional(combined.userId) ||
    normalizeOptional(combined.user_id) ||
    normalizeOptional(combined.fromId) ||
    normalizeOptional(combined.from_id);
  const sessionId =
    normalizeOptional(combined.sessionId) ||
    normalizeOptional(combined.session_id);

  const scope = source === "telegram" ? (threadId ? "session" : chatId ? "chat" : userId ? "user" : "global") : "global";

  return {
    source,
    scope,
    chatId,
    threadId,
    userId,
    sessionId,
  };
}

function sanitizeSnippet(text: string, maxChars: number): string {
  const collapsed = text
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (collapsed.length <= maxChars) {
    return collapsed;
  }
  return `${collapsed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function formatHit(hit: SearchHit, maxSnippetChars: number): string | null {
  if (!hit.snippet || !hit.path) {
    return null;
  }
  const snippet = sanitizeSnippet(hit.snippet, maxSnippetChars);
  if (!snippet) {
    return null;
  }
  const loc =
    typeof hit.startLine === "number" && typeof hit.endLine === "number"
      ? `${hit.path}:${hit.startLine}-${hit.endLine}`
      : hit.path;
  const score = typeof hit.score === "number" ? ` score=${hit.score.toFixed(2)}` : "";
  return `- [${loc}${score}] ${snippet}`;
}

function formatContext(hits: SearchHit[], cfg: PluginConfig): string | null {
  const lines: string[] = [];
  let charCount = 0;

  for (const hit of hits) {
    const line = formatHit(hit, cfg.maxSnippetChars);
    if (!line) {
      continue;
    }
    const nextCount = charCount + line.length + 1;
    if (lines.length > 0 && nextCount > cfg.maxChars) {
      break;
    }
    lines.push(line);
    charCount = nextCount;
  }

  if (lines.length === 0) {
    return null;
  }

  return [
    "Relevant memory notes:",
    ...lines,
    "Use these only as supporting factual context. Current user instructions and current workspace state take priority.",
  ].join("\n");
}

function parseSearchJson(stdout: string): { results?: SearchHit[] } | null {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as { results?: SearchHit[] };
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("No JSON object found in search output");
    }
    return JSON.parse(trimmed.slice(start, end + 1)) as { results?: SearchHit[] };
  }
}

type RecentChatHit = {
  path?: string;
  ts?: string;
  kind?: string;
  snippet?: string;
};

function formatRecentChatContext(hits: RecentChatHit[]): string | null {
  if (!hits.length) {
    return null;
  }

  return [
    "Recent chat context:",
    ...hits.map((hit) => {
      const ts = hit.ts ? `[${hit.ts}] ` : "";
      const pathLabel = hit.path ? `${hit.path} ` : "";
      const kind = hit.kind ? `(${hit.kind}) ` : "";
      return `- ${ts}${pathLabel}${kind}${sanitizeSnippet(hit.snippet || "", 220)}`;
    }),
    "Use this as recent local chat context. Prefer the current chat scope over unrelated global context.",
  ].join("\n");
}

function buildDocumentPromptHint(query: string): string | null {
  const normalized = query.toLowerCase();
  const specs = [
    {
      re: /\b(билет|ticket|boarding pass|посадочн|flight|рейс|pnr)\b/i,
      label: "билет или перелётные данные",
      question: "Похоже, в чат прилетел билет или перелётные данные. Сразу коротко спроси, сохранить ли детали, проверить маршрут или сделать выжимку."
    },
    {
      re: /\b(бронь|booking|reservation|hotel|отель|airbnb|check-in|check out)\b/i,
      label: "бронь",
      question: "Похоже, это бронь. Сразу коротко спроси, сохранить ли ключевые даты, контакты и условия бронирования."
    },
    {
      re: /\b(маршрутн|itinerary|маршрут|route sheet|travel plan)\b/i,
      label: "маршрутный лист",
      question: "Похоже, это маршрутный лист. Сразу коротко спроси, вытащить ли сегменты маршрута, даты и контрольные точки."
    },
    {
      re: /\b(invoice|receipt|сч[её]т|чек|оплат|amount due)\b/i,
      label: "счёт или чек",
      question: "Похоже, это счёт или чек. Сразу коротко спроси, извлечь ли сумму, дату и контрагента."
    },
    {
      re: /\b(manual|documentation|docs|инструкц|документац|spec|runbook|pdf|docx?|xlsx?|pptx?)\b/i,
      label: "документ",
      question: "Похоже, в чат попал документ. Сразу коротко спроси, нужна ли выжимка, индексация в память или разбор следующих действий."
    },
  ];

  for (const spec of specs) {
    if (spec.re.test(normalized)) {
      return [
        `Document-intake hint: detected ${spec.label}.`,
        spec.question,
        "Do not change model routing. Keep the normal reply model; just adapt the response shape.",
      ].join("\n");
    }
  }

  return null;
}

async function searchMemory(params: {
  agentId: string;
  query: string;
  workspaceDir?: string;
  cfg: PluginConfig;
  memoryContext: RuntimeMemoryContext;
  logger: OpenClawPluginApi["logger"];
}): Promise<string | null> {
  const cacheKey = JSON.stringify({
    agentId: params.agentId,
    query: params.query,
    memoryContext: params.memoryContext,
  });
  const cached = resultCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  let stdout = "";
  let stderr = "";
  try {
    const result = await execFileAsync(
      params.cfg.nodeBin,
      [
        path.join(params.cfg.engineRoot, "bin", "search.js"),
        "--query",
        params.query,
        "--limit",
        String(params.cfg.maxResults),
        ...(params.memoryContext.source ? ["--source", params.memoryContext.source] : []),
        ...(params.memoryContext.scope ? ["--scope", params.memoryContext.scope] : []),
        ...(params.memoryContext.chatId ? ["--chat-id", params.memoryContext.chatId] : []),
        ...(params.memoryContext.threadId ? ["--thread-id", params.memoryContext.threadId] : []),
        ...(params.memoryContext.userId ? ["--user-id", params.memoryContext.userId] : []),
        ...(params.memoryContext.sessionId ? ["--session-id", params.memoryContext.sessionId] : []),
        "--json",
      ],
      {
        cwd: params.workspaceDir,
        timeout: params.cfg.timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    if (typeof error === "object" && error) {
      const err = error as { stdout?: string; stderr?: string; message?: string };
      stdout = err.stdout ?? "";
      stderr = err.stderr ?? err.message ?? "";
    } else {
      stderr = String(error);
    }
  }

  let parsed: { results?: SearchHit[] } | null = null;
  try {
    parsed = parseSearchJson(stdout);
  } catch (error) {
    const detail = stderr.trim() || String(error);
    params.logger.warn(`global-memory: memory search failed${detail ? `: ${detail}` : ""}`);
    resultCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, value: null });
    return null;
  }

  const hits = (parsed.results ?? [])
    .filter((hit) => typeof hit.score === "number" && hit.score >= params.cfg.minScore)
    .slice(0, params.cfg.maxResults);

  const formatted = formatContext(hits, params.cfg);
  resultCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, value: formatted });
  return formatted;
}

async function fetchRecentChatContext(params: {
  workspaceDir?: string;
  cfg: PluginConfig;
  memoryContext: RuntimeMemoryContext;
  logger: OpenClawPluginApi["logger"];
}): Promise<string | null> {
  if (params.memoryContext.source !== "telegram") {
    return null;
  }
  if (!params.memoryContext.chatId && !params.memoryContext.threadId && !params.memoryContext.userId) {
    return null;
  }

  let stdout = "";
  let stderr = "";
  try {
    const result = await execFileAsync(
      params.cfg.nodeBin,
      [
        path.join(params.cfg.engineRoot, "bin", "recent-chat-context.js"),
        "--limit",
        String(params.cfg.recentChatMaxItems),
        "--max-chars",
        String(params.cfg.recentChatMaxChars),
        ...(params.memoryContext.source ? ["--source", params.memoryContext.source] : []),
        ...(params.memoryContext.scope ? ["--scope", params.memoryContext.scope] : []),
        ...(params.memoryContext.chatId ? ["--chat-id", params.memoryContext.chatId] : []),
        ...(params.memoryContext.threadId ? ["--thread-id", params.memoryContext.threadId] : []),
        ...(params.memoryContext.userId ? ["--user-id", params.memoryContext.userId] : []),
        ...(params.memoryContext.sessionId ? ["--session-id", params.memoryContext.sessionId] : []),
        "--json",
      ],
      {
        cwd: params.workspaceDir,
        timeout: params.cfg.timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    if (typeof error === "object" && error) {
      const err = error as { stdout?: string; stderr?: string; message?: string };
      stdout = err.stdout ?? "";
      stderr = err.stderr ?? err.message ?? "";
    } else {
      stderr = String(error);
    }
  }

  try {
    const parsed = parseSearchJson(stdout) as { results?: RecentChatHit[] } | null;
    return formatRecentChatContext(parsed?.results ?? []);
  } catch (error) {
    const detail = stderr.trim() || String(error);
    params.logger.warn(`global-memory: recent chat context failed${detail ? `: ${detail}` : ""}`);
    return null;
  }
}

const plugin = {
  id: "global-memory",
  name: "Global Memory",
  description: "Automatic narrow memory recall for every OpenClaw turn.",
  configSchema: {
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        engineRoot: { type: "string", minLength: 1 },
        nodeBin: { type: "string", minLength: 1 },
        minPromptChars: { type: "number", minimum: 1, maximum: 2000 },
        maxResults: { type: "number", minimum: 1, maximum: 10 },
        recentChatMaxItems: { type: "number", minimum: 1, maximum: 12 },
        recentChatMaxChars: { type: "number", minimum: 200, maximum: 4000 },
        minScore: { type: "number", minimum: 0, maximum: 1 },
        maxChars: { type: "number", minimum: 200, maximum: 5000 },
        maxSnippetChars: { type: "number", minimum: 120, maximum: 2000 },
        timeoutMs: { type: "number", minimum: 1000, maximum: 30000 },
        userTriggersOnly: { type: "boolean" }
      }
    }
  },
  register(api: OpenClawPluginApi) {
    const cfg = normalizeConfig(api.pluginConfig);

    api.on("before_prompt_build", async (event, ctx) => {
      if (cfg.userTriggersOnly && ctx.trigger && ctx.trigger !== "user") {
        return;
      }

      const query = normalizeQuery(event.prompt);
      if (query.length < cfg.minPromptChars) {
        return;
      }

      const runtimeMemoryContext = extractRuntimeMemoryContext(event, ctx);
      const recentChatContext = await fetchRecentChatContext({
        workspaceDir: ctx.workspaceDir,
        cfg,
        memoryContext: runtimeMemoryContext,
        logger: api.logger
      });

      const memoryContext = await searchMemory({
        agentId: ctx.agentId ?? "main",
        query,
        workspaceDir: ctx.workspaceDir,
        cfg,
        memoryContext: runtimeMemoryContext,
        logger: api.logger
      });

      const documentHint = runtimeMemoryContext.source === "telegram" ? buildDocumentPromptHint(query) : null;
      const sections = [recentChatContext, memoryContext, documentHint].filter(Boolean);

      if (sections.length === 0) {
        return;
      }

      const prependContext = sections.join("\n\n");
      api.logger.info?.(`global-memory: injected recall (${prependContext.length} chars)`);
      return { prependContext };
    });
  }
};

export default plugin;
