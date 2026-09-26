// docs/audit-actions.md says, for each action, what its metadata holds. It is
// what an operator reads to query audit_log, so a key it names that nothing
// writes is a filter that silently matches nothing, and a key it omits is data
// nobody knows is there.
//
// ── W3-06 / W3-24 / W3-25 / W3-27 ────────────────────────────────────────────
//
// Several non-auth rows described metadata the code never wrote:
//
//   helpdesk.ticket_opened       `ticketId`, `userId`, `category`  (writes topic, pageSlug, deliveredTo)
//   helpdesk.ticket_rate_limited `userId`, `ipMasked`              (writes retryAfterMs)
//   mentor.meeting.logged        `actorId`, `meetingId`, `durationMin` (writes pairingId, scheduledAt;
//                                the meeting is the entity, the actor the user)
//   resource.view.client_ping    `resourceId`, `userId`, `dwellSec`, "sent ~every 60 s of active
//                                dwell" (PdfViewer pings once per document; writes beacon)
//   resource.pdf.view            `resourceId`, `userId`, `pageOpened`, and said it covered the
//                                client pings (writes kind, fileKey, piiAudited)
//   quiz.schema.update           "a setting's key is present only when that save changed it" (the
//                                editor pre-fills every setting, so every save writes them all)
//   quickfind.query              `userId`, `query` "(length only, NOT raw text — privacy)" (writes
//                                q, the search as typed, and resultCount -- as spec 121 says)
//   user_prefs.update            `userId`, `changedKeys` (writes keys; the user is the row's)
//
// Executed: the real handlers, as a signed-in user, against Postgres; each
// row they write is compared with its documented row, both ways.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Client } from "pg";
import { resetRequest } from "./_ui.js";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { actAs, fixture, type Fixture } from "./_admin-fixture.js";
import { buildWorld, closeAppPool, describe, formData, outcome, signIn as signInPerson } from "./_mentorship.js";

const skip = needsDatabase();
after(closeAppPool);

const DOC = readFileSync(new URL("../../docs/audit-actions.md", import.meta.url), "utf8");

/** The taxonomy's table row for `action`: its "fires when" text and its metadata cell. */
function docRow(action: string): { firesWhen: string; metadata: string; line: string } {
  const line = DOC.split("\n").find((l) => l.startsWith(`| \`${action}\` |`));
  assert.ok(line, `${action} is written by the code and missing from docs/audit-actions.md`);
  const cells = line.split("|").slice(1, -1).map((s) => s.trim());
  assert.equal(cells.length, 3, `${action}: expected | action | fires when | metadata |, got ${cells.length} cells`);
  return { firesWhen: cells[1]!, metadata: cells[2]!, line };
}

/** Every `backticked` name in a metadata cell: the keys the doc says are there. */
const documentedKeys = (cell: string) => new Set([...cell.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)].map((m) => m[1]!));

type Row = { action: string; entity_type: string | null; metadata: Record<string, unknown> };

