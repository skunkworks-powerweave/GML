// /repo/teachers and /repo/schools count sessions for the rows they list, not
// for the whole session log.
//
// ── THE DEFECT (F143 remainder) ──────────────────────────────────────────────
//
// Both pages LEFT JOINed a derived table that GROUPed the entire sessions
// table by teacher (or by school; /repo/schools did the same over teachers and
// classes). Postgres cannot push the join condition into a GROUP BY derived
// table, so every load aggregated every session ever logged -- even
// /repo/teachers?school=<one school>, or /repo/schools?q=<one name>. At the
// projected 350k sessions that was ~130 ms a load against ~1 ms for counting
// only the listed rows, and it grows with the log.
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// The real pages are rendered (the counts they show must still be right) with
// the app's pool watched, so the SQL checked is the SQL the pages ran. Each
// query that reads sessions is then EXPLAINed, as sessions-indexes.test.ts
// does, against a log of 2,000 sessions (ANALYZEd, rolled back) with
// sequential scans off: every read of sessions must carry an index condition
// on the listed teacher or school, not walk the whole table.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { Client } from "pg";
import { signIn, closeAppDb } from "./_server-actions.js";
import { render, withAppRouter } from "./_ui.js";
import { connect, needsDatabase, tag, withClient } from "./_harness.js";

const skip = needsDatabase();
after(closeAppDb);

type PlanNode = {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Cond"?: string;
  "Recheck Cond"?: string;
  Plans?: PlanNode[];
};
const nodes = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(nodes)];

type Recorded = { text: string; values: unknown[] };
type Queryable = { query: (...args: unknown[]) => unknown };

/** Every query the app's pool runs while `body` does. */
async function watchAppQueries(body: () => Promise<void>): Promise<Recorded[]> {
  const webRequire = createRequire(new URL("../../apps/web/package.json", import.meta.url));
  const pools = new Set<Queryable>([
    (webRequire("@gml/db") as { getPool: () => Queryable }).getPool(),
    (await import("../../packages/db/src/client.ts")).getPool() as unknown as Queryable,
  ]);
  const seen: Recorded[] = [];
  const restore: Array<() => void> = [];
  for (const pool of pools) {
    const original = pool.query;
    pool.query = function (this: unknown, ...args: unknown[]) {
      const [q, v] = args as [string | { text: string; values?: unknown[] }, unknown[] | undefined];
      seen.push(typeof q === "string" ? { text: q, values: v ?? [] } : { text: q.text, values: v ?? q.values ?? [] });
      return original.apply(this, args);
    };
    restore.push(() => (pool.query = original));
  }
  try {
    await body();
  } finally {
    for (const r of restore) r();
  }
  return seen;
}

const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

async function explainSessionReads(c: Client, q: Recorded) {
  const { rows } = await c.query(`EXPLAIN (FORMAT JSON) ${q.text}`, q.values);
  const root = rows[0]["QUERY PLAN"][0].Plan as PlanNode;
  return { reads: nodes(root).filter((n) => n["Relation Name"] === "sessions"), plan: JSON.stringify(root, null, 1) };
}

