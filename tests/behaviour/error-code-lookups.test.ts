// A ?error= code (or ?field=, or a route slug) that happens to be the name of
// something every object inherits is an unknown code, not a crash.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// Each page looked the code up in a plain object literal -- ACTION_ERRORS,
// DLQ_ERRORS, SUBMIT_ERRORS, PAIRING_ERRORS, CYCLE_ERRORS, HISTORY_ERRORS,
// GRID_ERRORS, and observation/new's ERRORS and FIELD_NAMES -- and relied on
// `?? fallback`. A literal inherits from Object.prototype, so ?error=__proto__
// returned an object, which React refuses as a child: the page threw, and
// anyone could send a link that broke it for whoever opened it. ?error=
// constructor returned a function, which renders nothing, so the page showed
// an empty red alert. /admin/data/__proto__ found an "entity" with no
// readRoles and threw inside requireRole, where an unknown slug gets a 404.
//
// ── WHAT IS EXECUTED ─────────────────────────────────────────────────────────
//
// The real pages rendered as a programme_admin holding both section grants,
// against Postgres; the alert each shows for an inherited name is compared
// with the one it shows for a code nobody defined.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { signIn, closeAppDb, outcome, form, type TestUser } from "./_server-actions.js";
import { render, withAppRouter, decodeEntities, request } from "./_ui.js";
import { needsDatabase } from "./_harness.js";
import { observationWorld } from "./_observation-world.js";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

const APP = "../../apps/web/src/app/(authenticated)";
const INHERITED = ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"];
const UNKNOWN = "no_such_code";

/** The text of the element carrying `marker` (an attribute), or null if none. */
function textAt(html: string, marker: string): string | null {
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const open = html.lastIndexOf("<", at);
  const tagName = /^<([a-z]+)/.exec(html.slice(open))![1]!;
  // Walk to the matching close tag; the alerts nest a <b> or <span> at most.
  const re = new RegExp(`<${tagName}\\b|</${tagName}>`, "g");
  re.lastIndex = open + 1;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) break;
  }
  const inner = html.slice(html.indexOf(">", open) + 1, m ? m.index : html.length);
  return decodeEntities(inner.replace(/<[^>]*>/g, "")).trim();
}

test("lookupOwn answers only a map's own string keys", async () => {
  const { lookupOwn } = await import("../../apps/web/src/lib/lookup.ts");
  const MAP: Record<string, string> = { known: "Known." };
  assert.equal(lookupOwn(MAP, "known"), "Known.");
  for (const key of [...INHERITED, UNKNOWN, undefined, null, 5, ["known"], ["a", "b"]]) {
    assert.equal(lookupOwn(MAP, key), undefined, `lookupOwn(MAP, ${JSON.stringify(key)})`);
  }
});

