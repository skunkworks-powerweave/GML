#!/usr/bin/env node
// Stop hook — appends one line per session to workspace/session_log.md.

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const logPath = resolve(root, "workspace", "session_log.md");
const dir = dirname(logPath);
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

const ts = new Date().toISOString();
appendFileSync(logPath, `\n- ${ts} — session ended\n`);
process.exit(0);
