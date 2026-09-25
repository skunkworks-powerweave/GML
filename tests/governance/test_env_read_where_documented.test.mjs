// Configuration is documented where it is read, and forwarded only where it is.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// .env.example and README-IT claim "every variable it lists is read somewhere,
// and everything the code reads is listed". Two ways that stopped being true:
//
//   caddy      was handed SUPABASE_ORIGIN under a comment that "the CSP has to
//              name the exact Supabase project origin". docker/Caddyfile never
//              reads it: the CSP is issued by apps/web/src/proxy.ts, from
//              NEXT_PUBLIC_SUPABASE_URL.
//   backup.sh  reads KEEP_DAILY and SUPABASE_S3_REGION from .env, and neither
//              was in .env.example -- while /admin/system-settings tells
//              administrators to "ask IT to set KEEP_DAILY".
//
// ── WHAT THIS PINS ───────────────────────────────────────────────────────────
//
// Every variable compose hands to caddy is one the Caddyfile reads, and every
// .env setting backup.sh reads (`${NAME:-default}`) is named in .env.example.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");
/** `#`-comment-stripped text (compose, shell). */
const code = (s) => s.replace(/(^|\s)#.*$/gm, "$1");

test("every variable compose passes to caddy is read by the Caddyfile", () => {
  const yaml = code(read("docker-compose.yml"));
  const start = yaml.indexOf("\n  caddy:\n");
  assert.ok(start >= 0, "caddy service not found");
  const block = yaml.slice(start, yaml.indexOf("\nvolumes:", start));
  const env = block.match(/\n {4}environment:\n((?: {6}.*\n)+)/)?.[1] ?? "";
  const keys = [...env.matchAll(/^ {6}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]);
  assert.ok(keys.length > 0, "caddy's environment block was not found");
  const caddyfile = code(read("docker/Caddyfile"));
  const unread = keys.filter((k) => !caddyfile.includes(`{$${k}`));
  assert.deepEqual(unread, [], "passed to caddy but never read by docker/Caddyfile");
});

test("every .env setting backup.sh reads is named in .env.example", () => {
  const src = code(read("scripts/backup.sh"));
  const example = read(".env.example");
  const names = [...new Set([...src.matchAll(/\$\{([A-Z][A-Z0-9_]*):-/g)].map((m) => m[1]))];
  const undocumented = names.filter((n) => !new RegExp(`\\b${n}\\b`).test(example));
  assert.deepEqual(undocumented, [], "backup.sh reads these from .env, and .env.example never mentions them");
});
