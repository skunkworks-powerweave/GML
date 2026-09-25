// The seed's two bootstraps, executed against a real Postgres.
//
// deploy.sh runs seed_all.ts on EVERY deploy, so whatever these functions do,
// they do again on each routine upgrade. Both defects below were invisible on a
// first deploy and only bit on the ones after it.
//
// ── SUPER ADMIN: A DEPLOY UNDID AN ADMINISTRATOR'S DECISION ──────────────────
//
// bootstrapSuperAdmin() found the SUPER_ADMIN_EMAIL auth user, logged
// "password left unchanged", and then ran
//
//     INSERT ... ON CONFLICT (id) DO UPDATE
//       SET role = 'super_admin', active = true, deleted_at = NULL
//
// unconditionally. An administrator who demoted, deactivated or offboarded that
// account (the founding admin leaves; the IT contractor hands over) found it an
// active super_admin again after the next deploy, with no audit row -- and a
// deactivation's GoTrue ban still in place, so profile and auth disagreed.
//
// ── HOW THESE TESTS RUN ──────────────────────────────────────────────────────
//
// Each test gets its own schema holding a copy of the tables the bootstrap
// writes, and a connection whose search_path resolves to it first, so the
// "is there already an active super_admin?" question is answered by this test's
// rows alone and not by whatever the rest of the suite left in public.users.
//
// auth.users is Supabase's; a plain Postgres (CI, the local test databases) has
// none. The bootstrap reads it by schema-qualified name, so a minimal stand-in
// (id, email) is created for the duration of a test when it is absent, and
// dropped afterwards. Nothing else in this repository reads auth.users.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { DATABASE_URL, needsDatabase, tag } from "./_harness.js";

const skip = needsDatabase();

// seed.ts begins `import "dotenv/config"`. Point it at a file that does not
// exist, so a .env in whatever checkout runs the suite can never contribute a
// real Supabase URL or key to the code under test.
process.env.DOTENV_CONFIG_PATH = join(mkdtempSync(join(tmpdir(), "seed-bootstrap-")), "no-such.env");

type SeedWorld = {
  schema: string;
  q<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]>;
  /** Run `fn` with a drizzle handle whose search_path resolves to this world. */
  withDb<T>(fn: (db: ReturnType<typeof drizzle>) => Promise<T>): Promise<T>;
};

