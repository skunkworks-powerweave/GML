"use server";

// Create a quiz.
//
// ── WHY THIS FILE DID NOT EXIST, AND WHAT THAT COST ──────────────────────────
//
// There was no `insert(quizzes)` anywhere in the repository. The only quiz
// action was quizzes/[id]/actions.ts, which UPDATES a quiz that already exists,
// and reaching that page needs an id. So the product could edit quizzes and
// could not make one.
//
// The empty state said "No quizzes yet. Seed via SQL or use the JSON editor on
// the detail page." Neither half was followable: there is no quiz seed script,
// and the detail page needs an id nobody could obtain. The only route was a
// hand-written INSERT against production.
//
// It is not a cosmetic gap. /rtt/subject/[id] links every subject's assessments
// to /quizzes/mid-unit and /quizzes/endline, so with no quizzes those links 404
// for every subject in the programme.
//
// A new quiz is created EMPTY and INACTIVE: the questions are then written on
// the detail page's JSON editor, which already exists and works. Inactive
// matters -- /quizzes/[slug] only serves active quizzes, so a half-built quiz
// cannot be walked into by a learner.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@gml/db";
import { quizzes } from "@gml/db/schema";
import { requireRole } from "@/lib/guards";
import { recordAudit } from "@/lib/audit";

export type CreateQuizState = { error?: string } | undefined;

/** Matches the slug in the URL: /quizzes/<slug>. */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function createQuizAction(
  _prev: CreateQuizState,
  formData: FormData,
): Promise<CreateQuizState> {
  await requireRole(["programme_admin", "super_admin"]);

  const title = String(formData.get("title") ?? "").trim();
  const slugRaw = String(formData.get("slug") ?? "").trim().toLowerCase();
  const thresholdRaw = String(formData.get("passThreshold") ?? "60").trim();

  if (title.length < 2 || title.length > 200) {
    return { error: "Give the quiz a title of at least 2 characters." };
  }

  // Derive a slug from the title when none is given -- the slug is a URL
  // detail most people should not have to think about.
  const slug = slugRaw || title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!SLUG_RE.test(slug) || slug.length > 60) {
    return {
      error:
        "The slug must be lowercase letters, numbers and single hyphens, 60 characters or fewer.",
    };
  }

  const passThreshold = Number(thresholdRaw);
  if (!Number.isInteger(passThreshold) || passThreshold < 1 || passThreshold > 100) {
    return { error: "The pass threshold must be a whole number between 1 and 100." };
  }

  // Checked before inserting so the message names the real problem. The unique
  // index still backstops a race.
  const [clash] = await db
    .select({ id: quizzes.id })
    .from(quizzes)
    .where(eq(quizzes.slug, slug))
    .limit(1);
  if (clash) {
    return { error: `A quiz already uses the address "${slug}". Choose another slug.` };
  }

  let created: { id: string } | undefined;
  try {
    [created] = await db
      .insert(quizzes)
      .values({
        slug,
        title,
        passThreshold,
        // INACTIVE until it has questions. /quizzes/[slug] serves active
        // quizzes only, so a learner cannot walk into an empty one.
        active: false,
      })
      .returning({ id: quizzes.id });
  } catch (err) {
    console.error("[admin.quiz.create] failed", err);
    return { error: "That quiz could not be created. Please try again." };
  }

  if (!created) return { error: "That quiz could not be created." };

  void recordAudit({
    action: "quiz.created",
    entityType: "quizzes",
    entityId: created.id,
    metadata: { slug, title, passThreshold },
  });

  revalidatePath("/admin/quizzes");
  // Straight to the editor: a quiz with no questions is not useful yet, and
  // this is where they are added.
  redirect(`/admin/quizzes/${created.id}`);
}
