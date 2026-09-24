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
//
// The validation and INSERT live in ./create-quiz.ts, which takes the database
// as an argument so the behaviour suite can run it against Postgres.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@gml/db";
import { requireRole } from "@/lib/guards";
import { recordAudit } from "@/lib/audit";
import { createQuiz } from "./create-quiz";

export type CreateQuizState = { error?: string } | undefined;

export async function createQuizAction(
  _prev: CreateQuizState,
  formData: FormData,
): Promise<CreateQuizState> {
  await requireRole(["programme_admin", "super_admin"]);

  const created = await createQuiz(db, {
    title: String(formData.get("title") ?? ""),
    slug: String(formData.get("slug") ?? ""),
    passThreshold: String(formData.get("passThreshold") ?? "60"),
    rttSubjectId: String(formData.get("rttSubjectId") ?? ""),
  });
  if (!created.ok) return { error: created.error };

  void recordAudit({
    action: "quiz.created",
    entityType: "quizzes",
    entityId: created.id,
    metadata: {
      slug: created.slug,
      title: created.title,
      passThreshold: created.passThreshold,
      rttSubjectId: created.rttSubjectId,
    },
  });

  revalidatePath("/admin/quizzes");
  // Straight to the editor: a quiz with no questions is not useful yet, and
  // this is where they are added.
  redirect(`/admin/quizzes/${created.id}`);
}
