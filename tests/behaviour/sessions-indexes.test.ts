// The classroom-session log can be read by subject, and newest-first, from an
// index.
//
// ── THE DEFECT (F143) ────────────────────────────────────────────────────────
//
// sessions had indexes on (school_id, date), (teacher_id, date) and
// (class_id, date), and nothing on subject_id or on the date alone. So:
//   /repo/subjects      a correlated COUNT(*) WHERE subject_id = subjects.id --
//                       one full scan of sessions per subject, every load;
//   /repo/subject/[id]  its latest 8, its top teachers and its total -- each a
//                       full scan plus a sort;
//   /repo/sessions      ?subject= filters on it, and the unfiltered default,
//                       ORDER BY scheduled_date DESC, scheduled_time DESC
//                       LIMIT 200, sorts the entire table.
// At ~98 schools with weekly sessions that is 100k+ rows a year; on a 350k-row
// copy the subject count took 338 ms and the latest-8 57 ms, against 42 ms and
// 0.1 ms with an index.
//
// Plan shape, not timing: with sequential scans switched off the planner uses
// an index wherever one can serve the query -- so a query that still reads
// sessions without an index condition on subject_id, or still sorts, has no
// index that serves it. The query shapes are the pages' own. The planner is
// given a log to plan against -- 2,000 sessions over ten subjects, ANALYZEd --
// because on a near-empty table every index costs the same and its choice
// between them is arbitrary. All of it is rolled back.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "pg";
import { needsDatabase, tag, withClient } from "./_harness.js";

type PlanNode = {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Index Cond"?: string;
  "Recheck Cond"?: string;
  Plans?: PlanNode[];
};

function nodes(n: PlanNode): PlanNode[] {
  return [n, ...(n.Plans ?? []).flatMap(nodes)];
}

async function plan(c: Client, sql: string): Promise<{ all: PlanNode[]; text: string }> {
  const { rows } = await c.query(`EXPLAIN (FORMAT JSON) ${sql}`);
  const root = rows[0]["QUERY PLAN"][0].Plan as PlanNode;
  return { all: nodes(root), text: JSON.stringify(root, null, 1) };
}

const onSessions = (n: PlanNode) => n["Relation Name"] === "sessions";
const isIndexScan = (n: PlanNode) => /Index/.test(n["Node Type"]);
/** An index scan conditioned on subject_id, or a bitmap heap scan fed by one. */
const bySubjectIndex = (n: PlanNode) =>
  (isIndexScan(n) && /subject_id/.test(n["Index Cond"] ?? "")) ||
  (n["Node Type"] === "Bitmap Heap Scan" && /subject_id/.test(n["Recheck Cond"] ?? ""));

test("a subject's sessions, and the newest sessions, are read from an index", { skip: needsDatabase() }, async () => {
  await withClient(async (c) => {
    await c.query("BEGIN");
    try {
      const t = tag("six").slice(-8);
      const one = async (sql: string, params: unknown[]) => (await c.query(sql, params)).rows[0].id as string;
      const d = await one(`INSERT INTO districts (name, code) VALUES ($1, $2) RETURNING id`, [`Index test ${t}`, `IX${t}`]);
      const z = await one(`INSERT INTO zones (district_id, name) VALUES ($1, 'index test') RETURNING id`, [d]);
      const s = await one(`INSERT INTO schools (zone_id, code, name) VALUES ($1, $2, 'Index test school') RETURNING id`, [z, `IX-${t}`]);
      const cl = await one(`INSERT INTO classes (school_id, grade, stage) VALUES ($1, 5, 'Primary') RETURNING id`, [s]);
      const te = await one(`INSERT INTO teachers (school_id, full_name, active) VALUES ($1, 'Index test teacher', false) RETURNING id`, [s]);
      const { rows: subs } = await c.query(
        `INSERT INTO subjects (name, code) SELECT 'Index test ' || $1 || ' ' || g, 'IX' || $1 || g
           FROM generate_series(1, 10) g RETURNING id`,
        [t],
      );
      await c.query(
        `INSERT INTO sessions (school_id, class_id, subject_id, teacher_id, scheduled_date, scheduled_time)
         SELECT $1, $2, ($3::uuid[])[1 + g % 10], $4, date '2026-01-01' + (g % 365), time '08:00' + (g % 6) * interval '1 hour'
           FROM generate_series(1, 2000) g`,
        [s, cl, subs.map((r: { id: string }) => r.id), te],
      );
      await c.query("ANALYZE sessions");
      await c.query("SET LOCAL enable_seqscan = off");
      const subject = `'${subs[0].id}'::uuid`;

      for (const [page, sql] of [
        ["/repo/subject/[id] latest 8", `SELECT id FROM sessions WHERE subject_id = ${subject} ORDER BY scheduled_date DESC LIMIT 8`],
        ["/repo/subject/[id] total", `SELECT count(*) FROM sessions WHERE subject_id = ${subject}`],
        ["/repo/subjects per-subject count", `SELECT (SELECT count(*) FROM sessions s WHERE s.subject_id = sub.id) FROM subjects sub`],
      ] as const) {
        const p = await plan(c, sql);
        const reads = p.all.filter(onSessions);
        assert.ok(reads.length > 0, `${page}: the plan does not read sessions at all:\n${p.text}`);
        assert.ok(
          reads.every(bySubjectIndex),
          `${page}: sessions must be read through an index on subject_id, not scanned whole:\n${p.text}`,
        );
      }

      const newest = await plan(
        c,
        `SELECT id FROM sessions ORDER BY scheduled_date DESC, scheduled_time DESC LIMIT 200`,
      );
      assert.ok(
        newest.all.filter(onSessions).every(isIndexScan) && !newest.all.some((n) => /Sort/.test(n["Node Type"])),
        `/repo/sessions (unfiltered) must walk an index newest-first, not sort the whole table:\n${newest.text}`,
      );
    } finally {
      await c.query("ROLLBACK");
    }
  });
});
