// Row-level security reaches tables created AFTER the lockdown first ran.
//
// ── THE DEFECT (F105) ────────────────────────────────────────────────────────
//
// _post/002 closes the Data API by looping over the public tables that exist
// when it runs -- revoking the API roles' grants and enabling RLS with no
// policies -- and migrate.ts records it by filename so it never runs again. On
// any database where it had already been applied, every table a LATER numbered
// migration created kept RLS off: on the live project that is jobs,
// rate_limits and quiz_attempts (0024, 0026, both after 002), and every table
// to come. Its second layer did nothing either: `REVOKE USAGE ON SCHEMA public
// FROM anon, authenticated` cannot bite while PUBLIC holds USAGE. So the only
// thing between the anon key and a new table was the table grants, and one
// dashboard click re-grants those.
//
// tests/behaviour/invariants.test.ts checks "every public table has RLS" on a
// database migrated from EMPTY, where 002 runs after every numbered migration
// and the defect cannot show. This one reproduces the live shape: the lockdown
// has already run, a new table appears, and the next deploy runs migrate.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DATABASE_URL, needsDatabase, tag, withClient, withRlsProbeLock } from "./_harness.js";

const here = fileURLToPath(import.meta.url);
const MIGRATE = resolve(here, "..", "..", "..", "packages/db/scripts/migrate.ts");
const TSX_LOADER = pathToFileURL(createRequire(here).resolve("tsx")).href;

/**
 * Run migrate.ts as deploy.sh's migrate container does. The cwd has no .env
 * and dotenv is pointed at a file that does not exist, so it can only dial the
 * database it is handed.
 */
function migrate(): Promise<{ code: number | null; out: string }> {
  const cwd = mkdtempSync(join(tmpdir(), "rls-deploy-"));
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, ["--import", TSX_LOADER, MIGRATE], {
      cwd,
      env: { ...process.env, DATABASE_URL: DATABASE_URL!, DOTENV_CONFIG_PATH: join(cwd, "no-such.env") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (out += String(d)));
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      rmSync(cwd, { recursive: true, force: true });
      done({ code, out });
    });
  });
}

test(
  "a table created after the Data API lockdown has run gets RLS on the next deploy",
  { skip: needsDatabase() },
  async () => {
    const table = `rls_probe_${tag("t").slice(-8).replace(/[^a-z0-9]/g, "")}`;
    // Exclusive: the probe table must not be seen by invariants.test.ts, and
    // this migrate run must not lock down another file's probe mid-check.
    await withRlsProbeLock("exclusive", () => withClient(async (c) => {
      const { rows: roles } = await c.query(`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'anon'`);
      const supabaseRoles = roles[0].n === 1;
      try {
        // As a later numbered migration would: a plain CREATE TABLE, no RLS.
        await c.query(`CREATE TABLE public.${table} (id int PRIMARY KEY, secret text)`);
        await c.query(`INSERT INTO public.${table} VALUES (1, 'a row nobody outside the app may read')`);
        // The dashboard click _post/002 guards against: the API role handed a
        // table grant. (Only where Supabase's roles exist; a plain Postgres has
        // no `anon`.)
        if (supabaseRoles) await c.query(`GRANT SELECT ON public.${table} TO anon`);

        const run = await migrate();
        assert.equal(run.code, 0, `migrate.ts must succeed on an already-migrated database:\n${run.out}`);

        // W3-40: what a migration changes is reported with RAISE NOTICE -- the
        // unlinked login links of 0033, the renumbered gates of 0034, and this
        // file's "enabled RLS on public.<table>". node-postgres hands a NOTICE
        // only to a 'notice' listener on the client, and migrate.ts attached
        // none, so every one of them was dropped and the deploy log said only
        // "ran _post/always/001". 0033 sets user_id to NULL, so its notice was
        // the only record of which login a record had belonged to.
        assert.match(
          run.out,
          new RegExp(`enabled RLS on public\\.${table}\\b`),
          `migrate.ts changed ${table} and the deploy log does not say so: the migrations' ` +
            `RAISE NOTICE reports never reach the operator.\n--- migrate output\n${run.out}`,
        );

        const { rows } = await c.query(
          `SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass($1)`,
          [`public.${table}`],
        );
        assert.equal(
          rows[0]?.relrowsecurity,
          true,
          `a table created after _post/002 ran must have RLS enabled by the next deploy; ` +
            `it has none, so a single re-granted privilege exposes it through PostgREST:\n${run.out}`,
        );

        if (supabaseRoles) {
          await c.query("BEGIN");
          try {
            await c.query("SET LOCAL ROLE anon");
            const read = await c
              .query(`SELECT count(*)::int AS n FROM public.${table}`)
              .then((r) => r.rows[0].n as number)
              .catch((err: { code?: string }) => {
                // No privilege at all is the other acceptable answer.
                assert.equal(err.code, "42501", `unexpected error reading as anon: ${String(err)}`);
                return 0;
              });
            assert.equal(read, 0, "the anon key must read nothing from a table created after the lockdown");
          } finally {
            await c.query("ROLLBACK");
          }
        }
      } finally {
        await c.query(`DROP TABLE IF EXISTS public.${table}`);
      }
    }));
  },
);

test(
  "FR-23: privileges a --no-acl restore drops come back on the next deploy",
  { skip: needsDatabase() },
  async () => {
    // backup.sh dumps --no-acl and the runbook restores --no-acl, so every
    // GRANT is gone after a DR restore -- and the _post files that made them
    // are in the restored ledger, so migrate never ran them again. GoTrue lost
    // EXECUTE on the access-token hook (no one could sign in) and authenticated
    // lost the private schema (every browser upload refused).
    await withRlsProbeLock("exclusive", () => withClient(async (c) => {
      const { rows } = await c.query(
        `SELECT to_regprocedure('public.custom_access_token_hook(jsonb)') IS NOT NULL AS hook,
                EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') AS gotrue`,
      );
      if (!rows[0].hook || !rows[0].gotrue) return; // not a Supabase database: nothing to grant
      const granted = async () =>
        (await c.query(`SELECT has_function_privilege('supabase_auth_admin', 'public.custom_access_token_hook(jsonb)', 'EXECUTE') AS ok`)).rows[0].ok;
      await c.query(`REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) FROM supabase_auth_admin`);
      try {
        assert.equal(await granted(), false, "precondition: the grant is gone, as after a --no-acl restore");
        const r = await migrate();
        assert.equal(r.code, 0, r.out);
        assert.equal(await granted(), true, "migrate must re-grant GoTrue EXECUTE on the hook");
      } finally {
        await c.query(`GRANT EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) TO supabase_auth_admin`);
      }
    }));
  },
);
