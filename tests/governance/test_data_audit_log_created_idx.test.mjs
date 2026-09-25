// audit_log must be orderable by created_at alone, and every index must be
// declared once.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// The default /admin/audit view has no filter and runs
//     ORDER BY created_at DESC LIMIT 50 OFFSET ...
// audit_log carried (user_id, created_at), (entity_type, entity_id) and
// (action, created_at). A btree orders by its LEADING column, so none of them
// can serve a global ORDER BY created_at: the planner seq-scans and top-N sorts
// the whole table, every page load. And this is the one table that cannot
// shrink -- _post/001 revokes DELETE and installs a trigger that raises on it --
// while taking a row per learner-grid render and up to 30 client beacons a
// minute per user. The page an administrator opens when something has gone
// wrong was the page that got slower every day.
//
// ── WHY A NUMBERED MIGRATION, AND WHY NOT CONCURRENTLY ──────────────────────
//
// A numbered drizzle migration, declared in the schema, so the schema is the
// single source of truth and drizzle-kit does not later "discover" the index
// and generate it a second time. Not CONCURRENTLY: scripts/migrate.ts runs
// every migration inside a transaction, and CREATE INDEX CONCURRENTLY cannot
// run in one (25001) -- it would abort the one-shot migrate container and with
// it `docker compose up`. 0018 made the same call for the same reason.
//
// These read source text. tests/behaviour/audit-log-index.test.ts asks a real
// Postgres whether the planner actually uses the index.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const MIGRATIONS = "packages/db/src/migrations";
const POST = `${MIGRATIONS}/_post`;
const SCHEMA_DIR = "packages/db/src/schema";

/** SQL with `--` comments removed, so prose cannot satisfy or fail a match. */
const sqlCode = (s) => s.replace(/--.*$/gm, "");
/** TS with line and block comments removed. */
const tsCode = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const CREATE_INDEX =
  /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?\s+ON\s+(?:ONLY\s+)?(?:(?:public\.)?"?(\w+)"?)\s*(?:USING\s+\w+\s*)?\(([^)]*)\)/gi;

/** Every migration file the runner applies: numbered (journal order) then _post. */
function migrationFiles() {
  const journal = JSON.parse(read(`${MIGRATIONS}/meta/_journal.json`));
  const numbered = journal.entries.map((e) => `${MIGRATIONS}/${e.tag}.sql`);
  const post = readdirSync(resolve(root, POST))
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => `${POST}/${f}`);
  return { journal, numbered, post };
}

