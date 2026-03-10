#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const configPath =
  process.argv[2] || path.join(process.env.HOME || ".", ".openclaw", "openclaw.json");
const engineRoot =
  process.argv[3] || path.join(process.env.HOME || ".", ".openclaw", "memory-layer", "engine");

if (!fs.existsSync(configPath)) {
  console.error(`OpenClaw config not found: ${configPath}`);
  process.exit(1);
}

const raw = fs.readFileSync(configPath, "utf8");
const json = JSON.parse(raw);

json.plugins = json.plugins || {};
json.plugins.allow = Array.isArray(json.plugins.allow) ? json.plugins.allow : [];
if (!json.plugins.allow.includes("global-memory")) {
  json.plugins.allow.push("global-memory");
}

json.plugins.entries = json.plugins.entries || {};
const existing = json.plugins.entries["global-memory"] || {};
json.plugins.entries["global-memory"] = {
  ...existing,
  enabled: true,
  config: {
    engineRoot,
    nodeBin: process.execPath,
    maxResults: 3,
    minScore: 0.35,
    maxChars: 1400,
    maxSnippetChars: 320,
    timeoutMs: 12000,
    minPromptChars: 12,
    userTriggersOnly: true,
    ...(existing.config || {})
  }
};

const backupPath = `${configPath}.memory-layer-backup-${new Date().toISOString().replace(/[:]/g, "-")}`;
fs.copyFileSync(configPath, backupPath);
fs.writeFileSync(configPath, `${JSON.stringify(json, null, 2)}\n`);

console.log(JSON.stringify({ ok: true, configPath, backupPath, engineRoot }, null, 2));
