"use server";

// Server actions for /admin/grading: grading scales and observation rubrics.
//
// Each one checks the role (programme admin or super admin) before anything
// else, parses its form, and hands over to lib/grading/admin.ts -- which
// checks the role again, validates, writes in a transaction where it must,
// and audits. The answer goes back to the form as one sentence in the
// administrator's language (grading.errors.* / grading.done.*).

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { db } from "@gml/db";
import { requireRole } from "@/lib/guards";
import { actorFrom, type Actor } from "@/lib/visibility";
import { isUuid } from "@/lib/ids";
import {
  deleteRubric,
  deleteScale,
  saveBands,
  saveCriteria,
  saveRubric,
  saveScale,
  setDefaultRubric,
  setDefaultScale,
  setQuizScale,
  setRubricActive,
  setScaleActive,
  type GradingResult,
} from "@/lib/grading/admin";
import { formatRanges } from "@/lib/grading/format";
import type { FormState } from "./_ui/action-form";

const ADMIN_PATH = "/admin/grading";

async function adminActor(): Promise<Actor> {
  const session = await requireRole(["programme_admin", "super_admin"]);
  const actor = actorFrom(session);
  if (!actor) redirect("/login");
  return actor;
}

const text = (fd: FormData, key: string) => String(fd.get(key) ?? "");
const list = (fd: FormData, key: string) => fd.getAll(key).map((v) => String(v));

/** A refusal, as a sentence. */
async function refused(result: Extract<GradingResult<unknown>, { ok: false }>): Promise<FormState> {
  const t = await getTranslations("grading");
  return { ok: false, message: t(`errors.${result.error}`, result.detail ?? {}) };
}

async function done(key: string, values: Record<string, string | number> = {}): Promise<FormState> {
  const t = await getTranslations("grading");
  return { ok: true, message: t(`done.${key}`, values) };
}

function refresh(...paths: string[]) {
  revalidatePath(ADMIN_PATH);
  for (const p of paths) revalidatePath(p);
}

// ── Scales ───────────────────────────────────────────────────────────────────

export async function createScaleAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const actor = await adminActor();
  const result = await saveScale(db, actor, {
    name: text(fd, "name"),
    appliesTo: text(fd, "appliesTo"),
    description: text(fd, "description"),
  });
  if (!result.ok) return refused(result);
  refresh();
  redirect(`${ADMIN_PATH}/scales/${result.id}`);
}

export async function saveScaleDetailsAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const actor = await adminActor();
  const id = text(fd, "scaleId");
  if (!isUuid(id)) return refused({ ok: false, error: "not_found" });
  const result = await saveScale(db, actor, { id, name: text(fd, "name"), description: text(fd, "description") });
  if (!result.ok) return refused(result);
  refresh(`${ADMIN_PATH}/scales/${id}`);
  return done("saved");
}

export async function saveBandsAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const actor = await adminActor();
  const id = text(fd, "scaleId");
  if (!isUuid(id)) return refused({ ok: false, error: "not_found" });
  const labels = list(fd, "label");
  const mins = list(fd, "min");
  const maxes = list(fd, "max");
  const passes = list(fd, "pass");
  const bands = labels
    .map((label, i) => ({
      label,
      min: (mins[i] ?? "").trim(),
      max: (maxes[i] ?? "").trim(),
      pass: passes[i] !== "0",
    }))
    // A row left completely empty is not a band.
    .filter((b) => b.label.trim() || b.min || b.max)
    .map((b) => ({
      label: b.label,
      minPct: b.min === "" ? Number.NaN : Number(b.min),
      maxPct: b.max === "" ? Number.NaN : Number(b.max),
      isPass: b.pass,
    }));
  const result = await saveBands(db, actor, id, bands);
  if (!result.ok) return refused(result);
  refresh(`${ADMIN_PATH}/scales/${id}`);
  if (result.gaps.length || result.overlaps.length) {
    return done("bandsSavedProblems", {
      gaps: result.gaps.length ? formatRanges(result.gaps) : "—",
      overlaps: result.overlaps.length ? formatRanges(result.overlaps) : "—",
    });
  }
  return done("bandsSaved", { count: bands.length });
}

export async function setDefaultScaleAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const actor = await adminActor();
  const id = text(fd, "scaleId");
  if (!isUuid(id)) return refused({ ok: false, error: "not_found" });
  const result = await setDefaultScale(db, actor, id);
  if (!result.ok) return refused(result);
  refresh(`${ADMIN_PATH}/scales/${id}`);
  return done("defaultSet");
}

