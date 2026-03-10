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

type PluginConfig = {
  engineRoot: string;
  nodeBin: string;
  minPromptChars: number;
  maxResults: number;
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

async function searchMemory(params: {
  agentId: string;
  query: string;
  workspaceDir?: string;
  cfg: PluginConfig;
  logger: OpenClawPluginApi["logger"];
}): Promise<string | null> {
  const cacheKey = `${params.agentId}\n${params.query}`;
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
    parsed = JSON.parse(stdout) as { results?: SearchHit[] };
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

      const memoryContext = await searchMemory({
        agentId: ctx.agentId ?? "main",
        query,
        workspaceDir: ctx.workspaceDir,
        cfg,
        logger: api.logger
      });

      if (!memoryContext) {
        return;
      }

      api.logger.info?.(`global-memory: injected recall (${memoryContext.length} chars)`);
      return { prependContext: memoryContext };
    });
  }
};

export default plugin;
