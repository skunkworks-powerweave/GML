// The default /admin/audit query, planned by a real Postgres.
//
// The page's unfiltered view is `ORDER BY created_at DESC LIMIT 50`. Without an
// index that LEADS with created_at the only plan is a sequential scan plus a
// sort of the entire table -- a table that is append-only, has no delete path,
// and grows on every learner-grid render. This asks the planner directly.
//
// enable_seqscan / enable_sort are switched off for the one statement because
// on a near-empty CI table a seq scan is legitimately cheapest; the question
// here is whether an index-ordered plan EXISTS, not what the planner prefers
// at ten rows. With no created_at index, turning those off changes nothing:
// the plan is still Seq Scan + Sort, just with a penalty.

import { test } from "node:test";
import assert from "node:assert/strict";
import { needsDatabase, withClient } from "./_harness.js";

const skip = needsDatabase();

type PlanNode = { "Node Type": string; "Index Name"?: string; "Relation Name"?: string; Plans?: PlanNode[] };

function nodes(n: PlanNode): PlanNode[] {
  return [n, ...(n.Plans ?? []).flatMap(nodes)];
}

test("audit_log has an index on created_at alone", { skip }, async () => {
  await withClient(async (c) => {
    const { rows } = await c.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'audit_log'`,
    );
    const leading = rows.filter((r: { indexdef: string }) => /\(created_at\)\s*$/.test(r.indexdef));
    assert.equal(
      leading.length,
      1,
      "exactly one audit_log index on (created_at) -- found:\n" +
        rows.map((r: { indexdef: string }) => `  ${r.indexdef}`).join("\n"),
    );
  });
});

test("the unfiltered /admin/audit query can be served in created_at order from an index", { skip }, async () => {
  await withClient(async (c) => {
    await c.query("BEGIN");
    try {
      await c.query("SET LOCAL enable_seqscan = off");
      await c.query("SET LOCAL enable_sort = off");
      const { rows } = await c.query(
        `EXPLAIN (FORMAT JSON)
         SELECT id, user_id, action, created_at FROM audit_log
          WHERE true ORDER BY created_at DESC LIMIT 50 OFFSET 0`,
      );
      const plan = rows[0]["QUERY PLAN"][0].Plan as PlanNode;
      const all = nodes(plan);
      const scan = all.find((n) => n["Relation Name"] === "audit_log");
      assert.ok(scan, `no scan of audit_log in plan: ${JSON.stringify(plan)}`);
      assert.equal(
        scan["Index Name"],
        "audit_log_created_idx",
        `ORDER BY created_at DESC must be answerable by walking audit_log_created_idx backward; ` +
          `got ${scan["Node Type"]}${scan["Index Name"] ? ` on ${scan["Index Name"]}` : ""}`,
      );
      assert.ok(
        !all.some((n) => n["Node Type"] === "Sort"),
        "no sort of the whole table should be needed once the index exists",
      );
    } finally {
      await c.query("ROLLBACK");
    }
  });
});
