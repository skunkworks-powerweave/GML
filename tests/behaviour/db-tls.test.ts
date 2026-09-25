// Every connection the deploy and the worker open asks for TLS, the way
// packages/db/src/client.ts does.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// client.ts forces TLS because the documented DATABASE_URL (a Supabase pooler
// URI) carries no sslmode, and node-postgres sends no SSLRequest unless asked --
// its own comment records that this once ran PLAINTEXT across the internet to
// the pooler. That fix reached getPool() only. Everything else built a bare
// `new Pool/Client({ connectionString })`:
//
//   migrate.ts                 every DDL and _post SQL, as the owner role, on
//                              every deploy
//   seed.ts + four form seeds  read auth.users and write the gate bcrypt hashes,
//                              on every deploy (seed_all.ts awaits each main())
//   verify-auth.mjs            on every deploy
//   deleteOldNotifications()   the worker's retention job
//   the worker's healthcheck   every 60 s (docker-compose.yml)
//
// So those sessions were readable and injectable by anyone on the path, and the
// CA mounted into the migrate container was never read. And once Supabase's
// "Enforce SSL" is switched on, migrate cannot connect at all -- so app and
// worker, which wait for it, never start.
//
// ── HOW THIS OBSERVES IT ─────────────────────────────────────────────────────
//
// _fake_pg.ts answers an SSLRequest with 'N' ("this server has no TLS") and
// counts them. A client configured by client.ts sends one and then refuses to
// go on ("The server does not support SSL connections"); a bare client never
// asks. Each entry point is run the way production runs it, against its own
// fake, with a URL that has no sslmode -- the documented shape -- and must have
// asked. None needs a database: the question is settled before the first query.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startFakePg } from "./_fake_pg.js";

const here = fileURLToPath(import.meta.url);
const root = resolve(here, "..", "..", "..");
const TSX_LOADER = pathToFileURL(createRequire(here).resolve("tsx")).href;
const src = (rel: string) => pathToFileURL(resolve(root, rel)).href;

type Run = { code: number | null; out: string };

/**
 * Run node in a scratch cwd with an environment built for this check: the
 * fake's URL, dummy Supabase settings that dial nothing, and none of the
 * variables that could make a bare client ask for TLS by itself (PGSSLMODE) or
 * change what client.ts does (a CA).
 */
function runNode(args: string[], databaseUrl: string, cwd?: string): Promise<Run> {
  const scratch = mkdtempSync(join(tmpdir(), "db-tls-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    DOTENV_CONFIG_PATH: join(scratch, "no-such.env"),
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:9",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "test-dummy",
    SUPABASE_SECRET_KEY: "test-dummy",
  };
  for (const k of ["PGSSLMODE", "PGSSLROOTCERT", "SUPABASE_CA_CERT", "SUPER_ADMIN_EMAIL", "SEED_DRY_RUN", "DRY_RUN"]) {
    delete env[k];
  }
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, args, { cwd: cwd ?? scratch, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (out += String(d)));
    const timer = setTimeout(() => child.kill(), 90_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      rmSync(scratch, { recursive: true, force: true });
      done({ code, out });
    });
  });
}

/** Import a module and await one of its exports, as its production caller does. */
const callExport = (rel: string, fn: string) => [
  "--import",
  TSX_LOADER,
  "--input-type=module",
  "-e",
  `const m = await import(${JSON.stringify(src(rel))});` +
    `try { await m.${fn}(); } catch (e) { console.error(String(e)); process.exitCode = 1; }`,
];

async function assertAsksForTls(label: string, args: (url: string) => string[], cwd?: string) {
  const pg = await startFakePg();
  try {
    const run = await runNode(args(pg.url), pg.url, cwd);
    assert.ok(
      pg.sslRequests > 0,
      `${label} opened its database connection without asking for TLS. With the documented ` +
        `DATABASE_URL (no sslmode) that session is plaintext to the Supabase pooler, and it cannot ` +
        `connect at all once "Enforce SSL" is on. Build it from @gml/db's client.ts config.\n` +
        `statements it sent in the clear: ${pg.queries.length}\n--- output\n${run.out.slice(0, 3000)}`,
    );
  } finally {
    await pg.close();
  }
}

test("migrate.ts asks for TLS", async () => {
  await assertAsksForTls("packages/db/scripts/migrate.ts", () => [
    "--import",
    TSX_LOADER,
    resolve(root, "packages/db/scripts/migrate.ts"),
  ]);
});

for (const seed of ["seed", "seed_forms_mentor", "seed_forms_mentee", "seed_forms_observation", "seed_forms_misc"]) {
  test(`${seed}.ts main() asks for TLS (seed_all.ts runs it on every deploy)`, async () => {
    await assertAsksForTls(`packages/db/src/scripts/${seed}.ts`, () =>
      callExport(`packages/db/src/scripts/${seed}.ts`, "main"),
    );
  });
}

test("the retention job's deleteOldNotifications() asks for TLS", async () => {
  await assertAsksForTls("deleteOldNotifications()", () =>
    callExport("packages/db/src/scripts/retention.ts", "deleteOldNotifications"),
  );
});

test("verify-auth.mjs asks for TLS, run the way deploy.sh runs it", async () => {
  await assertAsksForTls("packages/db/scripts/verify-auth.mjs", () => [
    "--import",
    TSX_LOADER,
    resolve(root, "packages/db/scripts/verify-auth.mjs"),
  ]);
  // deploy.sh runs it in the migrate image through tsx -- which is what lets a
  // .mjs import client.ts at all -- so the run above is the deploy's run.
  assert.match(
    readFileSync(resolve(root, "scripts/deploy.sh"), "utf8"),
    /migrate pnpm exec tsx scripts\/verify-auth\.mjs/,
    "deploy.sh must run verify-auth.mjs through tsx, as this test does",
  );
});

test("the worker's compose healthcheck asks for TLS", async () => {
  // The command exactly as docker-compose.yml gives it, run from the worker
  // image's WORKDIR (apps/worker), where its imports resolve the same way.
  const compose = readFileSync(resolve(root, "docker-compose.yml"), "utf8");
  const worker = compose.slice(compose.indexOf("\n  worker:"), compose.indexOf("\n  caddy:"));
  const block = worker.match(/healthcheck:[\s\S]*?test:\s*\n((?:\s+- .*\n)+)/);
  assert.ok(block, "could not find the worker's healthcheck test list in docker-compose.yml");
  const argv = [...block[1]!.matchAll(/^\s+- (.*)$/gm)].map(([, v]) => {
    const t = v!.trim();
    return t.startsWith('"') ? (JSON.parse(t) as string) : t;
  });
  assert.equal(argv[0], "CMD");
  assert.equal(argv[1], "node", `expected a node healthcheck, got: ${argv.join(" ")}`);
  await assertAsksForTls("the worker healthcheck", () => argv.slice(2), resolve(root, "apps/worker"));
});