export async function setScaleActiveAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const actor = await adminActor();
  const id = text(fd, "scaleId");
  if (!isUuid(id)) return refused({ ok: false, error: "not_found" });
  const active = text(fd, "active") === "1";
  const result = await setScaleActive(db, actor, id, active);
  if (!result.ok) return refused(result);
  refresh(`${ADMIN_PATH}/scales/${id}`);
  return done(active ? "activated" : result.defaultCleared ? "deactivatedDefault" : "deactivated");
}

export async function deleteScaleAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const actor = await adminActor();
  const id = text(fd, "scaleId");
  if (!isUuid(id)) return refused({ ok: false, error: "not_found" });
  const result = await deleteScale(db, actor, id);
  if (!result.ok) return refused(result);
  refresh();
  redirect(`${ADMIN_PATH}?deleted=scale`);
}

// ── Rubrics ──────────────────────────────────────────────────────────────────

export async function createRubricAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const actor = await adminActor();
  const scaleId = text(fd, "gradingScaleId");
  const result = await saveRubric(db, actor, {
    name: text(fd, "name"),
    description: text(fd, "description"),
    gradingScaleId: isUuid(scaleId) ? scaleId : null,
    makeDefault: text(fd, "makeDefault") === "1",
  });
  if (!result.ok) return refused(result);
  refresh();
  redirect(`${ADMIN_PATH}/rubrics/${result.id}`);
}

export async function saveRubricDetailsAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const actor = await adminActor();
  const id = text(fd, "rubricId");
  if (!isUuid(id)) return refused({ ok: false, error: "not_found" });
  const scaleId = text(fd, "gradingScaleId");
  const result = await saveRubric(db, actor, {
    id,
    name: text(fd, "name"),
    description: text(fd, "description"),
    gradingScaleId: isUuid(scaleId) ? scaleId : null,
  });
  if (!result.ok) return refused(result);
  refresh(`${ADMIN_PATH}/rubrics/${id}`);
  return done("saved");
}

export async function saveCriteriaAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const actor = await adminActor();
  const id = text(fd, "rubricId");
  if (!isUuid(id)) return refused({ ok: false, error: "not_found" });
  const ids = list(fd, "criterionId");
  const titles = list(fd, "title");
  const descriptions = list(fd, "description");
  const maxes = list(fd, "maxScore");
  const criteria = titles
    .map((title, i) => ({
      id: isUuid(ids[i]) ? ids[i]! : null,
      title,
      description: descriptions[i] ?? "",
      max: (maxes[i] ?? "").trim(),
    }))
    .filter((c) => c.id || c.title.trim())
    .map((c) => ({ id: c.id, title: c.title, description: c.description, maxScore: c.max === "" ? Number.NaN : Number(c.max) }));
  const result = await saveCriteria(db, actor, id, criteria);
  if (!result.ok) return refused(result);
  refresh(`${ADMIN_PATH}/rubrics/${id}`);
  return done("criteriaSaved", { count: criteria.length });
}

export async function setDefaultRubricAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const actor = await adminActor();
  const id = text(fd, "rubricId");
  if (!isUuid(id)) return refused({ ok: false, error: "not_found" });
  const result = await setDefaultRubric(db, actor, id);
  if (!result.ok) return refused(result);
  refresh(`${ADMIN_PATH}/rubrics/${id}`);
  return done("rubricDefaultSet");
}

export async function setRubricActiveAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const actor = await adminActor();
  const id = text(fd, "rubricId");
  if (!isUuid(id)) return refused({ ok: false, error: "not_found" });
  const active = text(fd, "active") === "1";
  const result = await setRubricActive(db, actor, id, active);
  if (!result.ok) return refused(result);
  refresh(`${ADMIN_PATH}/rubrics/${id}`);
  return done(active ? "activated" : result.defaultCleared ? "rubricDeactivatedDefault" : "deactivated");
}

export async function deleteRubricAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const actor = await adminActor();
  const id = text(fd, "rubricId");
  if (!isUuid(id)) return refused({ ok: false, error: "not_found" });
  const result = await deleteRubric(db, actor, id);
  if (!result.ok) return refused(result);
  refresh();
  redirect(`${ADMIN_PATH}?deleted=rubric`);
}

// ── A quiz's scale (the admin quiz editor) ───────────────────────────────────

export async function setQuizScaleAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const actor = await adminActor();
  const quizId = text(fd, "quizId");
  if (!isUuid(quizId)) return refused({ ok: false, error: "not_found" });
  const scaleId = text(fd, "gradingScaleId");
  const result = await setQuizScale(db, actor, quizId, isUuid(scaleId) ? scaleId : null);
  if (!result.ok) return refused(result);
  revalidatePath(`/admin/quizzes/${quizId}`);
  return done("quizScaleSet");
}
