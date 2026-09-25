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
// ── SECTION GATES: A PASSWORD NOBODY COULD TYPE ──────────────────────────────
//
// See the gate test below: an unset GATE_PASSWORD_* reached the seed as "" and
// every gate was hashed from the empty string.
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
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { DATABASE_URL, needsDatabase, tag } from "./_harness.js";

const skip = needsDatabase();

/** The bcrypt the seed itself hashes with (a dependency of @gml/db, not of the root). */
const BCRYPT = pathToFileURL(
  createRequire(new URL("../../packages/db/package.json", import.meta.url)).resolve("bcryptjs"),
).href;

// seed.ts begins `import "dotenv/config"`. Point it at a file that does not
// exist, so a .env in whatever checkout runs the suite can never contribute a
// real Supabase URL or key to the code under test.
process.env.DOTENV_CONFIG_PATH = join(mkdtempSync(join(tmpdir(), "seed-bootstrap-")), "no-such.env");

type SeedWorld = {
  schema: string;
  /** A DATABASE_URL whose search_path resolves to this world first. */
  url: string;
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
    await body({ schema, url, q, withDb });
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

// ── Section gates ────────────────────────────────────────────────────────────
//
// .env.example ships GATE_PASSWORD_* commented out: the documented default is
// "the seed generates each password and prints it once". docker-compose.yml
// forwards them to the migrate service as `${GATE_PASSWORD_X:-}`, which hands
// the container an EMPTY STRING rather than leaving the variable unset -- and
// the seed chose `fromEnv ?? random`. `??` falls back only on null/undefined,
// so every gate was created as bcrypt("") and the log read
// "GENERATED PASSWORD: " with nothing after it. The gate form refuses an empty
// submission (`required`, and "Enter a password." in the action), so the one
// password that matched could never be entered: observation, mentorship and the
// audit log were locked for everyone, and redeploying could not repair it,
// because an existing gate is skipped.

test(
  "a GATE_PASSWORD_* that compose forwards as empty gets a generated password, printed once",
  { skip },
  async () => {
    const { bootstrapSectionGates } = await import("../../packages/db/src/scripts/seed.ts");
    const bcrypt = (await import(BCRYPT)).default as { compare(p: string, h: string): Promise<boolean> };
    await withSeedWorld(["section_gates"], async (w) => {
      // What `${GATE_PASSWORD_X:-}` gives the container for a key .env lacks;
      // then a value that is only whitespace; then one IT chose.
      process.env.GATE_PASSWORD_OBSERVATION = "";
      process.env.GATE_PASSWORD_MENTORSHIP = "   ";
      process.env.GATE_PASSWORD_ADMIN = "chosen-by-it-4821";
      const { logs } = await captureLogs(() => w.withDb((db) => bootstrapSectionGates(db)));

      const rows = await w.q<{ slug: string; password_hash: string }>(
        `SELECT slug, password_hash FROM ${w.schema}.section_gates`,
      );
      const hash = (slug: string) => rows.find((r) => r.slug === slug)?.password_hash ?? "";

      for (const slug of ["observation", "mentorship"]) {
        const printed = logs.match(new RegExp(`section gate '${slug}' created — GENERATED PASSWORD: (\\S*)`))?.[1] ?? "";
        assert.ok(
          printed.length >= 12,
          `the '${slug}' gate must get a generated password, printed for the operator -- not the ` +
            `empty string compose forwarded:\n${logs}`,
        );
        assert.equal(await bcrypt.compare(printed, hash(slug)), true, `the printed '${slug}' password must be the stored one`);
        assert.equal(
          await bcrypt.compare("", hash(slug)),
          false,
          `the '${slug}' gate was hashed from an empty password, which the gate form can never submit`,
        );
      }
      assert.equal(await bcrypt.compare("chosen-by-it-4821", hash("admin")), true, "a real GATE_PASSWORD_ADMIN is still used");
      assert.doesNotMatch(logs, /GENERATED PASSWORD: \s*$/m, `no blank password may be printed:\n${logs}`);
    });
  },
);

// ── verify-auth: a deploy that leaves nobody able to sign in must not pass ───
//
// SUPER_ADMIN_* are not REQUIRED in .env, and with them empty the seed logs
// "super_admin bootstrap skipped" and succeeds. deploy.sh then ran
// verify-auth -- which never asked whether anyone could administer the system
// -- wrote the marker that arms the SM-5 restore-drill gate, and printed
// "done. Sign in at ...". No account existed at all (the super admin is the
// only one the seed creates), the next step in the runbook -- backup.sh &&
// restore.sh -- failed with "no users restored", and the armed gate then
// refused the very re-deploy that would have created the administrator.
//
// verify-auth runs as deploy.sh runs it, against a scratch schema whose `users`
// holds exactly what each test puts there. It is read only up to its schema
// checks: past them it calls Supabase, which here is an address nothing
// listens on.

const VERIFY_AUTH = fileURLToPath(new URL("../../packages/db/scripts/verify-auth.mjs", import.meta.url));
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

/** verify-auth.mjs as deploy.sh runs it (through tsx), against a world. */
function verifyAuthIn(w: SeedWorld): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), "verify-auth-"));
  return new Promise((done, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", TSX_LOADER, VERIFY_AUTH],
      {
        cwd,
        env: {
          ...process.env,
          DATABASE_URL: w.url,
          NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:9",
          NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "test-dummy",
          SUPABASE_SECRET_KEY: "test-dummy",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (out += String(d)));
    const timer = setTimeout(() => child.kill(), 90_000);
    child.on("error", reject);
    child.on("close", () => {
      clearTimeout(timer);
      rmSync(cwd, { recursive: true, force: true });
      done(out);
    });
  });
}

test("verify-auth FAILS a deploy that leaves no active super_admin", { skip }, async () => {
  await withSeedWorld(["users"], async (w) => {
    // What a first deploy with SUPER_ADMIN_* empty leaves: nobody, or at most
    // accounts that cannot administer anything.
    await w.q(
      `INSERT INTO ${w.schema}.users (id, email, role, active) VALUES
         (gen_random_uuid(), $1, 'teacher', false),
         (gen_random_uuid(), $2, 'super_admin', false)`,
      [`${w.schema}.inert@example.invalid`, `${w.schema}.deactivated@example.invalid`],
    );
    const out = await verifyAuthIn(w);
    assert.match(
      out,
      /FAIL\s+an active super_admin exists/,
      "verify-auth passed a system nobody can administer; deploy.sh then marks the host deployed and " +
        `arms a restore drill that can never pass.\n--- verify-auth\n${out.slice(0, 3000)}`,
    );
  });
});

test("verify-auth passes the check once an active super_admin exists", { skip }, async () => {
  await withSeedWorld(["users"], async (w) => {
    await w.q(`INSERT INTO ${w.schema}.users (id, email, role, active) VALUES (gen_random_uuid(), $1, 'super_admin', true)`, [
      `${w.schema}.admin@example.invalid`,
    ]);
    const out = await verifyAuthIn(w);
    assert.match(out, /PASS\s+an active super_admin exists/, `--- verify-auth\n${out.slice(0, 3000)}`);
  });
});
