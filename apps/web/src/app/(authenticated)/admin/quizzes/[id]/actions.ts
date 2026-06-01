"use server";

// Server actions for /admin/quizzes/[id].
// `saveQuizSchema` validates incoming JSON shape, replaces the quiz_questions
// rows in a transaction, and updates quiz metadata. Audits `quiz.schema.update`.

import { eq } from "drizzle-orm";
import { db } from "@gml/db";
import { quizzes, quizQuestions } from "@gml/db/schema";
import { requireRole } from "@/lib/guards";
import { recordAudit } from "@/lib/audit";

type IncomingQuestion = {
  prompt: string;
  options: string[];
  correctIndex: number;
  explanation?: string | null;
};

type IncomingPayload = {
  title?: string;
  passThreshold?: number;
  active?: boolean;
  questions?: IncomingQuestion[];
};

export type SaveQuizResult =
  | { ok: true; questionCount: number }
  | { ok: false; error: string; message?: string };

/**
 * Save the quiz schema (metadata + replace-all questions).
 *
 *  - Validates JSON parses
 *  - Validates each question has prompt + options[] + correctIndex within bounds
 *  - Replaces quiz_questions for the quiz in a single transaction
 *  - Records `quiz.schema.update` audit with metadata
 */
export async function saveQuizSchema(
  quizId: string,
  rawJson: string,
): Promise<SaveQuizResult> {
  await requireRole(["programme_admin", "super_admin"]);

  let parsed: IncomingPayload;
  try {
    parsed = JSON.parse(rawJson) as IncomingPayload;
  } catch (e) {
    return { ok: false, error: "invalid_json", message: (e as Error).message };
  }

  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: "invalid_shape", message: "Payload must be an object." };
  }

  // Validate questions if present.
  const incoming = Array.isArray(parsed.questions) ? parsed.questions : [];
  for (let i = 0; i < incoming.length; i++) {
    const q = incoming[i];
    if (!q || typeof q !== "object") {
      return { ok: false, error: "invalid_question", message: `Question ${i + 1} is not an object.` };
    }
    if (typeof q.prompt !== "string" || q.prompt.trim().length === 0) {
      return {
        ok: false,
        error: "invalid_prompt",
        message: `Question ${i + 1} is missing a prompt.`,
      };
    }
    if (!Array.isArray(q.options) || q.options.length < 2) {
      return {
        ok: false,
        error: "invalid_options",
        message: `Question ${i + 1} must have at least 2 options.`,
      };
    }
    if (
      typeof q.correctIndex !== "number" ||
      !Number.isInteger(q.correctIndex) ||
      q.correctIndex < 0 ||
      q.correctIndex >= q.options.length
    ) {
      return {
        ok: false,
        error: "invalid_correct_index",
        message: `Question ${i + 1}'s correctIndex must be 0..${q.options.length - 1}.`,
      };
    }
  }

  // Load existing — ensures the row exists.
  const [existing] = await db
    .select()
    .from(quizzes)
    .where(eq(quizzes.id, quizId))
    .limit(1);
  if (!existing) {
    return { ok: false, error: "not_found" };
  }

  // Build the update set for metadata.
  const updateSet: Partial<typeof quizzes.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (typeof parsed.title === "string" && parsed.title.trim().length > 0) {
    updateSet.title = parsed.title.trim();
  }
  if (
    typeof parsed.passThreshold === "number" &&
    Number.isFinite(parsed.passThreshold) &&
    parsed.passThreshold >= 0 &&
    parsed.passThreshold <= 100
  ) {
    updateSet.passThreshold = Math.round(parsed.passThreshold);
  }
  if (typeof parsed.active === "boolean") {
    updateSet.active = parsed.active;
  }

  await db.transaction(async (tx) => {
    await tx.update(quizzes).set(updateSet).where(eq(quizzes.id, quizId));
    // Replace-all questions strategy: simpler than diffing, fine at v1 scale.
    await tx.delete(quizQuestions).where(eq(quizQuestions.quizId, quizId));
    if (incoming.length > 0) {
      await tx.insert(quizQuestions).values(
        incoming.map((q, i) => ({
          quizId,
          sequence: i + 1,
          prompt: q.prompt.trim(),
          options: q.options.map((o) => String(o)),
          correctIndex: q.correctIndex,
          explanation: q.explanation ?? null,
        })),
      );
    }
  });

  void recordAudit({
    action: "quiz.schema.update",
    entityType: "quizzes",
    entityId: quizId,
    metadata: {
      questionCount: incoming.length,
      title: updateSet.title,
      passThreshold: updateSet.passThreshold,
      active: updateSet.active,
    },
  });

  return { ok: true, questionCount: incoming.length };
}
