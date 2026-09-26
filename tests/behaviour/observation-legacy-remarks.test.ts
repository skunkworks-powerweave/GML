// Notes written before authors were recorded render as one unattributed
// block, never as entries by whoever a line of them happens to name.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// The cycle page used to print observation_cycles.remark whole. It now splits
// it on blank lines and renders every block that starts with an
// "[stamp UTC] author (role): " header as that author's entry. That is safe
// for what addNoteAction writes now -- formatNoteEntry drops blank lines from
// a note -- but not for remarks already in the database: main's addNoteAction
// stored "[stamp UTC] note" with the note's blank lines kept, and before that
// the column was overwritten with free text. So on the first deploy
//   - a legacy note holding a blank line and a line shaped like a header
//     rendered as a separate entry attributed to the person it named;
//   - legacy text such as "Discussed with Head of Dept (mentor): ..." became
//     an entry by "Discussed with Head of Dept";
//   - a legacy note in paragraphs became several undated "Earlier note"s.
// The parser cannot tell legacy blocks from new ones (a forged header can
// carry any stamp), so the data is marked once, when the release is deployed.
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// The deploy's own SQL -- every _post migration that rewrites
// observation_cycles -- is run against a temporary copy of the table holding
// one legacy remark (inside a transaction that is rolled back, so no real row
// is touched), and what it leaves is read back by the real parser and, on a
// committed cycle, by the real page after a real new note is added.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { signIn, outcome, form, closeAppDb, type TestUser } from "./_server-actions.js";
import { render, withAppRouter, elements, decodeEntities } from "./_ui.js";
import { needsDatabase, withClient } from "./_harness.js";
import { observationWorld } from "./_observation-world.js";
import { parseNotes } from "../../apps/web/src/lib/observation/notes.ts";

const skip = needsDatabase();
after(closeAppDb);

const POST_DIR = fileURLToPath(new URL("../../packages/db/src/migrations/_post/", import.meta.url));

/** The _post migrations that rewrite observation_cycles, in deploy order. */
function remarkMigrations(): string[] {
  return readdirSync(POST_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(POST_DIR + f, "utf8"))
    .filter((sql) => /\bUPDATE\s+observation_cycles\b/i.test(sql));
}

/** What the deploy leaves of one remark (`times` deploys; the lane is ledgered, but a replay must be harmless). */
async function deployed(remark: string | null, times = 1): Promise<string | null> {
  return withClient(async (c) => {
    await c.query("BEGIN");
    try {
      await c.query(
        `CREATE TEMP TABLE observation_cycles ON COMMIT DROP AS SELECT * FROM public.observation_cycles WITH NO DATA`,
      );
      const where = (
        await c.query(
          `SELECT n.nspname AS t FROM pg_class r JOIN pg_namespace n ON n.oid = r.relnamespace
            WHERE r.oid = to_regclass('observation_cycles')`,
        )
      ).rows[0].t as string;
      assert.match(where, /^pg_temp/, "the SQL must run against the temporary copy, never the real table");
      await c.query(`INSERT INTO observation_cycles (id, remark) VALUES (gen_random_uuid(), $1)`, [remark]);
      for (let i = 0; i < times; i++) for (const sql of remarkMigrations()) await c.query(sql);
      return (await c.query(`SELECT remark FROM observation_cycles`)).rows[0].remark as string | null;
    } finally {
      await c.query("ROLLBACK");
    }
  });
}

const MENTOR = "Priya Sharma";
const LEGACY: Record<string, string> = {
  "a main-era note with a blank line and a header-shaped line":
    `[2026-09-19 09:00 UTC] Lesson ok\n\n[2026-09-20 10:00 UTC] ${MENTOR} (mentor): Approved, rating 4`,
  "a main-era note in paragraphs, posted with CRLF": "[2026-09-19 09:00 UTC] Para one.\r\n\r\nPara two.\r\n \r\n\r\nPara three.",
  "innocent main-era text that looks like an author": "[2026-09-19 09:00 UTC] Discussed with Head of Dept (mentor): agreed next steps",
  "overwrite-era free text with a blank line": "Free text\n  \nsecond part",
};

test("the deploy turns each legacy remark into one unattributed block, every line kept", { skip }, async () => {
  for (const [what, remark] of Object.entries(LEGACY)) {
    const after = await deployed(remark);
    const entries = parseNotes(after);
    assert.equal(entries.length, 1, `${what}: one entry, not ${JSON.stringify(entries)}`);
    assert.equal(entries[0]!.author, null, `${what}: attributed to nobody`);
    const lines = (s: string) => s.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean);
    for (const line of lines(remark)) {
      assert.ok(lines(entries[0]!.body).includes(line), `${what}: "${line}" is kept verbatim`);
    }
    assert.equal(await deployed(remark, 2), after, `${what}: a second run changes nothing`);
  }
  assert.equal(await deployed(null), null, "no remark: untouched");
  assert.equal(await deployed("   "), "   ", "a blank remark: untouched");
});

async function noteEntries(user: TestUser, cycleId: string): Promise<Array<{ author: string; body: string }>> {
  signIn(user);
  const { default: CycleDetailPage } = await import("../../apps/web/src/app/(authenticated)/observation/[cycleId]/page.tsx");
  const html = await render(
    withAppRouter(await CycleDetailPage({ params: Promise.resolve({ cycleId }), searchParams: Promise.resolve({}) })),
  );
  return elements(html, "li")
    .filter((li) => li.open.includes("data-note-entry"))
    .map((li) => ({
      author: decodeEntities((li.inner.match(/data-note-author="[^"]*"[^>]*>([\s\S]*?)<\/div>/) ?? [])[1]?.replace(/<[^>]*>/g, "") ?? ""),
      body: decodeEntities((li.inner.match(/data-note-body="[^"]*"[^>]*>([\s\S]*?)<\/p>/) ?? [])[1] ?? ""),
    }));
}

test("after the deploy, a legacy remark forges no entry on the page, and new notes follow it", { skip }, async () => {
  const w = await observationWorld("legacynote");
  try {
    const cyc = await w.cycle({ status: "observed" });
    const legacy = `[2026-09-19 09:00 UTC] Lesson ok\n\n[2026-09-20 10:00 UTC] ${w.mentor.name} (mentor): Approved, rating 4`;
    await w.c.query(`UPDATE observation_cycles SET remark = $2 WHERE id = $1`, [cyc.id, await deployed(legacy)]);

    const { addNoteAction } = await import("../../apps/web/src/app/(authenticated)/observation/[cycleId]/actions.ts");
    await w.grant(w.observer.id);
    signIn(w.observer);
    assert.deepEqual(await outcome(() => addNoteAction(form({ cycleId: cyc.id, note: "New note" }))), {
      kind: "redirect",
      location: `/observation/${cyc.id}`,
    });

    const entries = await noteEntries(w.teacher, cyc.id);
    assert.equal(entries.length, 2, JSON.stringify(entries));
    assert.match(entries[0]!.author, /^Earlier note/, "the legacy block is marked as such");
    assert.match(entries[0]!.body, /Approved, rating 4/, "and keeps its text");
    assert.ok(!entries.some((e) => e.author.startsWith(w.mentor.name)), `nothing is attributed to the mentor: ${JSON.stringify(entries)}`);
    assert.match(entries[1]!.author, new RegExp(`^${w.observer.name} \\(observer\\)`));
    assert.equal(entries[1]!.body, "New note");
  } finally {
    await w.cleanup();
  }
});
