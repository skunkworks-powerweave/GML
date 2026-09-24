// /forms/[slug] — universal feedback-form runner. Spec 074 (Phase 8).
//
// Slug format: `${kind}-${audience}-${version}`. There is no `slug` column on
// `feedback_forms`; the route resolves the URL through the existing
// (kind, audience, version) unique index. See specs/074-forms-runner/research.md.
//
// The runner is a server component; the only client surface is <FormRenderer>
// (spec 072), which owns autosave + field rendering. `submitFormAction` is a
// top-level `"use server"` action this file owns; it inserts into
// `feedback_responses`, deletes the matching draft, and fires `form.submit`
// audit, then redirects to /forms/[slug]/thanks.
//
// Spec 155 — the runner now enforces an audience-vs-role gate BEFORE
// rendering. Any logged-in user used to be able to GET /forms/<slug> regardless
// of whether the form targeted their role; in particular a `teacher` could
// open a mentor-only baseline form and start typing into it (the autosave
// would land but the draft would never reach the right pairing). The runner
// now maps `feedback_forms.audience` → required RoleName and redirects to
// /forbidden + audits `form.access.denied` on mismatch. The audience enum is
// `mentor | mentee`; `mentee` maps to the `teacher` role because in this
// codebase a mentee IS the classroom teacher being mentored.

import { redirect } from "next/navigation";
import Link from "next/link";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@gml/db";
import {
  feedbackForms,
  feedbackResponses,
  formDrafts,
  mentorPairings,
  type FeedbackForm,
} from "@gml/db/schema";

import { auth } from "@/auth";
import { actorFrom, assertCanAccessPairing } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { assertSectionGate } from "@/lib/gates";
import {
  validateResponses,
  audienceAllows,
  type FormField,
  type FormFieldOption,
} from "@/lib/forms/validate";
import { decodeFormSlug, formRunnerHref } from "@/lib/forms/catalogue-links";
import { templateDraftWhere } from "@/lib/forms/drafts";
import { isQuarterlyForm, QUARTER_AFTER } from "@/lib/forms/quarterly";
import { parseFormSchema } from "@/lib/forms/schema";
import { getDeviceType } from "@/lib/device";
import type { RoleName } from "@gml/shared/auth/roles";
import { FormRenderer } from "@/components/forms/FormRenderer";
// Spec 133 — Mobile runner is a drop-in replacement for FormRenderer when
// the device cookie reports a touch device. Same prop contract, same server
// action, same autosave pipeline; only the layout changes (one field per
// screen, big touch targets, sticky Prev/Next, review screen at the end).
import { MobileFormRunner } from "@/components/forms/MobileFormRunner";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Slug parsing — `${kind}-${audience}-${version}`.
//
// `kind` is a fixed enum (baseline | progress_1 | progress_2 | final).
// `audience` is a fixed enum (mentor | mentee).
// `version` is free-form (e.g. "1", "schoolvisit-1", "endline-1") and may
//   itself contain dashes — so we split on the first two dashes only.
// ---------------------------------------------------------------------------

type FeedbackKind = "baseline" | "progress_1" | "progress_2" | "final";
type FeedbackAudience = "mentor" | "mentee";

const KINDS: readonly FeedbackKind[] = ["baseline", "progress_1", "progress_2", "final"] as const;
const AUDIENCES: readonly FeedbackAudience[] = ["mentor", "mentee"] as const;

function parseSlug(
  slug: string,
): { kind: FeedbackKind; audience: FeedbackAudience; version: string } | null {
  // progress_1-mentor-1 → ["progress_1", "mentor", "1"]
  // baseline-mentor-schoolvisit-1 → ["baseline", "mentor", "schoolvisit-1"]
  const firstDash = slug.indexOf("-");
  if (firstDash < 0) return null;
  const kindRaw = slug.slice(0, firstDash);
  const rest = slug.slice(firstDash + 1);
  const secondDash = rest.indexOf("-");
  if (secondDash < 0) return null;
  const audienceRaw = rest.slice(0, secondDash);
  const versionRaw = rest.slice(secondDash + 1);
  if (!KINDS.includes(kindRaw as FeedbackKind)) return null;
  if (!AUDIENCES.includes(audienceRaw as FeedbackAudience)) return null;
  if (versionRaw.length === 0) return null;
  return {
    kind: kindRaw as FeedbackKind,
    audience: audienceRaw as FeedbackAudience,
    version: versionRaw,
  };
}

