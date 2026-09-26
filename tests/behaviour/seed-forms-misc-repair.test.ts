// seed_forms_misc.ts on a database that already has its two forms, executed
// as deploy.sh runs it: in a child process, against a real Postgres.
//
// ── F106 ─────────────────────────────────────────────────────────────────────
//
// The seed's "repair-on-drift" rewrote the School visit checklist and the
// Endline survey back to the seeded schema whenever the stored one differed
// and the form had no responses -- exactly the window in which a programme
// customises a form -- and deploy.sh runs it on every deploy, so an
// administrator's edit vanished at the next one. Its "already current" test
// compared JSON.stringify of the jsonb value (whose object keys Postgres
// reorders) with the JS literal, which never matched: it rewrote both rows on
// every run, on an untouched database too ("repaired=2").

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DATABASE_URL, needsDatabase, withClient } from "./_harness.js";

const skip = needsDatabase();
const here = fileURLToPath(import.meta.url);
const SEED = resolve(here, "..", "..", "..", "packages/db/src/scripts/seed_forms_misc.ts");
const TSX_LOADER = pathToFileURL(createRequire(here).resolve("tsx")).href;

/** Run the seed as an operator does, with no .env to fall back on. */
function runSeed(): Promise<{ code: number | null; out: string }> {
  const cwd = mkdtempSync(join(tmpdir(), "seed-misc-"));
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, ["--import", TSX_LOADER, SEED], {
      cwd,
      env: { ...process.env, DATABASE_URL, DOTENV_CONFIG_PATH: join(cwd, "no-such.env"), SEED_DRY_RUN: "false" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (out += String(d)));
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      rmSync(cwd, { recursive: true, force: true });
      done({ code, out });
    });
  });
}

const MISC = `(kind = 'baseline' AND audience = 'mentor' AND version = 'schoolvisit-1')
            OR (kind = 'final' AND audience = 'mentee' AND version = 'endline-1')`;

test("a second seed run changes nothing, and an administrator's edit survives the next deploy", { skip }, async () => {
  await withClient(async (c) => {
    const before = (await c.query(`SELECT id, schema FROM feedback_forms WHERE ${MISC}`)).rows as Array<{ id: string; schema: unknown }>;
    try {
      const first = await runSeed();
      assert.equal(first.code, 0, first.out);

      const second = await runSeed();
      assert.equal(second.code, 0, second.out);
      assert.match(second.out, /inserted=0, repaired=0/, `an untouched database must not be rewritten:\n${second.out}`);
      // And recognised as CURRENT, not merely spared: the jsonb value (keys
      // reordered by Postgres) must compare equal to what the seed writes.
      assert.equal((second.out.match(/SKIP\s+.*already present and current/g) ?? []).length, 2, second.out);

      await c.query(
        `UPDATE feedback_forms SET schema = jsonb_set(schema, '{title}', '"Customised school visit checklist"')
          WHERE kind = 'baseline' AND audience = 'mentor' AND version = 'schoolvisit-1'`,
      );
      const third = await runSeed();
      assert.equal(third.code, 0, third.out);
      const [{ title }] = (
        await c.query(`SELECT schema->>'title' AS title FROM feedback_forms WHERE kind = 'baseline' AND audience = 'mentor' AND version = 'schoolvisit-1'`)
      ).rows;
      assert.equal(title, "Customised school visit checklist", `an administrator's edit was overwritten:\n${third.out}`);
    } finally {
      // Put the two rows back exactly as they were: delete them if this test
      // created them, restore their schema otherwise.
      if (before.length === 0) {
        await c.query(`DELETE FROM feedback_forms f WHERE (${MISC}) AND NOT EXISTS (SELECT 1 FROM feedback_responses r WHERE r.form_id = f.id)`);
      } else {
        for (const b of before) await c.query(`UPDATE feedback_forms SET schema = $2::jsonb WHERE id = $1`, [b.id, JSON.stringify(b.schema)]);
      }
    }
  });
});

