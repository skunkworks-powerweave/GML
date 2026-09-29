// The Approvals menu item carries a count of the requests waiting on the
// viewer, and only for someone who decides approvals.
//
// Executed: the real lib/chrome-counts.ts (loadNavCounts, which the
// authenticated layout awaits, and applyNavCounts, which the sidebar merges
// into the menu) against Postgres. ./_ui.ts replaces chrome-counts with a
// count-free stand-in for render tests, so this file uses ./_auth-harness.ts,
// which keeps it real.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeAppDb } from "./_auth-harness.ts";
import { needsDatabase, withClient, tag } from "./_harness.js";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

test("the approvals badge counts what waits on an approver, and a teacher gets none", { skip }, async () => {
  const { loadNavCounts, applyNavCounts } = await import("../../apps/web/src/lib/chrome-counts.ts");
  const { pendingApprovalCount } = await import("../../apps/web/src/lib/approvals/index.ts");
  const { NAV_BY_ROLE } = await import("../../apps/web/src/config/nav.ts");
  const { createRequire } = await import("node:module");
  const { db } = createRequire(new URL("../../apps/web/package.json", import.meta.url))("@gml/db") as { db: never };
  await withClient(async (c) => {
    const t = tag("ab");
    const ids: string[] = [];
    const user = async (role: string) => {
      const id = randomUUID();
      await c.query(`INSERT INTO users (id, email, name, role) VALUES ($1, $2, $3, $4)`, [id, `${role}.${t}@example.test`, role, role]);
      ids.push(id);
      return id;
    };
    const padmin = await user("programme_admin");
    const teacher = await user("teacher");
    const mentor = await user("mentor");
    const { rows: [req] } = await c.query(
      `INSERT INTO account_requests (full_name, email, requested_role) VALUES ($1, $2, 'observer') RETURNING id`,
      [`Badge ${t}`, `badge.${t}@example.test`],
    );
    const { rows: [appr] } = await c.query(
      `INSERT INTO approvals (item_type, item_id) VALUES ('account_request', $1) RETURNING id`,
      [req.id],
    );
    try {
      const counts = await loadNavCounts(padmin, "programme_admin");
      assert.equal(typeof counts.approvals, "number", "a programme admin's menu carries the count");
      assert.ok(counts.approvals! >= 1, "including this request");
      // The same definition as the queue's: nothing is counted that /approvals would not list.
      const listed = await pendingApprovalCount(db, { id: padmin, role: "programme_admin" });
      assert.ok(Math.abs(listed - counts.approvals!) <= 5, `badge ${counts.approvals} vs queue ${listed} (other files may add requests meanwhile)`);

      assert.equal((await loadNavCounts(teacher, "teacher")).approvals, undefined, "a teacher decides nothing: no badge");
      const mentorCounts = await loadNavCounts(mentor, "mentor");
      assert.equal(typeof mentorCounts.approvals, "number", "a mentor decides teach-backs and sign-offs, so has a count");

      // Merged into the menu item the sidebar renders; no count, no badge.
      const item = (sections: ReturnType<typeof applyNavCounts>) =>
        sections.flatMap((s) => s.items as Array<{ id: string; count?: number }>).find((i) => i.id === "approvals");
      assert.equal(item(applyNavCounts(NAV_BY_ROLE.programme_admin, { approvals: 7 }))?.count, 7);
      assert.equal(item(applyNavCounts(NAV_BY_ROLE.programme_admin, {}))?.count, undefined);
    } finally {
      await c.query(`DELETE FROM approvals WHERE id = $1`, [appr.id]);
      await c.query(`DELETE FROM account_requests WHERE id = $1`, [req.id]);
      await c.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [ids]);
    }
  });
});