// ---------------------------------------------------------------------------
// Schema shape — feedback_forms.schema is `jsonb`. The seed scripts
// (packages/db/src/scripts/seed_forms_*.ts) write objects shaped like this.
// We don't validate exhaustively here; we render whatever the renderer is
// happy to take.
// ---------------------------------------------------------------------------

type FormSchemaShape = {
  title?: string;
  hindiTitle?: string;
  description?: string;
  fields?: Array<{
    name: string;
    kind: string;
    label?: string;
    hindiLabel?: string;
    required?: boolean;
    // Strings OR {value,label,hindiLabel} objects -- seed_forms_mentee.ts writes
    // the latter. Declaring `string[]` here let the `as FormField[]` cast below
    // hide that validate.ts compared submitted values against object
    // references, which made the mentee final form unsubmittable.
    options?: string[] | Array<Extract<FormFieldOption, object> & { label: string }>;
    min?: number;
    max?: number;
    helpText?: string;
  }>;
  // schoolvisit/endline carry a "purpose" key in addition to kind+audience.
  purpose?: string;
};

// Checked, not cast: a stored `{"fields": {...}}` used to reach
// `(schema.fields ?? []).map(...)` and 500 the runner for every user. null
// means the stored schema is not one the renderers can draw
// (lib/forms/schema.ts); the page shows BrokenFormShell and the action refuses.
function readSchema(form: FeedbackForm): FormSchemaShape | null {
  return parseFormSchema(form.schema) as FormSchemaShape | null;
}

// ---------------------------------------------------------------------------
// Spec 155 — audience-vs-role gate.
//
// `feedback_forms.audience` is the closed enum {mentor, mentee} (see
// packages/db/src/schema/enums.ts::feedbackAudienceEnum). The runner used to
// accept any logged-in user — a `teacher` could open a mentor-only baseline
// form and start typing, an `observer` could autosave drafts against forms
// they are never supposed to fill, etc. We now map each audience to the
// closed set of RoleNames that may render the runner and redirect to
// /forbidden + audit `form.access.denied` on mismatch.
//
// `mentee` maps to `teacher` because in this codebase the mentee IS the
// classroom teacher being mentored (the schema names the relationship
// `mentor_pairings.mentee_user_id` even though the user record's role is
// "teacher"). The audience enum does not include a "programme" slot in the
// shipped schema; the gate carries an explicit branch for it so the runner
// stays open if a future migration adds it (or if a partially-typed form
// somehow lands with `audience: undefined`).
// ADMINS ARE ADMITTED, because the submit path already admits them and the two
// halves disagreeing is the bug.
//
// The READ gate listed only the audience's own role, so a programme_admin or
// super_admin opening any form was redirected to /forbidden and an audit row
// was written accusing them of a denied access. The SUBMIT path has always
// taken the opposite view -- audienceAllows() in lib/forms/validate.ts returns
// true for both admin roles, and assertCanAccessPairing() returns early for
// them -- so the same account was allowed to POST a form it was forbidden to
// GET.
//
// It also made the whole runner untestable by the only account that exists on
// a fresh deployment, and made the quarter strip on /mentorship/[pairingId]
// look broken: every link on it led straight to /forbidden.
//
// Admins reading a form is the correct behaviour anyway -- they administer the
// catalogue and answer questions about it.
const ADMIN_ROLES: RoleName[] = ["programme_admin", "super_admin"];
const AUDIENCE_ALLOWED_ROLES: Record<string, RoleName[] | "any"> = {
  mentor: ["mentor", ...ADMIN_ROLES],
  mentee: ["teacher", ...ADMIN_ROLES],
  programme: "any",
};

