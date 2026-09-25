// The nightly retention job prunes expired section-gate grants, executed.
//
// ── THE DEFECT (F110) ────────────────────────────────────────────────────────
//
// Every gate unlock inserts a section_gate_grants row carrying the user id, the
// section, the unlock time and the client IP. The only DELETE of that table is
// rotation's delete-by-slug; the nightly sweep pruned notifications and
// rate_limits and never touched grants, and README-IT's retention table left
// them out. So a gate never rotated turned the table into a permanent record of
// who unlocked which section from which address -- the concern that made
// rate_limits prunable.
//
// A grant stops authorising anything at expires_at (at most 8 hours after it
// was issued, by CHECK), so a day past that it is only personal data.
//
// Executed through the REAL worker (./_worker.ts), in a schema of its own with
// its own section_gate_grants, so what is proved is that the job the worker
// actually runs -- the one scheduleDailyWork() enqueues -- removes them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { needsDatabase, tag } from "./_harness.js";
import { withWorkerWorld, waitFor } from "./_worker.js";

test(
  "the nightly retention job deletes gate grants a day past expiry, and keeps live and recent ones",
  { skip: needsDatabase(), timeout: 90_000 },
  async () => {
    await withWorkerWorld(async (w) => {
      const grant = async (grantedAgo: string) => {
        const [g] = await w.q<{ id: string }>(
          `INSERT INTO ${w.schema}.section_gate_grants (user_id, gate_slug, granted_at, expires_at, ip)
           VALUES (gen_random_uuid(), 'observation', now() - $1::interval, now() - $1::interval + interval '8 hours', '203.0.113.7')
           RETURNING id`,
          [grantedAgo],
        );
        return g!.id;
      };
      const stale = await grant("3 days"); // expired two and a half days ago
      const recent = await grant("20 hours"); // expired 12 hours ago
      const live = await grant("1 hour");

      // The job scheduleDailyWork() enqueues, exactly as it enqueues it.
      const [job] = await w.q<{ id: string }>(
        `INSERT INTO ${w.schema}.jobs (queue, name, payload, dedupe_key, max_attempts)
         VALUES ('retention', 'deleteOldNotifications', '{}', $1, 2) RETURNING id`,
        [`retention:${tag("grants")}`],
      );
      const worker = w.spawnWorker();
      const finished = await waitFor(async () => {
        const [j] = await w.q<{ status: string; last_error: string | null }>(
          `SELECT status, last_error FROM ${w.schema}.jobs WHERE id = $1`,
          [job!.id],
        );
        return j && !["queued", "running"].includes(j.status) ? j : null;
      }, 60_000);
      assert.equal(finished?.status, "succeeded", `the retention job did not succeed:\n${finished?.last_error ?? ""}\n${worker.output()}`);

      const left = (await w.q<{ id: string }>(`SELECT id FROM ${w.schema}.section_gate_grants`)).map((r) => r.id);
      assert.ok(
        !left.includes(stale),
        "a grant expired more than a day ago must be deleted by the nightly sweep -- it authorises " +
          "nothing and records who unlocked which section from which IP",
      );
      assert.deepEqual(left.sort(), [recent, live].sort(), "a live grant, and one expired under a day ago, are kept");
    });
  },
);