test("a stored schema of the shape the seed once shipped broken is still repaired", { skip }, async () => {
  await withClient(async (c) => {
    const before = (await c.query(`SELECT id, schema FROM feedback_forms WHERE ${MISC}`)).rows as Array<{ id: string; schema: unknown }>;
    try {
      assert.equal((await runSeed()).code, 0);
      // The original defect: fields keyed {id, kind} with the seed's own
      // vocabulary, which no renderer draws.
      await c.query(
        `UPDATE feedback_forms SET schema = '{"title":"School visit checklist","fields":[{"id":"x","kind":"boolean-group"}]}'::jsonb
          WHERE kind = 'baseline' AND audience = 'mentor' AND version = 'schoolvisit-1'`,
      );
      const run = await runSeed();
      assert.match(run.out, /REPAIR\s+school-visit checklist/, run.out);
      const [{ n }] = (
        await c.query(`SELECT jsonb_array_length(schema->'fields') AS n FROM feedback_forms WHERE kind = 'baseline' AND audience = 'mentor' AND version = 'schoolvisit-1'`)
      ).rows;
      assert.ok(Number(n) > 1);
    } finally {
      if (before.length === 0) {
        await c.query(`DELETE FROM feedback_forms f WHERE (${MISC}) AND NOT EXISTS (SELECT 1 FROM feedback_responses r WHERE r.form_id = f.id)`);
      } else {
        for (const b of before) await c.query(`UPDATE feedback_forms SET schema = $2::jsonb WHERE id = $1`, [b.id, JSON.stringify(b.schema)]);
      }
    }
  });
});

// F106 (review): the route that saves an administrator's edit and the seed
// that decides whether to "repair" it disagreed about which field kinds exist.
// lib/forms/schema.ts accepted "scale", which neither renderer draws, and the
// seed's canonical list did not -- so an edit the route had accepted counted
// as broken, and the next deploy overwrote it on an unanswered form.
test("an edit the admin route accepts, using every field kind it accepts, survives the next deploy", { skip }, async () => {
  const { FIELD_KINDS, FormSchemaSchema } = await import("../../apps/web/src/lib/forms/schema.ts");
  // The renderers draw one control per option for these, so they carry some.
  const withOptions = new Set(["select", "radio", "checkbox"]);
  const edited = {
    title: "School visit checklist (customised)",
    purpose: "schoolvisit",
    fields: FIELD_KINDS.map((kind, i) => ({
      name: `q${i}`,
      kind,
      label: `A ${kind} question`,
      ...(withOptions.has(kind) ? { options: ["Yes", "No"] } : {}),
    })),
  };
  assert.ok(FormSchemaSchema.safeParse(edited).success, "PUT /api/admin/forms/[id] accepts this schema");

  await withClient(async (c) => {
    const before = (await c.query(`SELECT id, schema FROM feedback_forms WHERE ${MISC}`)).rows as Array<{ id: string; schema: unknown }>;
    try {
      assert.equal((await runSeed()).code, 0);
      await c.query(
        `UPDATE feedback_forms SET schema = $1::jsonb WHERE kind = 'baseline' AND audience = 'mentor' AND version = 'schoolvisit-1'`,
        [JSON.stringify(edited)],
      );
      const run = await runSeed();
      assert.equal(run.code, 0, run.out);
      const [{ schema }] = (
        await c.query(`SELECT schema FROM feedback_forms WHERE kind = 'baseline' AND audience = 'mentor' AND version = 'schoolvisit-1'`)
      ).rows as Array<{ schema: { title?: string; fields?: Array<{ kind: string }> } }>;
      assert.equal(schema.title, edited.title, `the accepted edit was overwritten:\n${run.out}`);
      assert.deepEqual(schema.fields?.map((f) => f.kind), [...FIELD_KINDS]);
    } finally {
      if (before.length === 0) {
        await c.query(`DELETE FROM feedback_forms f WHERE (${MISC}) AND NOT EXISTS (SELECT 1 FROM feedback_responses r WHERE r.form_id = f.id)`);
      } else {
        for (const b of before) await c.query(`UPDATE feedback_forms SET schema = $2::jsonb WHERE id = $1`, [b.id, JSON.stringify(b.schema)]);
      }
    }
  });
});