function isAudienceAccessAllowed(
  audience: string | null | undefined,
  role: RoleName | string | undefined,
): boolean {
  // Unknown / null / undefined audience → treat as "any authenticated user".
  if (!audience) return true;
  const allowed = AUDIENCE_ALLOWED_ROLES[audience];
  if (allowed === undefined) return true; // future audience enum we don't gate yet
  if (allowed === "any") return true;
  return !!role && (allowed as RoleName[]).includes(role as RoleName);
}

// ---------------------------------------------------------------------------
// Server action — wired into FormRenderer via `action={submitFormAction}`.
// Catalogue links must pass `?pairingId=...` so the response carries the
// schema-mandated FK; missing pairingId redirects back to the same slug with
// `?error=missing_pairing`.
// ---------------------------------------------------------------------------

// Spec 130 — allowed context keys threaded through from
// `?cycleId=…&quarter=2&observerId=…&kind=…` into hidden FormRenderer inputs
// and back here. The set is closed; we never trust an arbitrary `__ctx_*` key
// on the way back. The prefix `__ctx_` keeps these slots separate from real
// schema field names so they cannot collide with seeded answer fields.
const CONTEXT_KEYS = ["cycleId", "quarter", "observerId", "kind"] as const;
type ContextKey = (typeof CONTEXT_KEYS)[number];

// Quarter is a numeric enum 1..4 — anything outside that range is dropped so
// we never persist a malformed audit row from a tampered query string.
// cycle/observer IDs and kind are gated on a safe character class to keep
// HTML-injection or audit-log poisoning impossible.
function sanitizeContextValue(key: ContextKey, raw: string): string | null {
  const v = raw.trim();
  if (v.length === 0) return null;
  if (v.length > 64) return null;
  if (key === "quarter") {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 4) return null;
    return String(n);
  }
  if (key === "kind") {
    if (!/^[\w.-]+$/.test(v)) return null;
    return v;
  }
  // cycleId, observerId
  if (!/^[a-zA-Z0-9_-]+$/.test(v)) return null;
  return v;
}

