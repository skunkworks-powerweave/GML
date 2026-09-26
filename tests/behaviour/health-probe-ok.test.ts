// The other half of health-probe.test.ts, in its own process because the
// application's pool reads DATABASE_URL once: with a URL the application CAN
// use, the database probes report healthy.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { needsDatabase } from "./_harness.js";

test("the database probes pass when the application's connection works", { skip: needsDatabase() }, async () => {
  const { pingDb, pingMigrations } = await import("../../apps/web/src/lib/health.ts");
  assert.deepEqual(await pingDb(), { ok: true });
  const mig = await pingMigrations();
  assert.ok(mig.applied > 0, `the migrated test database must report its migrations: ${JSON.stringify(mig)}`);
});

// W3-50. pingMigrations found the journal by trying two paths built from
// process.cwd() and reading them with readFileSync at request time. Next's
// file tracer cannot resolve a cwd-relative read to one file, so it counted
// the whole of apps/web as reachable from /api/health and copied it -- src,
// READMEs, tsconfig.tsbuildinfo -- into .next/standalone, which
// docker/app.Dockerfile then had to delete again. And the count of migrations
// the build expects depended on where the process happened to be started. It
// is now part of the build: a static import of the journal.
test("the migrations probe knows the build's migrations whatever the working directory", { skip: needsDatabase() }, async () => {
  const { pingMigrations } = await import("../../apps/web/src/lib/health.ts");
  const journal = JSON.parse(
    readFileSync(fileURLToPath(new URL("../../packages/db/src/migrations/meta/_journal.json", import.meta.url)), "utf8"),
  ) as { entries: unknown[] };
  const cwd = process.cwd();
  const elsewhere = mkdtempSync(join(tmpdir(), "health-cwd-"));
  process.chdir(elsewhere);
  try {
    const mig = await pingMigrations();
    assert.equal(
      mig.expected,
      journal.entries.length,
      `started outside the repository and apps/web, the probe could not find the migrations the build ` +
        `carries: ${JSON.stringify(mig)}`,
    );
    assert.equal(mig.ok, true, JSON.stringify(mig));
  } finally {
    process.chdir(cwd);
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("FR-22: /api/health's Storage check requires every bucket the app writes, SCORM packages included", async () => {
  const { createServer } = await import("node:http");
  const { BUCKETS } = await import("../../packages/shared/src/storage/buckets.ts");
  let names: string[] = [];
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(names.map((name) => ({ name }))));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const saved = { url: process.env.NEXT_PUBLIC_SUPABASE_URL, key: process.env.SUPABASE_SECRET_KEY };
  process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.SUPABASE_SECRET_KEY = "test-secret";
  try {
    const { pingStorage } = await import("../../apps/web/src/lib/health.ts");
    names = ["videos-original", "videos-hls", "posters", "pdfs"];
    assert.deepEqual(await pingStorage(), { ok: false, detail: "missing buckets: scorm-packages" });
    names = Object.values(BUCKETS);
    assert.deepEqual(await pingStorage(), { ok: true });
  } finally {
    for (const [k, v] of [["NEXT_PUBLIC_SUPABASE_URL", saved.url], ["SUPABASE_SECRET_KEY", saved.key]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await new Promise((r) => server.close(r));
  }
});
