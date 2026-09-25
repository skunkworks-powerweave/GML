// What the job queue shows, and to whom -- executed against a real Postgres,
// with the real loader and the real DLQ page (rendered as a signed-in admin,
// see _stubs/auth-session.ts).
//
// Two halves of one defect. Operators could not see what the queue held: the
// DLQ page listed only transcode_jobs, the per-attempt ledger, so a job that
// died without a failed ledger row -- and every job on the retention queue --
// existed only as a number in the depth strip, and nothing anywhere read
// jobs.last_error. Meanwhile every signed-in user, teachers included, was
// shown the programme-wide "N failed" chip: other people's videos, a count
// they cannot act on, kept for thirty days per dead job.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { Client } from "pg";
import { h, render } from "./_ui.js";
import { needsDatabase, tag, DATABASE_URL } from "./_harness.js";

const skip = needsDatabase();

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (/\/tests\/behaviour\/_stubs\/auth\.ts$/.test(resolved.url.replace(/\\/g, "/"))) {
      return { url: new URL("./_stubs/auth-session.ts", import.meta.url).href, shortCircuit: true };
    }
    return resolved;
  },
});

after(async () => {
  if (!DATABASE_URL) return;
  const { getPool } = await import("../../packages/db/src/client.ts");
  await getPool().end();
});

/** Dead jobs committed under a unique name, removed afterwards. */
async function withDeadJobs(
  body: (t: string, q: <R>(sql: string, p?: unknown[]) => Promise<R[]>) => Promise<void>,
): Promise<void> {
  const c = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5000 });
  await c.connect();
  const t = tag("dead");
  const q = async <R,>(sql: string, p: unknown[] = []) => (await c.query(sql, p)).rows as R[];
  try {
    await body(t, q);
  } finally {
    await c.query(`DELETE FROM jobs WHERE last_error LIKE $1`, [`%${t}%`]);
    await c.end();
  }
}

const insertDead = (q: <R>(sql: string, p?: unknown[]) => Promise<R[]>, queue: string, name: string, payload: object, lastError: string) =>
  q(
    `INSERT INTO jobs (queue, name, payload, status, attempts, max_attempts, last_error, completed_at)
       VALUES ($1, $2, $3, 'dead', 2, 2, $4, now())`,
    [queue, name, JSON.stringify(payload), lastError],
  );

test("F145: the topbar's queue depth is shown to programme and super admins only", { skip }, async () => {
  await withDeadJobs(async (t, q) => {
    await insertDead(q, "transcode", "transcode", { videoSubmissionId: randomUUID() }, `boom ${t}`);
    const { transcodeQueueDepth } = await import("../../apps/web/src/lib/queue.ts");
    const depthFor = transcodeQueueDepth as (role: string) => Promise<{ queued: number; running: number; dead: number }>;
    for (const role of ["teacher", "mentor", "observer"]) {
      const d = await depthFor(role);
      assert.deepEqual(
        d,
        { queued: 0, running: 0, dead: 0 },
        `a ${role} is shown the programme's transcode queue (${JSON.stringify(d)}) -- other people's failures, nothing to act on`,
      );
    }
    for (const role of ["programme_admin", "super_admin"]) {
      assert.ok((await depthFor(role)).dead >= 1, `a ${role} lost the queue depth`);
    }
  });
});

test("F145: the DLQ lists dead jobs of EVERY queue with their last error, ledger row or not", { skip }, async () => {
  await withDeadJobs(async (t) => {
    const c = new Client({ connectionString: DATABASE_URL });
    await c.connect();
    const q = async <R,>(sql: string, p: unknown[] = []) => (await c.query(sql, p)).rows as R[];
    try {
      // A retention sweep that died, and a transcode the reaper dead-lettered
      // before its handler ever wrote a ledger row.
      await insertDead(q, "retention", "deleteOldNotifications", {}, `relation "notifications" is locked ${t}`);
      const video = randomUUID();
      await insertDead(q, "transcode", "transcode", { videoSubmissionId: video }, `never started ${t} [lease expired: worker stopped responding]`);
    } finally {
      await c.end();
    }

    (globalThis as Record<string, unknown>).__gmlTestSession = {
      user: { id: randomUUID(), email: "admin@example.test", name: "Admin", image: null, role: "programme_admin" },
    };
    const { default: Page } = await import("../../apps/web/src/app/(authenticated)/admin/transcode-jobs/page.tsx");
    const html = await render(h(Page, { searchParams: Promise.resolve({}) }));
    assert.match(html, new RegExp(`relation &quot;notifications&quot; is locked ${t}|relation "notifications" is locked ${t}`), "a dead retention job is invisible");
    assert.match(html, new RegExp(`never started ${t}`), "a dead transcode with no ledger row is invisible");
    assert.match(html, /data-testid="dlq-dead-jobs"/);
  });
});