export async function submitFormAction(formData: FormData): Promise<void> {
  "use server";

  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = session.user.id;

  const formId = String(formData.get("__formId") ?? "").trim();
  const slug = String(formData.get("__slug") ?? "").trim();
  // pairingId arrives in the POST BODY and is written straight to
  // feedback_responses.pairing_id, so without a check any authenticated user
  // could file feedback against any mentorship pairing -- and, on the read path
  // below, prefill the form with another pairing's previously submitted answers.
  const pairingId = String(formData.get("__pairingId") ?? "").trim();

  if (!formId || !slug) {
    redirect(`/inbox?error=invalid_form_submit`);
  }
  if (!pairingId) {
    redirect(`/forms/${slug}?error=missing_pairing`);
  }

  // OWNERSHIP GATE on the write path. The read path below is already scoped by
  // respondentUserId, so it only ever surfaces the caller's own prior answers --
  // but the INSERT took pairingId from the body unchecked, so any authenticated
  // user could file mentorship feedback against any pairing in the programme.
  const actor = actorFrom(session);
  if (!actor) redirect("/login");
  // SECTION GATE, asserted in the action for the reason every /mentorship
  // action asserts it: a server action runs before any layout renders, and a
  // gate that guards reading and not writing does not meet the requirement.
  // This form files mentorship feedback and advances the pairing's quarter,
  // and it lives outside /mentorship, so nothing else asked for the password.
  await assertSectionGate(actor.id, "mentorship", formRunnerHref(slug, pairingId));
  await assertCanAccessPairing(actor, pairingId);

  // Pull the form back so we know which field ids to accept. Drop unknown keys.
  const [form] = await db
    .select()
    .from(feedbackForms)
    .where(eq(feedbackForms.id, formId))
    .limit(1);
  if (!form || !form.active) {
    redirect(`/inbox?error=form_not_found`);
  }

  const schema = readSchema(form);
  if (!schema) redirect(`${formRunnerHref(slug, pairingId)}&error=form_broken`);
  const fieldIds = new Set((schema.fields ?? []).map((f) => f.name));

  // Spec 130 — pick up the context hidden inputs the renderer planted on the
  // way out. We never trust the client to send a key outside CONTEXT_KEYS.
  const context: Record<string, string> = {};
  for (const key of CONTEXT_KEYS) {
    const raw = formData.get(`__ctx_${key}`);
    if (typeof raw !== "string") continue;
    const sanitized = sanitizeContextValue(key, raw);
    if (sanitized !== null) context[key] = sanitized;
  }

  const responses: Record<string, unknown> = {};
  for (const [key, value] of formData.entries()) {
    if (key.startsWith("__")) continue; // internal pairs we own
    // Strip the trailing `[]` repeated-checkbox suffix on the way in.
    const cleanKey = key.endsWith("[]") ? key.slice(0, -2) : key;
    if (!fieldIds.has(cleanKey)) continue;
    const existing = responses[cleanKey];
    if (existing === undefined) {
      responses[cleanKey] = typeof value === "string" ? value : String(value);
    } else if (Array.isArray(existing)) {
      existing.push(typeof value === "string" ? value : String(value));
    } else {
      responses[cleanKey] = [String(existing), typeof value === "string" ? value : String(value)];
    }
  }

  // ── SERVER-SIDE VALIDATION ─────────────────────────────────────────────────
  //
  // Until now the only check on the answers was the field-NAME filter above:
  // `required`, `min`, `max`, `options` and `kind` were declared in the schema,
  // rendered by the client, and consulted by no server code. A submission with
  // every field blank persisted. So did a radio value outside its options, a
  // number outside its range, and an unbounded string.
  //
  // The client's `required` and `min` attributes are a convenience for the
  // person filling the form in. They are removable in devtools and absent
  // entirely from a direct POST to this server action, which is a URL.
  const audience = String(form.audience);
  if (!audienceAllows(session.user.role, audience)) {
    // The GET path already checked this. A server action is a SEPARATE entry
    // point, and posting to it directly skipped the gate.
    redirect(`/forms/${slug}?error=wrong_audience`);
  }

  const errors = validateResponses((schema.fields ?? []) as FormField[], responses);
  if (errors.length > 0) {
    const summary = errors
      .slice(0, 3)
      .map((e) => e.message)
      .join(" ");
    // KEEP THE PAIRING. This redirect used to drop it, so the page came back
    // with no pairingId and the corrected resubmission was refused as
    // missing_pairing -- one wrong answer turned into a dead end. pairingId
    // was already checked by assertCanAccessPairing above.
    redirect(
      `${formRunnerHref(slug, pairingId)}&error=invalid&detail=${encodeURIComponent(summary)}`,
    );
  }

  // Which quarter a pairing moves INTO once this form kind is submitted.
  // baseline closes Q1, progress_1 closes Q2, progress_2 closes Q3. `final`
  // is absent deliberately: it closes the pairing rather than opening a
  // quarter, and completePairingAction owns that transition.
  //
  // Spec 130 — persist the context block alongside the user-supplied answers.
  // Using a __context key (double-underscore prefix is already reserved above)
  // keeps the schema locked (no new column) while still letting reports join
  // responses back to an observation_cycle / quarter / observer downstream.
  if (Object.keys(context).length > 0) {
    responses.__context = context;
  }

  let newResponseId = "";
  await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(feedbackResponses)
      .values({
        formId: form.id,
        pairingId,
        respondentUserId: userId,
        responses,
      })
      .returning({ id: feedbackResponses.id });
    newResponseId = inserted?.id ?? "";

    // Clear the autosave draft for this user, template AND PAIRING. Keyed by
    // user+template alone, submitting one mentee's form deleted the unfinished
    // draft about every other mentee of the same mentor.
    await tx.delete(formDrafts).where(templateDraftWhere(userId, form.id, pairingId));

    // ADVANCE THE PAIRING'S QUARTER.
    //
    // mentor_pairings.current_quarter drives the entire quarter strip on
    // /mentorship/[pairingId] -- which card is "done", which is "current",
    // which is "future" and therefore unclickable -- and it was written by
    // NOTHING except the development seed. So every real pairing sat at Q1
    // forever: Q2, Q3 and Q4 never became reachable, and the quarterly
    // feedback cycle that is the point of the mentorship module could not be
    // worked through at all.
    //
    // Submitting the quarter's form is the event that closes it, so that is
    // where the advance belongs. GREATEST() rather than a plain assignment
    // because re-submitting an earlier quarter's form must never walk the
    // pairing backwards, and it makes concurrent submissions safe without a
    // read-modify-write. Capped at 4: there is no Q5.
    //
    // ONLY A QUARTERLY FORM closes a quarter. The School visit checklist is
    // stored as kind 'baseline' (feedback_kind has no value of its own for it)
    // and advanced the pairing to Q2 when submitted, though it is a repeatable
    // field-visit form; lib/forms/quarterly.ts.
    //
    // AND ONLY THE MENTOR'S. The pairing page's own rule is "Mentor must
    // complete [the] feedback form at the end of each quarter ... Closes the
    // quarter on submit". This advanced on the first submission of the kind by
    // ANYONE: the mentee's baseline closed Q1 before the mentor had filled
    // hers, which then stopped being asked for, and an administrator's
    // submission closed it too. assertCanAccessPairing above means a mentor
    // here is this pairing's mentor.
    if (pairingId && isQuarterlyForm(form.schema) && form.audience === "mentor" && actor.role === "mentor") {
      const nextQuarter = QUARTER_AFTER[form.kind];
      if (nextQuarter) {
        await tx
          .update(mentorPairings)
          .set({
            currentQuarter: sql`LEAST(GREATEST(COALESCE(${mentorPairings.currentQuarter}, 1), ${nextQuarter}), 4)`,
          })
          .where(eq(mentorPairings.id, pairingId));
      }
    }
  });

  // Best-effort audit (failure does not roll back the response). The audit
  // payload mirrors the persisted context so reviewers can filter the log by
  // observation_cycle / quarter without reading responses jsonb.
  void recordAudit({
    action: "form.submit",
    entityType: "feedback_response",
    entityId: newResponseId,
    metadata: {
      formId: form.id,
      kind: form.kind,
      audience: form.audience,
      version: form.version,
      ...context,
    },
  });

  // With the pairing, so the thank-you card can link back to it and to its
  // read-only record of submitted feedback.
  redirect(`/forms/${slug}/thanks?pairingId=${encodeURIComponent(pairingId)}`);
}

