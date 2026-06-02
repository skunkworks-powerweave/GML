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
  // Spec 159 — Workflow Run 15 audit-closure MISS: optional per-attempt
  // time limit. `null` = explicit "untimed" (the editor can flip a timed
  // quiz back to untimed by sending null). `undefined` = field omitted
  // (no change to the existing value). A finite integer between 60 and
  // 7200 = the new time limit in seconds.
  timeLimitSeconds?: number | null;
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
  // Spec 159 — timeLimitSeconds validation mirrors the DB CHECK
  // constraint (60..7200) so the editor refuses the same set of values
  // Postgres would refuse. `null` explicitly clears any existing limit;
  // an out-of-range number returns an editor error instead of silently
  // dropping the field (which would have surprised the editor — "I sent
  // 30 and the save said OK but the field still shows 600").
  if (parsed.timeLimitSeconds === null) {
    updateSet.timeLimitSeconds = null;
  } else if (parsed.timeLimitSeconds !== undefined) {
    if (
      typeof parsed.timeLimitSeconds !== "number" ||
      !Number.isFinite(parsed.timeLimitSeconds) ||
      !Number.isInteger(parsed.timeLimitSeconds) ||
      parsed.timeLimitSeconds < 60 ||
      parsed.timeLimitSeconds > 7200
    ) {
      return {
        ok: false,
        error: "invalid_time_limit",
        message:
          "timeLimitSeconds must be null (untimed) or an integer between 60 (1 min) and 7200 (2 h).",
      };
    }
    updateSet.timeLimitSeconds = parsed.timeLimitSeconds;
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
      // Spec 159 — record the time-limit change in audit. `undefined`
      // means the editor didn't touch the field; the audit reader can
      // tell "explicitly set to null (untimed)" from "left as-is" by
      // this key being present at all (the key is dropped from the
      // metadata when undefined per JSON serialization rules).
      timeLimitSeconds: updateSet.timeLimitSeconds,
      active: updateSet.active,
    },
  });

  return { ok: true, questionCount: incoming.length };
}
