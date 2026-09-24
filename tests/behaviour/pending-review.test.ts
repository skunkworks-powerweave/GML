// "How many teach-back videos do I owe a review?" -- one answer, EXECUTED.
//
// The mentor dashboard card and its to-do row counted
//   status IN (received, queued, transcoding, review_pending)
// and the card also required created_at >= now() - 48h. `review_pending` is
// written by nothing (the worker writes ready/failed, the webhook writes
// received, the review route sets only reviewed_at -- migration 0022), so the
// rows it counted were the clips still uploading or transcoding: exactly the
// ones a mentor cannot watch. A clip dropped out of the count the moment it
// became reviewable, and the 48h window then hid the overdue ones from the card
// whose hint reads "target: < 48 h". The sidebar badge and /rtt/teach-back
// already used "ready AND reviewed_at IS NULL", so three surfaces gave three
// numbers.
//
// The predicate is now one helper, in two forms: SQL for the counts and a row
// test for the teach-back queue. The first tests render the SQL with Drizzle's
// own dialect (no database); the last runs the SAME rendered SQL against real
// rows in Postgres and requires the row test to agree with it on every row.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  pendingTeachBackReviewWhere,
  isPendingTeachBackReview,
} from "../../apps/web/src/lib/video/pending-review.ts";
import { needsDatabase, withClient } from "./_harness.js";

const dialect = new PgDialect();
const rendered = () => dialect.sqlToQuery(pendingTeachBackReviewWhere());

test("a clip is pending review when it is a PLAYABLE teach-back nobody has reviewed", () => {
  const { sql, params } = rendered();
  assert.match(sql, /"video_submissions"\."context_type" = \$\d/);
  assert.match(sql, /"video_submissions"\."status" = \$\d/);
  assert.match(sql, /"video_submissions"\."reviewed_at" is null/);
  assert.deepEqual([...params].sort(), ["ready", "teach_back"]);
});

test("the predicate has no time window -- an overdue review must stay on the card", () => {
  const { sql, params } = rendered();
  assert.doesNotMatch(sql, /created_at/, "a >= 48h filter makes a clip vanish the moment it breaches the SLA");
  for (const unplayable of ["review_pending", "transcoding", "queued", "received"]) {
    assert.ok(!params.includes(unplayable), `${unplayable} is not a reviewable state`);
  }
});

// Every combination the columns can take that matters here.
const ROWS = [
  { contextType: "teach_back", status: "ready", reviewedAt: null },
  { contextType: "teach_back", status: "ready", reviewedAt: new Date("2026-09-01") },
  { contextType: "teach_back", status: "received", reviewedAt: null },
  { contextType: "teach_back", status: "queued", reviewedAt: null },
  { contextType: "teach_back", status: "transcoding", reviewedAt: null },
  { contextType: "teach_back", status: "failed", reviewedAt: null },
  { contextType: "teach_back", status: "review_pending", reviewedAt: null },
  { contextType: "observation", status: "ready", reviewedAt: null },
  { contextType: "mentorship", status: "ready", reviewedAt: null },
] as const;

test("the row form picks exactly the playable, unreviewed teach-back", () => {
  const picked = ROWS.map((r) => isPendingTeachBackReview(r));
  assert.deepEqual(picked, [true, false, false, false, false, false, false, false, false]);
});

test("the SQL and the row form agree on every row, in Postgres", { skip: needsDatabase() }, async () => {
  await withClient(async (c) => {
    const { sql, params } = rendered();
    // A VALUES list aliased as video_submissions, so the helper's qualified
    // column names resolve against these rows and nothing is written.
    const values = ROWS.map(
      (_r, i) => `($${params.length + i * 3 + 1}::text, $${params.length + i * 3 + 2}::text, $${params.length + i * 3 + 3}::timestamptz, ${i})`,
    ).join(", ");
    const rowParams = ROWS.flatMap((r) => [r.contextType, r.status, r.reviewedAt]);
    const { rows } = await c.query(
      `SELECT idx FROM (VALUES ${values}) AS video_submissions(context_type, status, reviewed_at, idx)
        WHERE ${sql} ORDER BY idx`,
      [...params, ...rowParams],
    );
    const fromSql = rows.map((r: { idx: number }) => r.idx);
    const fromRows = ROWS.flatMap((r, i) => (isPendingTeachBackReview(r) ? [i] : []));
    assert.deepEqual(fromSql, fromRows);
    assert.deepEqual(fromSql, [0], "only the ready, unreviewed teach-back is owed a review");
  });
});
