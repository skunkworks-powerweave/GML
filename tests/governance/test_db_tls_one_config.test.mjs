// Every Postgres connection is built from client.ts's configuration.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
//
// packages/db/src/client.ts is the one place that decides TLS for Postgres (the
// documented DATABASE_URL carries no sslmode, and node-postgres sends no
// SSLRequest unless asked). migrate.ts, the five seeds, verify-auth.mjs, the
// retention sweep and the worker healthcheck each built a bare
// `new Pool/Client({ connectionString })` instead, so every one of them spoke to
// the Supabase pooler in plaintext. tests/behaviour/db-tls.test.ts runs each of
// those entry points and watches it ask for TLS; this pins the part no test can
// run -- the NEXT script someone writes -- by refusing a pg client constructed
// from anything other than client.ts's poolConfig().

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
/** Comments stripped, so prose describing the old shape cannot trip the check (YAML: `#`). */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const CLIENT = "packages/db/src/client.ts";

function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|tsx|mts|js|mjs|cjs)$/.test(name)) out.push(p);
  }
  return out;
}

test("no pg Pool or Client outside client.ts is built from anything but poolConfig()", () => {
  const offenders = [];
  const files = [
    ...["apps", "packages", "scripts"].flatMap((d) => sourceFiles(resolve(root, d))),
    resolve(root, "docker-compose.yml"),
  ];
  for (const f of files) {
    const rel = relative(root, f).split("\\").join("/");
    if (rel === CLIENT) continue;
    const text = readFileSync(f, "utf8");
    const src = rel.endsWith(".yml") ? text.replace(/(^|\s)#.*$/gm, "$1") : code(text);
    for (const m of src.matchAll(/new\s+(?:pg\.)?(?:Pool|Client)\s*\(/g)) {
      const rest = src.slice(m.index + m[0].length);
      if (!/^\s*poolConfig\(\)\s*\)/.test(rest)) {
        offenders.push(`${rel}: ${src.slice(m.index, m.index + 70).split("\n")[0]}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "construct pg clients with `new Pool(poolConfig())` / `new pg.Client(poolConfig())` from " +
      "@gml/db's client.ts (or use getPool()/getDb()), so TLS is negotiated the one way client.ts does",
  );
});