function indexCreations(files) {
  const out = [];
  for (const file of files) {
    for (const m of sqlCode(read(file)).matchAll(CREATE_INDEX)) {
      out.push({ file, name: m[1], table: m[2], cols: m[3].replace(/["\s]/g, "") });
    }
  }
  return out;
}

test("schema declares an audit_log index on created_at ALONE", () => {
  const src = tsCode(read(`${SCHEMA_DIR}/audit.ts`));
  assert.match(
    src,
    /index\(\s*"audit_log_created_idx"\s*\)\.on\(\s*t\.createdAt\s*\)/,
    "packages/db/src/schema/audit.ts must declare index(\"audit_log_created_idx\").on(t.createdAt). " +
      "(user_id, created_at) and (action, created_at) cannot serve the unfiltered ORDER BY created_at.",
  );
});

test("a numbered, journalled migration creates audit_log_created_idx on audit_log(created_at)", () => {
  const { numbered } = migrationFiles();
  const hits = indexCreations(numbered).filter((c) => c.name === "audit_log_created_idx");
  assert.equal(
    hits.length,
    1,
    "exactly one numbered migration listed in _journal.json must create audit_log_created_idx " +
      `(found ${hits.length}: ${hits.map((h) => h.file).join(", ") || "none"})`,
  );
  assert.equal(hits[0].table, "audit_log");
  assert.equal(hits[0].cols, "created_at", "the index must lead with -- and only contain -- created_at");

  const src = sqlCode(read(hits[0].file));
  assert.ok(
    !/CONCURRENTLY/i.test(src),
    `${hits[0].file} must not use CREATE INDEX CONCURRENTLY: scripts/migrate.ts runs it inside a ` +
      "transaction, Postgres refuses (25001), and the migrate container exits non-zero",
  );
});

test("the journal's timestamps strictly increase, so the drizzle migrator applies the new entry", () => {
  // drizzle's migrator applies an entry only if its `when` is later than the
  // last one recorded in __drizzle_migrations. An entry stamped earlier than
  // its predecessor is silently skipped on every existing database.
  const { journal } = migrationFiles();
  for (let i = 1; i < journal.entries.length; i += 1) {
    const prev = journal.entries[i - 1];
    const cur = journal.entries[i];
    assert.ok(
      cur.when > prev.when,
      `_journal.json entry ${cur.tag} (when=${cur.when}) must be later than ${prev.tag} (when=${prev.when})`,
    );
  }
});

test("no index is created by more than one migration file, numbered or _post", () => {
  // Two files creating the same index is how a schema ends up with the same
  // thing declared twice: with IF NOT EXISTS the second is silently skipped,
  // so whichever definition ran first wins; without it a fresh database
  // aborts with 42P07. Either way one of the two declarations is a lie.
  const { numbered, post } = migrationFiles();
  const byName = new Map();
  for (const c of indexCreations([...numbered, ...post])) {
    if (!byName.has(c.name)) byName.set(c.name, []);
    byName.get(c.name).push(c.file);
  }
  const dropped = new Set(
    [...numbered, ...post].flatMap((f) =>
      [...sqlCode(read(f)).matchAll(/DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?"?(\w+)"?/gi)].map(
        (m) => m[1],
      ),
    ),
  );
  const dupes = [...byName].filter(([name, files]) => files.length > 1 && !dropped.has(name));
  assert.deepEqual(
    dupes.map(([name, files]) => `${name}: ${files.join(", ")}`),
    [],
    "each index must be created by exactly one migration file",
  );
});

test("every index the schema declares is created by a migration", () => {
  const { numbered, post } = migrationFiles();
  const created = new Set(indexCreations([...numbered, ...post]).map((c) => c.name));
  const missing = [];
  for (const f of readdirSync(resolve(root, SCHEMA_DIR)).filter((n) => n.endsWith(".ts"))) {
    for (const m of tsCode(read(`${SCHEMA_DIR}/${f}`)).matchAll(/\b(?:index|uniqueIndex)\(\s*"(\w+)"\s*\)/g)) {
      if (!created.has(m[1])) missing.push(`${f}: ${m[1]}`);
    }
  }
  assert.deepEqual(missing, [], "a schema-declared index with no migration exists only in TypeScript");
});

test("the /admin/audit action dropdown comes from the data, cheaply, not from a hardcoded list", () => {
  // The dropdown's selectDistinct ran over the whole table on every page load.
  // A static catalogue was the bug the page had just fixed -- nine literal
  // names that drifted from what the code writes, so every option returned
  // zero rows. This used to pin `selectDistinct ... .where(gte(createdAt))`,
  // but a 90-day bound caps the age of what that reads, not the amount: every
  // row of 90 days, 1.9 s at 2M rows (F108). The invariant now: the options are
  // still read from audit_log and still limited to recent actions, by a loose
  // index scan -- one "next action" probe per distinct action.
  // tests/behaviour/admin-audit-lookups.test.ts counts the rows it reads.
  const page = tsCode(read("apps/web/src/app/(authenticated)/admin/audit/page.tsx"));
  assert.match(page, /const actionOptions = await recentAuditActions\(/, "the page must take its options from recentAuditActions()");
  const lookups = tsCode(read("apps/web/src/admin/audit-lookups.ts"));
  assert.match(lookups, /WITH RECURSIVE/, "the options must come from a loose index scan over audit_log");
  assert.match(lookups, /a\.action > actions\.action ORDER BY a\.action LIMIT 1/, "each step must be a single next-action probe");
  assert.match(lookups, /created_at >= now\(\)/, "the options must stay limited to recently recorded actions");
});