async function withSeedWorld(tables: string[], body: (w: SeedWorld) => Promise<void>): Promise<void> {
  const schema = tag("seedw").replace(/-/g, "_");
  const admin = new pg.Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5000 });
  await admin.connect();
  const q = async <R,>(sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows as R[];

  const [{ ns, rel }] = await q<{ ns: string | null; rel: string | null }>(
    `SELECT to_regnamespace('auth')::text AS ns, to_regclass('auth.users')::text AS rel`,
  );
  if (!ns) await admin.query(`CREATE SCHEMA auth`);
  if (!rel) await admin.query(`CREATE TABLE auth.users (id uuid PRIMARY KEY, email text)`);

  await admin.query(`CREATE SCHEMA ${schema}`);
  for (const t of tables) {
    await admin.query(`CREATE TABLE ${schema}.${t} (LIKE public.${t} INCLUDING ALL)`);
  }
  const sep = DATABASE_URL!.includes("?") ? "&" : "?";
  const url = `${DATABASE_URL}${sep}options=${encodeURIComponent(`-c search_path=${schema},public`)}`;

  const withDb = async <T,>(fn: (db: ReturnType<typeof drizzle>) => Promise<T>): Promise<T> => {
    const pool = new pg.Pool({ connectionString: url, max: 2 });
    try {
      return await fn(drizzle(pool));
    } finally {
      await pool.end();
    }
  };

  try {
    await body({ schema, q, withDb });
  } finally {
    await admin.query(`DELETE FROM auth.users WHERE email LIKE $1`, [`${schema}%`]).catch(() => undefined);
    if (!rel) await admin.query(`DROP TABLE IF EXISTS auth.users`);
    if (!ns) await admin.query(`DROP SCHEMA IF EXISTS auth`);
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}

/** Capture console.log/console.error while `fn` runs. */
async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string }> {
  const lines: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    const result = await fn();
    return { result, logs: lines.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

/** Env for the bootstrap; the Supabase endpoint dials nothing. */
function superAdminEnv(email: string) {
  process.env.SUPER_ADMIN_EMAIL = email;
  process.env.SUPER_ADMIN_INITIAL_PASSWORD = "only-used-when-an-account-is-created";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:9";
  process.env.SUPABASE_SECRET_KEY = "test-dummy";
}

type Profile = { role: string; active: boolean; deleted: boolean };

// ── The super admin bootstrap ────────────────────────────────────────────────

test(
  "a deploy leaves a demoted, deactivated or offboarded SUPER_ADMIN_EMAIL account exactly as an administrator left it",
  { skip },
  async () => {
    const { bootstrapSuperAdmin } = await import("../../packages/db/src/scripts/seed.ts");
    await withSeedWorld(["users"], async (w) => {
      const account = async (label: string, role: string, active: boolean, deleted: boolean) => {
        const id = randomUUID();
        const email = `${w.schema}.${label}@example.invalid`;
        await w.q(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [id, email]);
        await w.q(
          `INSERT INTO ${w.schema}.users (id, email, name, role, active, deleted_at)
             VALUES ($1, $2, $3, $4, $5, CASE WHEN $6 THEN now() END)`,
          [id, email, label, role, active, deleted],
        );
        return { id, email };
      };
      const profile = async (id: string): Promise<Profile> =>
        (
          await w.q<Profile>(
            `SELECT role::text AS role, active, deleted_at IS NOT NULL AS deleted FROM ${w.schema}.users WHERE id = $1`,
            [id],
          )
        )[0]!;

      // The administrator who did the demoting. The org is not stranded: this
      // is the state /admin/users' last-super-admin guard always leaves behind.
      await account("current-admin", "super_admin", true, false);

      const cases: Array<[string, Awaited<ReturnType<typeof account>>, Profile]> = [
        ["demoted", await account("demoted", "programme_admin", true, false), { role: "programme_admin", active: true, deleted: false }],
        ["deactivated", await account("deactivated", "super_admin", false, false), { role: "super_admin", active: false, deleted: false }],
        ["offboarded", await account("offboarded", "teacher", false, true), { role: "teacher", active: false, deleted: true }],
      ];

      for (const [label, acct, before] of cases) {
        superAdminEnv(acct.email);
        const { logs } = await captureLogs(() => w.withDb((db) => bootstrapSuperAdmin(db)));
        assert.deepEqual(
          await profile(acct.id),
          before,
          `the next deploy re-promoted the ${label} SUPER_ADMIN_EMAIL account. The seed runs on every ` +
            `deploy; once an active super_admin exists, an existing profile is an administrator's ` +
            `decision, not a state to repair.\n--- seed output\n${logs}`,
        );
        assert.match(
          logs,
          /active super_admin already exists/i,
          `the operator must be told why SUPER_ADMIN_* did nothing:\n${logs}`,
        );
      }
    });
  },
);

test(
  "with no active super_admin yet, the bootstrap still promotes the SUPER_ADMIN_EMAIL account",
  { skip },
  async () => {
    // The first deploy -- or a re-run after one that created the auth user and
    // then failed before promoting it: the trigger has written the profile as
    // an INACTIVE teacher, and nobody can administer anything until this runs.
    const { bootstrapSuperAdmin } = await import("../../packages/db/src/scripts/seed.ts");
    await withSeedWorld(["users"], async (w) => {
      const id = randomUUID();
      const email = `${w.schema}.founder@example.invalid`;
      await w.q(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [id, email]);
      await w.q(`INSERT INTO ${w.schema}.users (id, email, role, active) VALUES ($1, $2, 'teacher', false)`, [id, email]);

      superAdminEnv(email);
      const { logs } = await captureLogs(() => w.withDb((db) => bootstrapSuperAdmin(db)));

      const [row] = await w.q<Profile>(
        `SELECT role::text AS role, active, deleted_at IS NOT NULL AS deleted FROM ${w.schema}.users WHERE id = $1`,
        [id],
      );
      assert.deepEqual(
        row,
        { role: "super_admin", active: true, deleted: false },
        `a fresh system must still get its first administrator:\n${logs}`,
      );
    });
  },
);
