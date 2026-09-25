// `drizzle-kit generate` against the committed migrations produces nothing.
//
// ── THE DEFECT (F107) ────────────────────────────────────────────────────────
//
// Migrations 0022 onward were written by hand without snapshots, so meta/
// stopped at 0021_snapshot.json -- a schema that still had accounts,
// auth_sessions, password_reset_tokens and verification_tokens, and lacked
// jobs, rate_limits, quiz_attempts, pairing commitments, reviewed_at and the
// newer indexes. drizzle-kit diffs the schema against the LATEST snapshot, so
// the first `pnpm --filter @gml/db generate` for any schema change emitted a
// migration that re-CREATEd jobs, rate_limits and quiz_attempts, DROPped four
// tables already gone and re-added columns and indexes that exist. Applied,
// it aborts on "relation already exists", the one-shot migrate container
// exits non-zero, and app and worker never start. (Run without a terminal it
// just stops at "Is quiz_attempts table created or renamed?".)
//
// The first test runs the project's own drizzle-kit, exactly as `generate`
// does, against the real schema and a scratch copy of meta/ -- so it can write
// nothing into the repository -- and requires "No schema changes". Every later
// schema change must commit the migration and snapshot generate wrote for it,
// or this fails. It needs no database: generate never connects to one.
//
// The second closes the other direction: that the latest snapshot describes
// the database the numbered migrations actually build. Hand-written migrations
// are how the two came apart, and they still will be written (a guarded
// rename, a partial index). So drizzle-kit builds the snapshot's schema into a
// scratch Postgres schema, and its catalog is compared with `public`, inside a
// transaction that is rolled back.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { needsDatabase, withClient } from "./_harness.js";

const DB = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "packages/db");
const DRIZZLE_KIT = join(DB, "node_modules", "drizzle-kit", "bin.cjs");
/** drizzle-kit takes a glob; it wants forward slashes on Windows too. */
const posix = (p: string) => p.split("\\").join("/");

test("drizzle-kit generate finds no difference between the schema and the committed snapshots", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "drizzle-generate-"));
  try {
    const out = join(scratch, "migrations");
    cpSync(join(DB, "src", "migrations", "meta"), join(out, "meta"), { recursive: true });
    const before = readdirSync(out, { recursive: true }).map(String).sort();

    const run = await new Promise<{ code: number | null; text: string }>((done, reject) => {
      const child = spawn(
        process.execPath,
        [
          DRIZZLE_KIT,
          "generate",
          "--dialect", "postgresql",
          "--schema", posix(join(DB, "src", "schema", "*.ts")),
          // Relative to cwd: drizzle-kit joins an absolute Windows path onto cwd.
          "--out", "./migrations",
          "--name", "snapshot_probe",
        ],
        // stdin closed: an interactive rename prompt is a failure, not a hang.
        { cwd: scratch, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } },
      );
      let text = "";
      child.stdout.on("data", (d) => (text += String(d)));
      child.stderr.on("data", (d) => (text += String(d)));
      const timer = setTimeout(() => child.kill(), 120_000);
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        done({ code, text });
      });
    });

    const written = readdirSync(out, { recursive: true }).map(String).sort();
    assert.deepEqual(
      written.filter((f) => !before.includes(f)),
      [],
      `drizzle-kit generate wrote a migration, so the committed snapshots do not describe the ` +
        `schema the numbered migrations build:\n${run.text}`,
    );
    assert.match(
      run.text,
      /No schema changes/,
      `drizzle-kit generate must report no schema changes against the latest committed snapshot:\n${run.text}`,
    );
    assert.equal(run.code, 0, run.text);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

/**
 * Differences that are real but cannot matter to drizzle-kit, each for a
 * stated reason. Anything else is drift.
 */
const KNOWN = [
  // 0005 renamed the old `sessions` to auth_sessions, keeping its index name
  // sessions_pkey, so 0006's new table got sessions_pkey1. drizzle-kit never
  // names a single-column primary key in the SQL it generates.
  /\bsessions_pkey1?\b/,
  // NULLS NOT DISTINCT (migration 0031). Drizzle 0.39's index builder cannot
  // express it; formDrafts.ts says so beside the declaration.
  /\bform_drafts_user_template_pairing_uq\b/,
];

