"use server";

// Server actions for /admin/quizzes/[id].
// `saveQuizSchema` validates incoming JSON shape, updates quiz metadata and --
// only when the payload carries a `questions` array -- rewrites the
// quiz_questions rows, in one transaction. Audits `quiz.schema.update`.

import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "@gml/db";
import { quizzes, quizQuestions, quizSubmissions } from "@gml/db/schema";
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
  // Attempts allowed per learner: `null` = unlimited, `undefined` = no
  // change, an integer 1..20 (the quizzes_max_attempts_range CHECK) = the
  // cap. The runner and submit action enforced a cap nothing could set --
  // this editor was the only admin surface for a quiz and did not accept it.
  maxAttempts?: number | null;
  active?: boolean;
  questions?: IncomingQuestion[];
};

export type SaveQuizResult =
  | { ok: true; questionCount: number }
  | { ok: false; error: string; message?: string };

/**
 * Save the quiz schema (metadata, and the questions when `questions` is sent).
 *
 *  - Validates JSON parses
 *  - Validates each question has prompt + options[] + correctIndex within bounds
 *  - Rewrites quiz_questions only when the payload has a `questions` array,
 *    in the same transaction as the metadata
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
  //
  // ABSENT MEANS "LEAVE THEM ALONE", NOT "DELETE THEM". An omitted array used
  // to be read as an empty one, so saving {"active": false} to take a quiz
  // offline deleted every question and reported "Saved · 0 questions" -- and
  // every past result's review lost the questions it answered.
  if (parsed.questions !== undefined && !Array.isArray(parsed.questions)) {
    return { ok: false, error: "invalid_questions", message: "questions must be an array." };
  }
  const replaceQuestions = Array.isArray(parsed.questions);
  const incoming = parsed.questions ?? [];
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

  // Emptying a quiz on purpose is still possible -- until learners have sat
  // it. After that it would leave their results with nothing to review, and
  // switching the quiz off ("active": false) is what taking it down means.
  if (replaceQuestions && incoming.length === 0) {
    const [sat] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(quizSubmissions)
      .where(eq(quizSubmissions.quizId, quizId));
    if ((sat?.n ?? 0) > 0) {
      return {
        ok: false,
        error: "questions_in_use",
        message:
          'Learners have already submitted this quiz, so its questions cannot all be removed. Set "active": false to take it offline.',
      };
    }
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
  if (parsed.maxAttempts === null) {
    updateSet.maxAttempts = null;
  } else if (parsed.maxAttempts !== undefined) {
    if (
      typeof parsed.maxAttempts !== "number" ||
      !Number.isInteger(parsed.maxAttempts) ||
      parsed.maxAttempts < 1 ||
      parsed.maxAttempts > 20
    ) {
      return {
        ok: false,
        error: "invalid_max_attempts",
        message: "maxAttempts must be null (unlimited) or a whole number between 1 and 20.",
      };
    }
    updateSet.maxAttempts = parsed.maxAttempts;
  }
  if (typeof parsed.active === "boolean") {
    updateSet.active = parsed.active;
  }

  const questionCount = await db.transaction(async (tx) => {
    await tx.update(quizzes).set(updateSet).where(eq(quizzes.id, quizId));

    // Settings only: report the questions the quiz still has.
    if (!replaceQuestions) {
      const [kept] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(quizQuestions)
        .where(eq(quizQuestions.quizId, quizId));
      return kept?.n ?? 0;
    }

    // UPDATE IN PLACE BY SEQUENCE. NOT delete-all-then-insert.
    //
    // The previous "replace-all questions strategy: simpler than diffing, fine
    // at v1 scale" was not fine at any scale, because the rows it discarded
    // were still referenced. Every quiz_submissions.answers blob stores a
    // questionId, and a delete-and-reinsert mints fresh UUIDs for every
    // question -- so saving ANY edit, even a typo fix in the title, silently
    // orphaned the answers of every attempt ever submitted against that quiz.
    // The learner's score stays correct (it is stored), but the per-question
    // review can no longer resolve what was asked.
    //
    // Keying on `sequence` keeps the row -- and therefore the id -- stable for
    // questions that still exist at the same position. Only genuinely new
    // positions are inserted and only genuinely removed tail positions are
    // deleted.
    //
    // Reordering, inserting or rewording still rewrites these rows by
    // position, so they are not history. History is the question snapshot
    // each submission now carries (migration 0030): the result page reads
    // what the learner was asked from there, not from these rows.
    const existing = await tx
      .select({ id: quizQuestions.id, sequence: quizQuestions.sequence })
      .from(quizQuestions)
      .where(eq(quizQuestions.quizId, quizId));
    const idBySequence = new Map(existing.map((r) => [r.sequence, r.id]));

    for (let i = 0; i < incoming.length; i++) {
      const q = incoming[i]!;
      const sequence = i + 1;
      const values = {
        prompt: q.prompt.trim(),
        options: q.options.map((o) => String(o)),
        correctIndex: q.correctIndex,
        explanation: q.explanation ?? null,
      };
      const existingId = idBySequence.get(sequence);
      if (existingId) {
        await tx.update(quizQuestions).set(values).where(eq(quizQuestions.id, existingId));
      } else {
        await tx.insert(quizQuestions).values({ quizId, sequence, ...values });
      }
    }

    // Questions removed from the end of the quiz.
    if (existing.length > incoming.length) {
      await tx
        .delete(quizQuestions)
        .where(and(eq(quizQuestions.quizId, quizId), gt(quizQuestions.sequence, incoming.length)));
    }
    return incoming.length;
  });

  void recordAudit({
    action: "quiz.schema.update",
    entityType: "quizzes",
    entityId: quizId,
    metadata: {
      questionCount,
      // Whether this save rewrote the questions or only the settings.
      questionsReplaced: replaceQuestions,
      title: updateSet.title,
      passThreshold: updateSet.passThreshold,
      // Spec 159 — record the time-limit change in audit. `undefined`
      // means the editor didn't touch the field; the audit reader can
      // tell "explicitly set to null (untimed)" from "left as-is" by
      // this key being present at all (the key is dropped from the
      // metadata when undefined per JSON serialization rules).
      timeLimitSeconds: updateSet.timeLimitSeconds,
      maxAttempts: updateSet.maxAttempts,
      active: updateSet.active,
    },
  });

  return { ok: true, questionCount };
}