// ---------------------------------------------------------------------------
// Page.
// ---------------------------------------------------------------------------

export default async function FormRunnerPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  // Spec 130 — catalogue links pass arbitrary contextual params alongside
  // pairingId: cycleId/quarter/observerId/kind let the runner route a single
  // response back to the right observation_cycle / mentor quarter / observer;
  // prefill_<field> seeds scalar fields with sensible defaults (mentor name,
  // school name, etc.) so the user is not retyping context they already supplied.
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = session.user.id;

  // Decoded: Next passes the segment still percent-encoded (decodeFormSlug).
  const slug = decodeFormSlug((await params).slug);
  const sp = await searchParams;
  // Spec 133 — pick renderer by device cookie. Mobile gets one-field-per-screen
  // with sticky Prev/Next + review; desktop keeps the stacked FormRenderer.
  const device = await getDeviceType();

  // Helper — coerce string-or-string-array searchParams to a single trimmed
  // string. URL `?pairingId=a&pairingId=b` collapses to "a" (first wins) to
  // match Next.js' own behaviour on duplicate keys.
  const readParam = (raw: string | string[] | undefined): string => {
    if (typeof raw === "string") return raw.trim();
    if (Array.isArray(raw)) return (raw[0] ?? "").trim();
    return "";
  };

  const pairingId = readParam(sp.pairingId);
  const error = readParam(sp.error);
  // The validator's own summary, echoed back by the ?error=invalid redirect.
  // Rendered as text inside JSX, so it cannot inject markup.
  const errorDetail = readParam(sp.detail);

  const parsed = parseSlug(slug);
  if (!parsed) return <NotFoundShell slug={slug} />;

  const [form] = await db
    .select()
    .from(feedbackForms)
    .where(
      and(
        eq(feedbackForms.kind, parsed.kind),
        eq(feedbackForms.audience, parsed.audience),
        eq(feedbackForms.version, parsed.version),
        eq(feedbackForms.active, true),
      ),
    )
    .limit(1);
  if (!form) return <NotFoundShell slug={slug} />;

  // Spec 155 — audience-vs-role gate. A `teacher` opening a mentor-only form
  // (or vice versa) is bounced to /forbidden and the denial is audited so a
  // pattern of attempts surfaces in the audit log. We log BEFORE redirecting
  // because `redirect()` throws; `void recordAudit(...)` is fire-and-forget by
  // contract so the throw cannot swallow the audit.
  const sessionRole: RoleName | undefined = (session.user.role ?? undefined) as
    | RoleName
    | undefined;
  if (!isAudienceAccessAllowed(form.audience, sessionRole)) {
    void recordAudit({
      action: "form.access.denied",
      entityType: "feedback_form",
      entityId: form.id,
      metadata: {
        slug,
        requiredAudience: form.audience,
        role: sessionRole ?? null,
      },
    });
    redirect("/forbidden");
  }

  // A FORM ABOUT A PAIRING IS MENTORSHIP DATA. The runner pre-fills what this
  // user last wrote about the mentee, and it sat outside /mentorship, whose
  // layout is where the section password is asked -- so a borrowed session read
  // a mentor's assessments of every mentee without the password. Asked here,
  // before anything about the pairing is read, returning to this form once
  // unlocked. assertCanAccessPairing then 404s a pairing that is malformed,
  // absent or someone else's, which used to render the whole fillable form
  // (and, for a truncated id, a Postgres 22P02 as HTTP 500).
  if (pairingId) {
    const actor = actorFrom(session);
    if (!actor) redirect("/login");
    await assertSectionGate(userId, "mentorship", formRunnerHref(slug, pairingId));
    await assertCanAccessPairing(actor, pairingId);
  }

  // THE DRAFT FOR THIS PAIRING. Selected by user+template alone, a mentor's
  // half-written answers about one mentee loaded -- as "Draft loaded" -- into
  // the same form for every other mentee, and outranked that mentee's own
  // prior response below. See lib/forms/drafts.ts.
  const [draft] = await db
    .select({ responses: formDrafts.responses, updatedAt: formDrafts.updatedAt })
    .from(formDrafts)
    .where(templateDraftWhere(userId, form.id, pairingId || null))
    .limit(1);

  // Spec 131-A — prior-response prefill.
  //
  // If the same user has already submitted this template against the same
  // pairing, surface those answers as the starting point. Drafts (in-progress
  // edits) still take priority — they're newer than the persisted response.
  // The query is keyed by (formId, respondentUserId, pairingId), all of which
  // are indexable on feedback_responses; ordering by submittedAt DESC + limit
  // 1 picks the most recent canonical answer if multiple exist (re-takes).
  let priorResponses: Record<string, unknown> | null = null;
  if (pairingId) {
    const [prior] = await db
      .select({ responses: feedbackResponses.responses })
      .from(feedbackResponses)
      .where(
        and(
          eq(feedbackResponses.formId, form.id),
          eq(feedbackResponses.respondentUserId, userId),
          eq(feedbackResponses.pairingId, pairingId),
        ),
      )
      .orderBy(desc(feedbackResponses.submittedAt))
      .limit(1);
    priorResponses = (prior?.responses as Record<string, unknown> | undefined) ?? null;
  }

  const schema = readSchema(form);
  if (!schema) return <BrokenFormShell slug={slug} />;
  const fieldNames = new Set((schema.fields ?? []).map((f) => f.name));

  // Spec 130 — extract the closed context set from the query string. Anything
  // outside the closed set is dropped on the floor here (defence in depth —
  // the server action re-sanitizes on submit). Each kept value becomes a
  // hidden `__ctx_<key>` input the renderer plants in the form.
  const context: Record<string, string> = {};
  for (const key of CONTEXT_KEYS) {
    const raw = readParam(sp[key]);
    const sanitized = raw ? sanitizeContextValue(key, raw) : null;
    if (sanitized !== null && sanitized !== "") context[key] = sanitized;
  }

  // Spec 130 — scalar field prefill via `?prefill_<fieldName>=value`. We only
  // honour prefill keys whose `<fieldName>` matches a known schema field — any
  // unknown key is dropped on the floor here so a crafted URL cannot inject a
  // surprise hidden input via FormRenderer. Drafts and prior submissions
  // still win because they reflect work-in-progress, not pre-context.
  const prefill: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(sp)) {
    if (!rawKey.startsWith("prefill_")) continue;
    const fieldName = rawKey.slice("prefill_".length);
    if (!fieldNames.has(fieldName)) continue;
    const value = readParam(rawValue);
    if (value.length === 0) continue;
    if (value.length > 256) continue; // sanity cap on per-field length
    prefill[fieldName] = value;
  }

  const draftResponses = draft?.responses as Record<string, unknown> | undefined;
  const baseResponses =
    draftResponses ??
    priorResponses ??
    {};

  // Layer prefill UNDER baseResponses so a draft / prior response always wins
  // — prefill is a starting hint, never an override of work the user has
  // already committed to. Only keys not already present in baseResponses pick
  // up the prefill value.
  const initialResponses: Record<string, unknown> = { ...baseResponses };
  for (const [name, value] of Object.entries(prefill)) {
    if (initialResponses[name] === undefined || initialResponses[name] === "") {
      initialResponses[name] = value;
    }
  }

  const title = schema.title ?? `${parsed.kind.replace("_", " ")} · ${parsed.audience}`;
  const hindiTitle = schema.hindiTitle;
  const description = schema.description;

  return (
    <div>
      <div className="page-header">
        <Link
          href="/inbox"
          className="btn btn-sm btn-ghost"
          style={{ marginBottom: 6, textDecoration: "none" }}
        >
          ← Inbox
        </Link>
        <div className="label">
          Form · {parsed.kind.replace("_", " ")} · {parsed.audience}
        </div>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: 26, marginTop: 4, lineHeight: 1.2 }}>
          {title}
          {hindiTitle ? (
            <span
              style={{
                fontFamily: "var(--deva)",
                color: "var(--ink-3)",
                marginLeft: 10,
                fontSize: 20,
              }}
            >
              {hindiTitle}
            </span>
          ) : null}
        </h1>
        {description ? (
          <p style={{ color: "var(--ink-3)", marginTop: 4 }}>{description}</p>
        ) : null}

        <div
          style={{
            display: "flex",
            gap: 6,
            alignItems: "center",
            marginTop: 12,
            flexWrap: "wrap",
          }}
        >
          <span
            className="chip"
            style={{
              fontFamily: "var(--mono)",
              background: "var(--paper-2)",
              textTransform: "uppercase",
            }}
          >
            v{form.version}
          </span>
          {draft ? (
            <span className="chip chip-lichen">
              Draft loaded · saved{" "}
              <span className="mono">
                {new Date(draft.updatedAt).toLocaleString("en-IN", {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </span>
            </span>
          ) : (
            <span className="chip">No draft yet</span>
          )}
        </div>
      </div>

      <div className="page-body" style={{ maxWidth: 760, margin: "0 auto" }}>
        {/* EVERY ?error= THE ACTION CAN ISSUE IS RENDERED HERE.
            Only `missing_pairing` had a branch. submitFormAction also redirects
            back with `wrong_audience` and with `invalid&detail=...` -- the
            latter carrying the precise server-side validation summary -- and
            both landed on a page that rendered nothing at all. A rejected
            submission simply redisplayed the empty form, so the user could not
            tell a refusal from a reload and had no way to learn which answer
            was at fault. `detail` is the summary the validator produced; it is
            rendered as text, never as markup. */}
        {error ? (
          <div
            style={{
              background: "var(--rust-soft)",
              color: "var(--rust)",
              border: "1px solid var(--rust)",
              borderRadius: "var(--r-2)",
              padding: 12,
              fontSize: 13,
              marginBottom: 16,
            }}
            role="alert"
            data-testid="form-error"
            data-error={error}
          >
            {error === "missing_pairing" ? (
              <>
                {/* Pointed at /inbox, which has no feedback-form card: the
                    advice was a dead end. The pairing pages and /forms both
                    carry per-pairing links now. */}
                This form has to be opened for a specific mentorship pairing so we
                can attach your answers to it. Choose the pairing from{" "}
                <Link href="/mentorship" style={{ color: "var(--indigo)" }}>
                  Mentorship
                </Link>{" "}
                or pick the name under the form on{" "}
                <Link href="/forms" style={{ color: "var(--indigo)" }}>
                  Forms
                </Link>
                .
              </>
            ) : error === "wrong_audience" ? (
              <>
                This form is not meant for your role, so it cannot be submitted from
                your account. If you think that is wrong, contact your programme
                administrator.
              </>
            ) : error === "form_broken" ? (
              <>This form&apos;s definition is broken, so it cannot be submitted. Please tell your programme administrator.</>
            ) : error === "invalid" ? (
              <>
                <strong>Your answers could not be saved.</strong>
                {errorDetail ? (
                  <div style={{ marginTop: 6 }}>{errorDetail}</div>
                ) : (
                  <div style={{ marginTop: 6 }}>
                    Please check the required questions and try again.
                  </div>
                )}
              </>
            ) : (
              <>That submission could not be completed. Please try again.</>
            )}
          </div>
        ) : null}

        <section
          className="card card-hi"
          style={{
            background: "var(--card-hi)",
            border: "1px solid var(--line)",
            padding: device === "mobile" ? 0 : 20,
          }}
        >
          {device === "mobile" ? (
            // Spec 133 — full-screen step-through layout. Same schema /
            // initialResponses / context / action contract as FormRenderer
            // so a draft saved on desktop is consumable on mobile and vice
            // versa.
            <MobileFormRunner
              schema={schema}
              initialResponses={initialResponses}
              draftKey={{ templateId: form.id, pairingId: pairingId || null }}
              action={submitFormAction}
              formId={form.id}
              slug={slug}
              pairingId={pairingId || null}
              context={context}
            />
          ) : (
            <FormRenderer
              schema={schema}
              initialResponses={initialResponses}
              draftKey={{ templateId: form.id, pairingId: pairingId || null }}
              action={submitFormAction}
              formId={form.id}
              slug={slug}
              pairingId={pairingId || null}
              context={context}
            />
          )}
        </section>

        <footer
          style={{
            marginTop: 20,
            fontSize: 11,
            color: "var(--ink-4)",
            lineHeight: 1.5,
          }}
        >
          Your responses are saved as you type (draft) and only sealed into the
          record when you press <em>Submit</em>. Until then you can navigate
          away and return without losing what you typed.
        </footer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A stored schema the renderers cannot draw. Said plainly, with nothing to
// submit, rather than an HTTP 500 for everyone who opens the form.
// ---------------------------------------------------------------------------

function BrokenFormShell({ slug }: { slug: string }) {
  return (
    <div className="page-body" style={{ maxWidth: 600, margin: "60px auto", textAlign: "center" }} role="alert">
      <div className="label">Form unavailable</div>
      <h1 className="serif" style={{ fontSize: 26, marginTop: 6 }}>
        This form cannot be shown right now.
      </h1>
      <p style={{ color: "var(--ink-3)", fontSize: 13, marginTop: 8 }}>
        The definition of <code className="mono">{slug}</code> is not one the form runner can draw.
        Nothing you have already submitted is affected. Please let your programme administrator
        know so they can correct it in Admin → Forms.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// In-route 404 — keeps the global error boundary out of it.
// ---------------------------------------------------------------------------

function NotFoundShell({ slug }: { slug: string }) {
  return (
    <div className="page-body" style={{ maxWidth: 600, margin: "60px auto", textAlign: "center" }}>
      <div className="label">Form not found</div>
      <h1 className="serif" style={{ fontSize: 26, marginTop: 6 }}>
        No active form matches this URL.
      </h1>
      <p style={{ color: "var(--ink-3)", fontSize: 13, marginTop: 8 }}>
        Slug <code className="mono">{slug}</code> doesn&apos;t resolve to any
        active <code className="mono">feedback_forms</code> row. Head back to
        your{" "}
        <Link href="/inbox" style={{ color: "var(--indigo)" }}>
          inbox
        </Link>{" "}
        and open the form from there.
      </p>
    </div>
  );
}
