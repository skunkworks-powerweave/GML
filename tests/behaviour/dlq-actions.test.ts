// The transcode DLQ (/admin/transcode-jobs), EXECUTED: its page and its two
// operator verbs, Retry and Drop, called exactly as Next calls them, as a
// signed-in programme admin (see _stubs/auth-session.ts), against a real
// Postgres.
//
// The worker writes one transcode_jobs row PER ATTEMPT, so a video whose first
// attempt failed and whose automatic retry succeeded keeps a 'failed' row
// forever beside its 'succeeded' one. Everything here is about what the verbs
// may do to a submission on the strength of such a row -- the historical
// attempt versus the submission's current state.
//
// Rows are committed under a unique tag and deleted afterwards. A redirect() is
// Next's thrown digest; revalidatePath() needs Next's static-generation store
// and throws outside it, which is how an action that got that far is told
// apart from one that was refused.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { Client } from "pg";
import { h, render, elements } from "./_ui.js";
import { needsDatabase, tag, DATABASE_URL } from "./_harness.js";

const skip = needsDatabase();

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    // _ui.ts maps @/auth to a stub with no session; these tests need one.
    if (/\/tests\/behaviour\/_stubs\/auth\.ts$/.test(resolved.url.replace(/\\/g, "/"))) {
      return { url: new URL("./_stubs/auth-session.ts", import.meta.url).href, shortCircuit: true };
    }
    return resolved;
  },
});

const actions = () => import("../../apps/web/src/app/(authenticated)/admin/transcode-jobs/actions.ts");
const dlqPage = () => import("../../apps/web/src/app/(authenticated)/admin/transcode-jobs/page.tsx");

after(async () => {
  if (!DATABASE_URL) return;
  const { getPool } = await import("../../packages/db/src/client.ts");
  await getPool().end();
});

function signInAsAdmin(): void {
  (globalThis as Record<string, unknown>).__gmlTestSession = {
    user: { id: randomUUID(), email: "padmin@example.test", name: "Programme admin", image: null, role: "programme_admin" },
  };
}

/** Run an action: where it redirected, or that it completed (reached revalidatePath). */
async function act(run: () => Promise<unknown>): Promise<{ redirect?: string; completed?: true }> {
  try {
    await run();
    return { completed: true };
  } catch (e) {
    const digest = (e as { digest?: unknown } | null)?.digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT;")) return { redirect: digest.split(";")[2] };
    if (/static generation store missing/.test((e as Error).message)) return { completed: true };
    throw e;
  }
}

const form = (jobId: string) => {
  const fd = new FormData();
  fd.set("jobId", jobId);
  return fd;
};

type World = {
  c: Client;
  submissionId: string;
  /** Ledger row ids, oldest first, in the order given. */
  attempts: string[];
  q: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<R[]>;
};

/**
 * A committed direct upload with the given status and one ledger row per
 * attempt status, oldest first.
 */
async function withSubmission(
  s: { status: "ready" | "failed" | "queued"; attempts: string[] },
  body: (w: World) => Promise<void>,
): Promise<void> {
  const c = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5000 });
  await c.connect();
  const t = tag("dlq");
  const q = async <R,>(sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows as R[];
  const [file] = await q<{ id: string }>(
    `INSERT INTO files (bucket, object_key, mime_type, kind, status) VALUES ('videos-original', $1, 'video/mp4', 'video_original', 'stored') RETURNING id`,
    [`test/${t}.mp4`],
  );
  const ready = s.status === "ready";
  const [sub] = await q<{ id: string }>(
    `INSERT INTO video_submissions (file_id, source, status, context_type, hls_master_key, verified_at)
       VALUES ($1, 'direct', $2, 'generic', $3, $4) RETURNING id`,
    [file!.id, s.status, ready ? `hls/${t}/index.m3u8` : null, ready ? new Date() : null],
  );
  const attempts: string[] = [];
  for (let i = 0; i < s.attempts.length; i++) {
    const [row] = await q<{ id: string }>(
      `INSERT INTO transcode_jobs (video_submission_id, profile, status, started_at, ended_at, error, created_at)
         VALUES ($1, '480p', $2, now() - make_interval(mins => $3), now() - make_interval(mins => $3), $4, now() - make_interval(mins => $3))
       RETURNING id`,
      [sub!.id, s.attempts[i], (s.attempts.length - i) * 10, s.attempts[i] === "failed" ? `transient storage error ${t}` : null],
    );
    attempts.push(row!.id);
  }
  try {
    signInAsAdmin();
    await body({ c, submissionId: sub!.id, attempts, q });
  } finally {
    await c.query(`DELETE FROM jobs WHERE dedupe_key = $1`, [`submission:${sub!.id}`]);
    await c.query(`DELETE FROM video_submissions WHERE id = $1`, [sub!.id]);
    await c.query(`DELETE FROM files WHERE id = $1`, [file!.id]);
    await c.end();
  }
}