/** Columns, indexes, constraints and enums in one schema, with that schema's name taken out. */
async function catalog(c: Client, schema: string): Promise<Set<string>> {
  const q = async (text: string) => (await c.query(text, [schema])).rows;
  // Tables that are not the application's: migrate.ts's ledger, and the table
  // rls-every-deploy.test.ts creates for the length of one migrate run.
  const own = `t.relname <> '_post_migrations_applied' AND t.relname NOT LIKE 'rls\\_probe\\_%'`;
  const unqualify = (s: string) => s.split(`${schema}.`).join("");
  const out = new Set<string>();
  for (const r of await q(
    `SELECT t.relname, a.attname, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull,
            pg_get_expr(d.adbin, d.adrelid) AS def
       FROM pg_attribute a JOIN pg_class t ON t.oid = a.attrelid JOIN pg_namespace n ON n.oid = t.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname = $1 AND t.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped AND ${own}`,
  )) {
    out.add(`column ${r.relname}.${r.attname} ${unqualify(r.type)} notnull=${r.attnotnull} default=${unqualify(r.def ?? "")}`);
  }
  for (const r of await q(
    `SELECT i.relname, pg_get_indexdef(i.oid) AS def FROM pg_index x
       JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND ${own}`,
  )) {
    out.add(`index ${unqualify(r.def)}`);
  }
  for (const r of await q(
    `SELECT t.relname, co.conname, pg_get_constraintdef(co.oid) AS def FROM pg_constraint co
       JOIN pg_class t ON t.oid = co.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND ${own}`,
  )) {
    out.add(`constraint ${r.relname}.${r.conname} ${unqualify(r.def)}`);
  }
  for (const r of await q(
    `SELECT t.typname, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS labels
       FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = $1 GROUP BY t.typname`,
  )) {
    out.add(`enum ${r.typname} ${r.labels}`);
  }
  return out;
}

test(
  "the latest snapshot describes the database the numbered migrations build",
  { skip: needsDatabase() },
  async () => {
    const meta = join(DB, "src", "migrations", "meta");
    const latest = readdirSync(meta).filter((f) => /^\d{4}_snapshot\.json$/.test(f)).sort().at(-1)!;
    const snapshot = JSON.parse(readFileSync(join(meta, latest), "utf8"));
    const api = createRequire(join(DB, "package.json"))("drizzle-kit/api") as {
      generateMigration: (prev: unknown, cur: unknown) => Promise<string[]>;
    };
    const empty = {
      id: "00000000-0000-0000-0000-000000000000", prevId: "", version: "7", dialect: "postgresql",
      tables: {}, enums: {}, schemas: {}, sequences: {}, roles: {}, policies: {}, views: {},
      _meta: { schemas: {}, tables: {}, columns: {} },
    };
    // What drizzle-kit would run to create the snapshot's schema from nothing.
    const statements = await api.generateMigration(empty, snapshot);

    await withClient(async (c) => {
      await c.query("BEGIN");
      try {
        await c.query("CREATE SCHEMA drizzle_snapshot_check");
        await c.query("SET LOCAL search_path = drizzle_snapshot_check");
        for (const s of statements) await c.query(s.split('"public".').join('"drizzle_snapshot_check".'));
        // Neither schema on the path, so the catalog qualifies both alike.
        await c.query("SET LOCAL search_path = pg_catalog");
        const migrated = await catalog(c, "public");
        const described = await catalog(c, "drizzle_snapshot_check");
        const drift = (a: Set<string>, b: Set<string>) =>
          [...a].filter((x) => !b.has(x) && !KNOWN.some((k) => k.test(x))).sort();
        assert.ok(migrated.size > 500, `expected a migrated database, found ${migrated.size} catalog entries`);
        assert.deepEqual(
          { onlyInTheDatabase: drift(migrated, described), onlyInTheSnapshot: drift(described, migrated) },
          { onlyInTheDatabase: [], onlyInTheSnapshot: [] },
          `meta/${latest} must describe what the numbered migrations build. Declare database objects ` +
            "in the schema, and give a hand-written migration's objects drizzle's names, so the next " +
            "generated migration does not trip over them",
        );
      } finally {
        await c.query("ROLLBACK");
      }
    });
  },
);
