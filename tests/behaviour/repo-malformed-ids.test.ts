// A malformed id in a /repo URL is a page that does not exist -- a 404 --
// not a server error.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// Every /repo/*/[id] page passed its URL segment straight into
// `eq(<table>.id, id)` on a uuid column. For a non-uuid -- a link WhatsApp or
// SMS truncated, a typo -- Postgres raises 22P02 ("invalid input syntax for
// type uuid"), the page answers HTTP 500, and the error boundary tells the user
// it "may be a temporary connection problem" with a "Try again" that can never
// work. /repo/students?school=<bad> did the same through its filter, while
// /repo/teachers and /repo/sessions already ignored a malformed filter.
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// Each real page is called as Next calls it, signed in as a super_admin (so no
// role check stands in front of the query), through ./_server-actions.ts.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { signIn, outcome, closeAppDb } from "./_server-actions.js";
import { needsDatabase, withClient, tag } from "./_harness.js";

const skip = needsDatabase();
after(closeAppDb);

const REPO = "../../apps/web/src/app/(authenticated)/repo";
const PAGES = [
  "class/[id]/page.tsx",
  "class/[id]/learners/page.tsx",
  "mentor/[id]/page.tsx",
  "outline/[id]/page.tsx",
  "resource/[id]/page.tsx",
  "resource/[id]/view/page.tsx",
  "school/[id]/page.tsx",
  "session/[id]/page.tsx",
  "subject/[id]/page.tsx",
  "teacher/[id]/page.tsx",
];

type Page = (props: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) => Promise<unknown>;

async function asAdmin<T>(body: (adminId: string) => Promise<T>): Promise<T> {
  return withClient(async (c) => {
    const T = tag("repoid");
    const id = (
      await c.query(`INSERT INTO users (id, email, name, role) VALUES (gen_random_uuid(), $1, $2, 'super_admin') RETURNING id`, [
        `admin.${T}@example.test`,
        `Admin ${T}`,
      ])
    ).rows[0].id as string;
    try {
      signIn({ id, role: "super_admin", name: `Admin ${T}`, email: `admin.${T}@example.test` });
      return await body(id);
    } finally {
      await c.query(`DELETE FROM users WHERE id = $1`, [id]);
    }
  });
}

/** How a page call ended, with a database error named rather than thrown. */
async function ending(run: () => Promise<unknown>): Promise<string> {
  try {
    const r = await outcome(run);
    return r.kind;
  } catch (err) {
    const code = (err as { code?: string; cause?: { code?: string } }).code ?? (err as { cause?: { code?: string } }).cause?.code;
    return `threw ${code ?? String(err).slice(0, 80)}`;
  }
}

test("every /repo detail page answers 404 for a malformed or truncated id", { skip }, async () => {
  await asAdmin(async () => {
    for (const file of PAGES) {
      const { default: page } = (await import(`${REPO}/${file}`)) as { default: Page };
      for (const bad of ["not-a-uuid", "a947b224-32d8-4350-b57c-712c45"]) {
        const got = await ending(() => page({ params: Promise.resolve({ id: bad }), searchParams: Promise.resolve({}) }));
        assert.equal(got, "notFound", `/repo/${file.replace(/\/page\.tsx$/, "")} with id "${bad}": ${got}`);
      }
    }
  });
});

test("/repo/students ignores a malformed ?school= instead of failing", { skip }, async () => {
  await asAdmin(async () => {
    const { default: page } = (await import(`${REPO}/students/page.tsx`)) as {
      default: (p: { searchParams: Promise<Record<string, string>> }) => Promise<unknown>;
    };
    const got = await ending(() => page({ searchParams: Promise.resolve({ school: "not-a-uuid" }) }));
    assert.equal(got, "returned", `/repo/students?school=not-a-uuid: ${got}`);
  });
});
