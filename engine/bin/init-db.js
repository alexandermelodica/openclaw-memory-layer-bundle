#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { getConfig } = require("../lib/config.js");

const config = getConfig();

if (!fs.existsSync(config.schemaPath)) {
  console.error(`Schema not found: ${config.schemaPath}`);
  process.exit(1);
}

try {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  execFileSync("sqlite3", [config.dbPath, `.read ${config.schemaPath}`], { stdio: "inherit" });
  console.log(`Initialized memory database: ${config.dbPath}`);
} catch (error) {
  console.error("Failed to initialize memory database.");
  console.error(error.message);
  process.exit(1);
}