test("every page with an ?error= alert treats an inherited name as an unknown code", { skip }, async () => {
  const w = await observationWorld("errlookup");
  const c = w.c;
  const t = w.T;
  const phase = (await c.query(`INSERT INTO phases (label, sequence) VALUES ($1, $2) RETURNING id`, [t.slice(-24), 1_000_000 + randomInt(1_000_000_000)])).rows[0].id;
  const term = (await c.query(`INSERT INTO terms (phase_id, name, sequence) VALUES ($1, $2, 1) RETURNING id`, [phase, `Term ${t}`])).rows[0].id;
  const rttSubject = (await c.query(`INSERT INTO rtt_subjects (term_id, name) VALUES ($1, $2) RETURNING id`, [term, `Subject ${t}`])).rows[0].id;
  await c.query(`INSERT INTO quizzes (slug, title, rtt_subject_id, active) VALUES ($1, $2, $3, true)`, [t, `Quiz ${t}`, rttSubject]);
  try {
    await w.grant(w.admin.id, "observation");
    await w.grant(w.admin.id, "mentorship");
    const admin: TestUser = { id: w.admin.id, role: "programme_admin", name: w.admin.name, email: w.admin.email };
    const cycle = await w.cycle({ status: "pre_submitted" });
    request.cookies = { "gml-device": "desktop" };

    const pages: Array<{ name: string; marker: string; run: (sp: Record<string, unknown>) => Promise<unknown> }> = [
      {
        name: "/admin/whatsapp-log",
        marker: 'data-testid="action-error"',
        run: async (sp) => (await import(`${APP}/admin/whatsapp-log/page.tsx`)).default({ searchParams: Promise.resolve(sp) }),
      },
      {
        name: "/admin/transcode-jobs",
        marker: 'data-testid="dlq-error"',
        run: async (sp) => (await import(`${APP}/admin/transcode-jobs/page.tsx`)).default({ searchParams: Promise.resolve(sp) }),
      },
      {
        name: "/forms",
        marker: 'data-testid="forms-error"',
        run: async (sp) => (await import(`${APP}/forms/page.tsx`)).default({ searchParams: Promise.resolve(sp) }),
      },
      {
        name: "/mentorship/[pairingId]",
        marker: 'data-testid="pairing-error"',
        run: async (sp) =>
          (await import(`${APP}/mentorship/[pairingId]/page.tsx`)).default({
            params: Promise.resolve({ pairingId: w.pairingId }),
            searchParams: Promise.resolve(sp),
          }),
      },
      {
        name: "/observation/new",
        marker: 'role="alert"',
        run: async (sp) => (await import(`${APP}/observation/new/page.tsx`)).default({ searchParams: Promise.resolve(sp) }),
      },
      {
        name: "/observation/[cycleId]",
        marker: 'data-testid="cycle-error"',
        run: async (sp) =>
          (await import(`${APP}/observation/[cycleId]/page.tsx`)).default({
            params: Promise.resolve({ cycleId: cycle.id }),
            searchParams: Promise.resolve(sp),
          }),
      },
      {
        name: "/quizzes/[slug]/history",
        marker: 'data-testid="history-error"',
        run: async (sp) =>
          (await import(`${APP}/quizzes/[slug]/history/page.tsx`)).default({
            params: Promise.resolve({ slug: t }),
            searchParams: Promise.resolve(sp),
          }),
      },
      {
        name: "/admin/data/schools",
        marker: 'data-testid="grid-error"',
        run: async (sp) =>
          (await import(`${APP}/admin/data/[entity]/page.tsx`)).default({
            params: Promise.resolve({ entity: "schools" }),
            searchParams: Promise.resolve(sp),
          }),
      },
    ];

    // Every page and every name is tried, and all the wrong answers are
    // reported together.
    const wrong: string[] = [];
    const alertFor = async (p: (typeof pages)[number], sp: Record<string, unknown>) => {
      signIn(admin);
      try {
        return textAt(await render(withAppRouter(await p.run(sp))), p.marker);
      } catch (err) {
        return `THREW ${String(err).slice(0, 80)}`;
      }
    };
    const expectSame = async (p: (typeof pages)[number], sp: Record<string, unknown>, expected: string | null) => {
      const got = await alertFor(p, sp);
      if (got !== expected) wrong.push(`${p.name} ${JSON.stringify(sp)}: ${JSON.stringify(got)}, not ${JSON.stringify(expected)}`);
    };

    for (const p of pages) {
      const generic = await alertFor(p, { error: UNKNOWN });
      assert.doesNotMatch(generic ?? "", /^THREW/, `${p.name} renders an unknown code`);
      for (const code of INHERITED) await expectSame(p, { error: code }, generic);
      // A repeated ?error=a&error=b arrives as an array. A page may ignore it
      // or call it unknown, but it must render, and not as an empty alert.
      const repeated = await alertFor(p, { error: [UNKNOWN, "x"] });
      if (repeated !== null && repeated !== generic) wrong.push(`${p.name} with a repeated ?error=: ${JSON.stringify(repeated)}`);
    }

    // ?field= names the question a refusal was about; an inherited name is no
    // question at all.
    const nominate = pages.find((p) => p.name === "/observation/new")!;
    const plain = await alertFor(nominate, { error: "invalid" });
    assert.match(plain ?? "", /^Some of the details/);
    for (const field of INHERITED) await expectSame(nominate, { error: "invalid", field }, plain);
    const cyclePage = pages.find((p) => p.name === "/observation/[cycleId]")!;
    const noField = await alertFor(cyclePage, { error: "invalid_form" });
    assert.match(noField ?? "", /^An answer was blank/);
    for (const field of INHERITED) await expectSame(cyclePage, { error: "invalid_form", field }, noField);

    assert.deepEqual(wrong, [], "an inherited name was treated as a known code");
  } finally {
    await c.query(`DELETE FROM quizzes WHERE slug = $1`, [t]);
    await c.query(`DELETE FROM rtt_subjects WHERE id = $1`, [rttSubject]);
    await c.query(`DELETE FROM terms WHERE id = $1`, [term]);
    await c.query(`DELETE FROM phases WHERE id = $1`, [phase]);
    await w.cleanup();
  }
});

test("an inherited name is not an admin entity: the grid answers 404 and the writes refuse it", { skip }, async () => {
  const w = await observationWorld("errslug");
  try {
    signIn({ id: w.admin.id, role: "super_admin", name: w.admin.name, email: w.admin.email });
    const { default: AdminGridPage } = await import(`${APP}/admin/data/[entity]/page.tsx`);
    const { createRowAction } = await import(`${APP}/admin/data/[entity]/actions.ts`);
    const { importCsv } = await import(`${APP}/admin/data/[entity]/csv.ts`);
    for (const slug of INHERITED) {
      const r = await outcome(() => AdminGridPage({ params: Promise.resolve({ entity: slug }), searchParams: Promise.resolve({}) }));
      assert.equal(r.kind, "notFound", `/admin/data/${slug}`);
      await assert.rejects(createRowAction(undefined, form({ entitySlug: slug })), /Unknown admin entity/, `create on ${slug}`);
      await assert.rejects(importCsv(slug, "a\n1\n"), /Unknown admin entity/, `import into ${slug}`);
    }
  } finally {
    await w.cleanup();
  }
});