const statusOf = async (w: World) =>
  (await w.q<{ status: string }>(`SELECT status FROM video_submissions WHERE id = $1`, [w.submissionId]))[0]!.status;
const ledgerOf = async (w: World) =>
  (await w.q<{ id: string; status: string }>(
    `SELECT id, status FROM transcode_jobs WHERE video_submission_id = $1 ORDER BY created_at`,
    [w.submissionId],
  )).map((r) => r.status);
const jobsOf = async (w: World) =>
  w.q<{ status: string }>(`SELECT status FROM jobs WHERE dedupe_key = $1`, [`submission:${w.submissionId}`]);

// ── F63: the verbs act on the submission's current state ────────────────────

test("F63: Drop on a superseded failed attempt is refused, and the ready video stays ready", { skip }, async () => {
  await withSubmission({ status: "ready", attempts: ["failed", "succeeded"] }, async (w) => {
    const { dropTranscodeJobAction } = await actions();
    const res = await act(() => dropTranscodeJobAction(form(w.attempts[0]!)));

    // The video played before the click. Drop used to write status='failed'
    // unconditionally, and the playlist route then answered 409 not_ready --
    // for a direct upload, with nothing in the product able to undo it.
    assert.equal(await statusOf(w), "ready", `Drop on a stale attempt broke a playable video (${JSON.stringify(res)})`);
    assert.deepEqual(await ledgerOf(w), ["failed", "succeeded"]);
    assert.match(res.redirect ?? "", /error=/, "the refusal must be reported, not silent");
  });
});

test("F63: Retry on a superseded failed attempt is refused, and nothing is re-transcoded", { skip }, async () => {
  await withSubmission({ status: "ready", attempts: ["failed", "succeeded"] }, async (w) => {
    const { retryTranscodeJobAction } = await actions();
    const res = await act(() => retryTranscodeJobAction(form(w.attempts[0]!)));

    assert.equal(await statusOf(w), "ready", `Retry on a stale attempt un-readied a playable video (${JSON.stringify(res)})`);
    assert.equal((await jobsOf(w)).length, 0, "a ready video was queued for transcoding again");
    assert.match(res.redirect ?? "", /error=/);
  });
});

test("F63: Retry on the latest attempt of a failed video still works", { skip }, async () => {
  await withSubmission({ status: "failed", attempts: ["failed", "failed"] }, async (w) => {
    const { retryTranscodeJobAction } = await actions();
    const res = await act(() => retryTranscodeJobAction(form(w.attempts[1]!)));
    assert.equal(res.completed, true, `the retry was refused: ${JSON.stringify(res)}`);
    assert.equal(await statusOf(w), "queued");
    assert.equal((await jobsOf(w)).length, 1, "the retry must enqueue exactly one job");
  });
});

test("F63: the DLQ offers Retry and Drop only on a submission's latest, still-failed attempt", { skip }, async () => {
  await withSubmission({ status: "ready", attempts: ["failed", "succeeded"] }, async (stale) => {
    await withSubmission({ status: "failed", attempts: ["failed", "failed"] }, async (live) => {
      const { default: Page } = await dlqPage();
      const html = await render(h(Page, { searchParams: Promise.resolve({}) }));
      const rows = elements(html, "tr");
      const actionsFor = (w: World, i: number) => {
        const row = rows.find((r) => r.open.includes(`data-job-id="${w.attempts[i]!}"`) || r.inner.includes(w.attempts[i]!));
        assert.ok(row, `the ledger row ${w.attempts[i]} is not on the page`);
        return {
          retry: row.inner.includes('data-testid="dlq-retry-button"'),
          drop: row.inner.includes('data-testid="dlq-drop-button"'),
        };
      };
      // The old failure of a video that has since become ready: no verbs.
      assert.deepEqual(actionsFor(stale, 0), { retry: false, drop: false }, "a superseded attempt of a READY video offers Retry/Drop");
      // A failed video: only its latest attempt is actionable.
      assert.deepEqual(actionsFor(live, 0), { retry: false, drop: false }, "an older attempt of a failed video offers Retry/Drop");
      assert.deepEqual(actionsFor(live, 1), { retry: true, drop: true }, "the latest failed attempt lost its Retry/Drop");
    });
  });
});
