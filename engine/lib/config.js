const path = require("path");

function resolveEngineRoot() {
  return path.resolve(__dirname, "..");
}

function resolveDataRoot() {
  return process.env.MEMORY_LAYER_HOME
    ? path.resolve(process.env.MEMORY_LAYER_HOME)
    : path.join(process.env.HOME || ".", ".openclaw", "memory-layer");
}

function getConfig() {
  const engineRoot = resolveEngineRoot();
  const dataRoot = resolveDataRoot();

  return {
    engineRoot,
    dataRoot,
    dbPath: process.env.MEMORY_LAYER_DB || path.join(dataRoot, "db", "memory.sqlite"),
    vecExtPath:
      process.env.MEMORY_LAYER_VEC_EXT_PATH || path.join(engineRoot, "sqlite-vec", "vec0.so"),
    schemaPath: path.join(engineRoot, "memory", "schema.sql"),
    ollamaUrl: process.env.MEMORY_LAYER_OLLAMA_URL || "http://127.0.0.1:11434",
    embedModel: process.env.MEMORY_LAYER_EMBED_MODEL || "nomic-embed-text",
    project: process.env.MEMORY_LAYER_PROJECT || "openclaw",
    env: process.env.MEMORY_LAYER_ENV || "production",
    tags: (process.env.MEMORY_LAYER_TAGS || "")
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean),
  };
}

module.exports = { getConfig };