/** This user's rows for `action`, once the voided recordAudit() inserts have landed. */
async function rowsOf(c: Client, userId: string, action: string, atLeast = 1): Promise<Row[]> {
  let rows: Row[] = [];
  for (let i = 0; i < 40; i++) {
    rows = (
      await c.query<Row>(`SELECT action, entity_type, metadata FROM audit_log WHERE user_id = $1 AND action = $2`, [
        userId,
        action,
      ])
    ).rows;
    if (rows.length >= atLeast) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(rows.length >= atLeast, `the scenario should have written ${action}`);
  return rows;
}

/**
 * The row's metadata keys are exactly the ones documented: none undocumented,
 * and none documented that the code does not write. `optional` names keys the
 * doc lists that this particular row may leave out.
 */
function assertDocumented(row: Row, optional: string[] = []): void {
  const { metadata, line } = docRow(row.action);
  const documented = documentedKeys(metadata);
  const written = Object.keys(row.metadata);
  for (const key of written) {
    assert.ok(documented.has(key), `${row.action}: metadata key \`${key}\` is written and not documented`);
  }
  for (const key of documented) {
    if (optional.includes(key)) continue;
    assert.ok(written.includes(key), `${row.action}: docs/audit-actions.md documents \`${key}\`, which the code does not write`);
  }
  if (row.entity_type) {
    assert.ok(line.includes(`\`${row.entity_type}\``), `${row.action}: entity_type ${row.entity_type} is not documented`);
  }
}

async function signedIn(f: Fixture, role: string): Promise<string> {
  const id = await f.user(role, role);
  f.defer(`DELETE FROM rate_limits WHERE key LIKE $1`, [`%:${id}`]);
  actAs(id, role);
  return id;
}

/**
 * Run `body` with the helpdesk notifications whose text carries `marker`
 * silently skipped. A ticket notifies every active administrator in the
 * database, and a shared test database holds other files' administrators:
 * their inbox assertions would see this ticket, and one deleted between the
 * route's SELECT and INSERT failed it on the foreign key. A BEFORE trigger
 * that returns NULL drops the row without an error, so the route still runs
 * through to its audit write. `marker` must be a test-generated value.
 */
async function withoutTicketNotifications<T>(c: Client, marker: string, body: () => Promise<T>): Promise<T> {
  const name = `test_skip_${marker.replace(/-/g, "")}`;
  await c.query(
    `CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $f$
     BEGIN IF NEW.kind = 'helpdesk.ticket' AND NEW.body LIKE '%${marker}%' THEN RETURN NULL; END IF; RETURN NEW; END $f$`,
  );
  await c.query(`CREATE TRIGGER ${name} BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION public.${name}()`);
  try {
    return await body();
  } finally {
    await c.query(`DROP TRIGGER IF EXISTS ${name} ON notifications`);
    await c.query(`DROP FUNCTION IF EXISTS public.${name}()`);
  }
}

// ── helpdesk.* ───────────────────────────────────────────────────────────────

test("W3-06/W3-24 helpdesk.*: the ticket and the throttle rows hold what the taxonomy says", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("doc-hd"));
    try {
      const me = await signedIn(f, "teacher");
      const { POST } = await import("../../apps/web/src/app/api/helpdesk/tickets/route.ts");
      const post = () =>
        POST(
          new Request("http://x/api/helpdesk/tickets", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ topic: "login", pageSlug: "/dashboard", message: `help ${me}` }),
          }),
        );
      await withoutTicketNotifications(c, me, async () => assert.equal((await post()).status, 200));
      const leaked = await c.query(`SELECT 1 FROM notifications WHERE body LIKE $1`, [`%${me}%`]);
      assert.equal(leaked.rows.length, 0, "this test's ticket reached another file's administrators");
      const [opened] = await rowsOf(c, me, "helpdesk.ticket_opened");
      assertDocumented(opened!);

      // Spend the rest of the hour's tickets, then one refused.
      await c.query(`UPDATE rate_limits SET count = 5 WHERE key = $1`, [`helpdesk:${me}`]);
      assert.equal((await post()).status, 429);
      const [limited] = await rowsOf(c, me, "helpdesk.ticket_rate_limited");
      assertDocumented(limited!);
    } finally {
      await f.cleanup();
    }
  });
});

// ── resource.* ───────────────────────────────────────────────────────────────

test("W3-24 resource.*: the PDF view and the viewer's ping hold what the taxonomy says", { skip }, async () => {
  await withClient(async (c) => {
    const t = tag("doc-res");
    const f = fixture(c, t);
    try {
      const me = await signedIn(f, "teacher");
      const resourceId = await f.row("resources", { name: `Doc ${t}`, kind: "Guide", file_key: `doc-test/${t}.pdf` });

      // The /view page writes resource.pdf.view as it renders, before any
      // byte is fetched (the viewer loads the PDF from /api/media/pdf/<id>).
      const { default: ViewPage } = await import("../../apps/web/src/app/(authenticated)/repo/resource/[id]/view/page.tsx");
      await ViewPage({ params: Promise.resolve({ id: resourceId }) });
      const [view] = await rowsOf(c, me, "resource.pdf.view");
      assertDocumented(view!);
      assert.doesNotMatch(docRow("resource.pdf.view").firesWhen, /client ping/i, "the pings are their own action");

      // PdfViewer's one ping when it paints the document.
      const { POST } = await import("../../apps/web/src/app/api/audit/resource-view/route.ts");
      const res = await POST(
        new Request("http://x/api/audit/resource-view", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: resourceId }),
        }),
      );
      assert.equal(res.status, 204);
      const [ping] = await rowsOf(c, me, "resource.view.client_ping");
      assertDocumented(ping!);
      // PdfViewer sends one ping per document it paints (a useEffect on the
      // resource id), not a dwell heartbeat.
      const viewer = readFileSync(new URL("../../apps/web/src/components/pdf/PdfViewer.tsx", import.meta.url), "utf8");
      assert.doesNotMatch(viewer, /setInterval/, "PdfViewer has started pinging on an interval; the doc row says once per paint");
      assert.doesNotMatch(docRow("resource.view.client_ping").firesWhen, /every 60 s|dwell/i);
    } finally {
      await f.cleanup();
    }
  });
});

// ── mentor.meeting.logged ────────────────────────────────────────────────────

