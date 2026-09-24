import "server-only";

// The validation and INSERT behind createQuizAction, with the database handed
// in. Kept out of the "use server" module on purpose: every export of that
// file is a server action a browser can call, and this function takes a
// database handle. Taking the handle as an argument is what lets
// tests/behaviour/quizzes.test.ts run it against a real Postgres, which is the
// only thing that enforces quizzes_one_scope.

import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { quizzes, rttSubjects } from "@gml/db/schema";
import { isUuid } from "@/lib/ids";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = NodePgDatabase<any>;

/** Matches the slug in the URL: /quizzes/<slug>. */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type CreateQuizFields = {
  title: string;
  slug: string;
  passThreshold: string;
  rttSubjectId: string;
};

export type CreateQuizOutcome =
  | { ok: true; id: string; slug: string; title: string; passThreshold: number; rttSubjectId: string }
  | { ok: false; error: string };

const NO_SUBJECT = "Choose the RTT subject this quiz belongs to.";

export async function createQuiz(db: AnyDb, fields: CreateQuizFields): Promise<CreateQuizOutcome> {
  const title = fields.title.trim();
  const slugRaw = fields.slug.trim().toLowerCase();
  const thresholdRaw = fields.passThreshold.trim() || "60";

  if (title.length < 2 || title.length > 200) {
    return { ok: false, error: "Give the quiz a title of at least 2 characters." };
  }

  // Derive a slug from the title when none is given -- the slug is a URL
  // detail most people should not have to think about.
  const slug = slugRaw || title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!SLUG_RE.test(slug) || slug.length > 60) {
    return {
      ok: false,
      error: "The slug must be lowercase letters, numbers and single hyphens, 60 characters or fewer.",
    };
  }

  const passThreshold = Number(thresholdRaw);
  if (!Number.isInteger(passThreshold) || passThreshold < 1 || passThreshold > 100) {
    return { ok: false, error: "The pass threshold must be a whole number between 1 and 100." };
  }

  // THE SCOPE IS PART OF CREATION.
  //
  // quizzes_one_scope requires exactly one of subject_id / rtt_subject_id, and
  // this INSERT used to set neither -- so every quiz the product tried to create
  // was refused by Postgres and reported as "Please try again". Asked for on
  // the form and checked here, so a stale or hand-edited id gets a message
  // rather than a foreign-key error.
  const rttSubjectId = fields.rttSubjectId.trim();
  if (!isUuid(rttSubjectId)) return { ok: false, error: NO_SUBJECT };
  const [subject] = await db
    .select({ id: rttSubjects.id })
    .from(rttSubjects)
    .where(eq(rttSubjects.id, rttSubjectId))
    .limit(1);
  if (!subject) return { ok: false, error: NO_SUBJECT };

  // Checked before inserting so the message names the real problem. The unique
  // index still backstops a race.
  const [clash] = await db
    .select({ id: quizzes.id })
    .from(quizzes)
    .where(eq(quizzes.slug, slug))
    .limit(1);
  if (clash) {
    return { ok: false, error: `A quiz already uses the address "${slug}". Choose another slug.` };
  }

  let created: { id: string } | undefined;
  try {
    [created] = await db
      .insert(quizzes)
      .values({
        slug,
        title,
        passThreshold,
        rttSubjectId,
        // INACTIVE until it has questions. /quizzes/[slug] serves active
        // quizzes only, so a learner cannot walk into an empty one.
        active: false,
      })
      .returning({ id: quizzes.id });
  } catch (err) {
    console.error("[admin.quiz.create] failed", err);
    // The two refusals a retry cannot fix get their own words: a slug taken
    // between the check above and this INSERT, and a subject deleted meanwhile.
    const code = (err as { code?: string } | null)?.code;
    if (code === "23505") {
      return { ok: false, error: `A quiz already uses the address "${slug}". Choose another slug.` };
    }
    if (code === "23503") return { ok: false, error: NO_SUBJECT };
    return { ok: false, error: "That quiz could not be created. Please try again." };
  }

  if (!created) return { ok: false, error: "That quiz could not be created." };
  return { ok: true, id: created.id, slug, title, passThreshold, rttSubjectId };
}