test("the teachers and schools indexes count sessions only for the rows they list", { skip }, async () => {
  const T = tag("repocount");
  const c = await connect();
  const one = async (q: string, p: unknown[]) => (await c.query(q, p)).rows[0].id as string;
  const ids: Record<string, string | undefined> = {};
  try {
    const d = (ids.district = await one(`INSERT INTO districts (name, code) VALUES ($1, $2) RETURNING id`, [`District ${T}`, T.slice(-12)]));
    const z = (ids.zone = await one(`INSERT INTO zones (district_id, name) VALUES ($1, $2) RETURNING id`, [d, `Zone ${T}`]));
    const school = (ids.school = await one(`INSERT INTO schools (zone_id, name, code) VALUES ($1, $2, $3) RETURNING id`, [
      z,
      `School ${T}`,
      T.slice(-12),
    ]));
    const cls = (ids.class = await one(`INSERT INTO classes (school_id, grade, stage) VALUES ($1, 5, 'Primary') RETURNING id`, [school]));
    const subject = (ids.subject = await one(`INSERT INTO subjects (name, code) VALUES ($1, $2) RETURNING id`, [`Subject ${T}`, T.slice(-12)]));
    const busy = await one(`INSERT INTO teachers (school_id, full_name) VALUES ($1, $2) RETURNING id`, [school, `Busy ${T}`]);
    await one(`INSERT INTO teachers (school_id, full_name) VALUES ($1, $2) RETURNING id`, [school, `Idle ${T}`]);
    await c.query(
      `INSERT INTO sessions (school_id, class_id, subject_id, teacher_id, scheduled_date)
       SELECT $1, $2, $3, $4, date '2026-01-01' + g FROM generate_series(1, 3) g`,
      [school, cls, subject, busy],
    );
    const admin = (ids.admin = await one(
      `INSERT INTO users (id, email, name, role) VALUES (gen_random_uuid(), $1, $2, 'programme_admin') RETURNING id`,
      [`admin.${T}@example.test`, `Admin ${T}`],
    ));
    signIn({ id: admin, role: "programme_admin", name: `Admin ${T}`, email: `admin.${T}@example.test` });
    const REPO = "../../apps/web/src/app/(authenticated)/repo";
    const { default: TeachersPage } = await import(`${REPO}/teachers/page.tsx`);
    const { default: SchoolsPage } = await import(`${REPO}/schools/page.tsx`);

    let teachersHtml = "";
    const teacherQueries = await watchAppQueries(async () => {
      teachersHtml = text(await render(withAppRouter(await TeachersPage({ searchParams: Promise.resolve({ school }) }))));
    });
    let schoolsHtml = "";
    const schoolQueries = await watchAppQueries(async () => {
      schoolsHtml = text(await render(withAppRouter(await SchoolsPage({ searchParams: Promise.resolve({ q: `School ${T}` }) }))));
    });

    // Still right: 3 sessions for one teacher, none for the other; the school
    // has two teachers, one class and three sessions.
    assert.match(teachersHtml, new RegExp(`Busy ${T} .*?\\b3\\b`), teachersHtml.slice(0, 2000));
    assert.match(teachersHtml, new RegExp(`Idle ${T} .*?\\b0\\b`));
    assert.match(schoolsHtml, new RegExp(`School ${T} .*?\\b2\\b \\b1\\b \\b3\\b`), schoolsHtml.slice(0, 2000));

    const readsSessions = (q: Recorded) => /"sessions"/.test(q.text);
    const pages = [
      { page: "/repo/teachers?school=", queries: teacherQueries.filter(readsSessions), column: /teacher_id/ },
      { page: "/repo/schools?q=", queries: schoolQueries.filter(readsSessions), column: /school_id/ },
    ];
    for (const p of pages) assert.ok(p.queries.length > 0, `${p.page} ran no query that reads sessions`);

    await withClient(async (e) => {
      await e.query("BEGIN");
      try {
        // A log for the planner to plan against: 2,000 sessions over forty
        // teachers of this school.
        const { rows: many } = await e.query(
          `INSERT INTO teachers (school_id, full_name, active) SELECT $1, 'Planner ' || g, false FROM generate_series(1, 40) g RETURNING id`,
          [school],
        );
        await e.query(
          `INSERT INTO sessions (school_id, class_id, subject_id, teacher_id, scheduled_date)
           SELECT $1, $2, $3, ($4::uuid[])[1 + g % 40], date '2026-01-01' + (g % 365) FROM generate_series(1, 2000) g`,
          [school, cls, subject, many.map((r: { id: string }) => r.id)],
        );
        await e.query("ANALYZE sessions");
        await e.query("SET LOCAL enable_seqscan = off");
        for (const p of pages) {
          for (const q of p.queries) {
            const { reads, plan } = await explainSessionReads(e, q);
            assert.ok(
              reads.every((n) => p.column.test(n["Index Cond"] ?? n["Recheck Cond"] ?? "")),
              `${p.page}: sessions must be read for the listed rows only, through an index condition on ${p.column.source}, not aggregated whole:\n${q.text}\n${plan}`,
            );
          }
        }
      } finally {
        await e.query("ROLLBACK");
      }
    });
  } finally {
    try {
      if (ids.school) {
        await c.query(`DELETE FROM sessions WHERE school_id = $1`, [ids.school]);
        await c.query(`DELETE FROM teachers WHERE school_id = $1`, [ids.school]);
        await c.query(`DELETE FROM classes WHERE school_id = $1`, [ids.school]);
      }
      if (ids.subject) await c.query(`DELETE FROM subjects WHERE id = $1`, [ids.subject]);
      if (ids.admin) await c.query(`DELETE FROM users WHERE id = $1`, [ids.admin]);
      if (ids.school) await c.query(`DELETE FROM schools WHERE id = $1`, [ids.school]);
      if (ids.zone) await c.query(`DELETE FROM zones WHERE id = $1`, [ids.zone]);
      if (ids.district) await c.query(`DELETE FROM districts WHERE id = $1`, [ids.district]);
    } finally {
      await c.end().catch(() => undefined);
    }
  }
});