test("W3-24 mentor.meeting.logged holds what the taxonomy says", { skip }, async () => {
  resetRequest(); // the session _mentorship's signIn sets is read only when no fixture one is
  const w = await buildWorld("doc-meet");
  try {
    await w.grant(w.mentor.id);
    const { logMeetingAction } = await import("../../apps/web/src/app/(authenticated)/mentorship/[pairingId]/actions.ts");
    signInPerson(w.mentor);
    const r = await outcome(() =>
      logMeetingAction(formData({ pairingId: w.pairingA, scheduledAt: "2026-10-02T10:30", durationMin: "45", notes: "doc test" })),
    );
    assert.equal(r.kind, "redirect", describe(r));
    await withClient(async (c) => {
      const [row] = await rowsOf(c, w.mentor.id, "mentor.meeting.logged");
      assertDocumented(row!);
    });
  } finally {
    signInPerson(null);
    await w.cleanup();
  }
});

// ── quiz.schema.update ───────────────────────────────────────────────────────

test("W3-24 quiz.schema.update: a setting's key says the save carried it, not that it changed", { skip }, async () => {
  await withClient(async (c) => {
    const t = tag("doc-quiz");
    const f = fixture(c, t);
    try {
      const admin = await signedIn(f, "programme_admin");
      const phase = await f.row("phases", { label: t.slice(-24), sequence: 1_000_000 + randomInt(1_000_000_000) });
      const term = await f.row("terms", { phase_id: phase, name: `Term ${t}`, sequence: 1 });
      const subject = await f.row("rtt_subjects", { term_id: term, name: `Subject ${t}` });
      const settings = { title: `Quiz ${t}`, passThreshold: 60, timeLimitSeconds: 600, maxAttempts: 3, active: true };
      const quiz = await f.row("quizzes", {
        slug: t,
        title: settings.title,
        rtt_subject_id: subject,
        pass_threshold: settings.passThreshold,
        time_limit_seconds: settings.timeLimitSeconds,
        max_attempts: settings.maxAttempts,
        active: settings.active,
      });
      // What the editor sends for a save that changes nothing: it pre-fills
      // every setting from the quiz as stored (admin/quizzes/[id]/page.tsx).
      const { saveQuizSchema } = await import("../../apps/web/src/app/(authenticated)/admin/quizzes/[id]/actions.ts");
      await saveQuizSchema(quiz, JSON.stringify(settings));
      const [row] = await rowsOf(c, admin, "quiz.schema.update");
      for (const key of Object.keys(settings)) {
        assert.ok(key in row!.metadata, `an unchanged ${key} was left out of the row`);
      }
      const { firesWhen, metadata } = docRow("quiz.schema.update");
      assert.doesNotMatch(
        `${firesWhen} | ${metadata}`,
        /only when (that|the) save changed it|when changed/,
        "the taxonomy says a key means the setting changed; this save changed nothing and wrote every key",
      );
      assertDocumented(row!, ["rttSubjectId"]);
    } finally {
      await f.cleanup();
    }
  });
});

// ── user_prefs.update ────────────────────────────────────────────────────────

test("W3-27 user_prefs.update holds what the taxonomy says: the keys the save set", { skip }, async () => {
  await withClient(async (c) => {
    const f = fixture(c, tag("doc-prefs"));
    try {
      const me = await signedIn(f, "teacher");
      const { PUT } = await import("../../apps/web/src/app/api/user-prefs/route.ts");
      const res = await PUT(
        new Request("http://x/api/user-prefs", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ density: "dense", highContrast: true }),
        }),
      );
      assert.equal(res.status, 200);
      const [row] = await rowsOf(c, me, "user_prefs.update");
      assertDocumented(row!);
      assert.deepEqual(row!.metadata, { keys: ["density", "highContrast"] });
    } finally {
      await f.cleanup();
    }
  });
});

// ── quickfind.query ──────────────────────────────────────────────────────────

test("W3-25 quickfind.query: the row holds the search as typed and its result count, as the taxonomy says", { skip }, async () => {
  await withClient(async (c) => {
    const t = tag("doc-qf");
    const f = fixture(c, t);
    try {
      const me = await signedIn(f, "teacher");
      const { GET } = await import("../../apps/web/src/app/api/quickfind/route.ts");
      const res = await GET(new Request(`http://x/api/quickfind?q=${encodeURIComponent(`  ${t} nobody  `)}`));
      assert.equal(res.status, 200);
      const [row] = await rowsOf(c, me, "quickfind.query");
      assertDocumented(row!);
      // The decided shape (spec 121, and learners.search beside it): the
      // trimmed text, so an administrator can see what was looked up.
      assert.deepEqual(row!.metadata, { q: `${t} nobody`, resultCount: 0 });
    } finally {
      await f.cleanup();
    }
  });
});
