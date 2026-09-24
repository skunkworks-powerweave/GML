"use server";

// Server actions for /admin/quizzes/[id].
// `saveQuizSchema` validates incoming JSON shape, replaces the quiz_questions
// rows in a transaction, and updates quiz metadata. Audits `quiz.schema.update`.

import { and, eq, gt } from "drizzle-orm";
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

  await db.transaction(async (tx) => {
    await tx.update(quizzes).set(updateSet).where(eq(quizzes.id, quizId));

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
    // HONEST LIMIT: reordering questions still repoints history, because
    // sequence is then the wrong identity. Fixing that properly means
    // versioning a quiz so past attempts keep the questions they were actually
    // asked, which is a schema change and a larger piece of work than this.
    // What this removes is the case where an unrelated edit destroys history.
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
      maxAttempts: updateSet.maxAttempts,
      active: updateSet.active,
    },
  });

  return { ok: true, questionCount: incoming.length };
}
