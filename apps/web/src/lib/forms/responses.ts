// Submitted mentorship feedback, as a record someone can read.
//
// feedback_responses used to be read only to pre-fill the respondent's OWN
// previous answers, to tick /forms, and to print "N/8" on the pairing page. No
// surface showed a mentee's answers to her mentor or anyone's to an
// administrator, so the quarterly feedback the programme collects could only
// be read with SQL. /mentorship/[pairingId]/responses renders what this module
// returns.
//
// WHO READS WHAT (the caller has already passed assertCanAccessPairing and the
// mentorship gate):
//   - administrators and the pairing's mentor: every response on the pairing;
//   - the mentee: her own responses only. The mentor forms carry the mentor's
//     assessment of her ("concerns", progress ratings) and are written for the
//     programme, not addressed to her.
//
// No "server-only": tests/behaviour executes this through the page.

import { and, desc, eq, type SQL } from "drizzle-orm";
import { feedbackForms, feedbackResponses, users } from "@gml/db/schema";
import { isAdmin, type Actor, type Db } from "@/lib/visibility";
import { formTitle } from "@/lib/forms/quarterly";

export type AnswerView = { name: string; label: string; value: string };

export type ResponseView = {
  id: string;
  title: string;
  kind: string;
  audience: string;
  respondentName: string;
  byViewer: boolean;
  submittedAt: Date;
  answers: AnswerView[];
};

type SchemaField = { name?: unknown; label?: unknown; options?: unknown };

function optionLabels(options: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!Array.isArray(options)) return out;
  for (const o of options) {
    if (typeof o === "string") out.set(o, o);
    else if (o && typeof o === "object" && typeof (o as { value?: unknown }).value === "string") {
      const v = (o as { value: string }).value;
      const l = (o as { label?: unknown }).label;
      out.set(v, typeof l === "string" && l ? l : v);
    }
  }
  return out;
}

function display(raw: unknown, labels: Map<string, string>): string {
  const one = (v: unknown) => {
    const s = typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
    return labels.get(s) ?? s;
  };
  return Array.isArray(raw) ? raw.map(one).filter(Boolean).join(", ") : one(raw);
}

/**
 * The answers of one response, in the form's own question order, labelled with
 * the question and with option VALUES shown by their labels. Answers to fields
 * the schema no longer has (the form was edited since) follow, under their
 * field name, rather than disappearing. Internal keys (`__context`) are skipped.
 */
export function answersFor(schema: unknown, responses: Record<string, unknown>): AnswerView[] {
  const fields: SchemaField[] =
    schema && typeof schema === "object" && Array.isArray((schema as { fields?: unknown }).fields)
      ? ((schema as { fields: SchemaField[] }).fields)
      : [];
  const out: AnswerView[] = [];
  const seen = new Set<string>();
  for (const f of fields) {
    if (typeof f?.name !== "string") continue;
    seen.add(f.name);
    if (!(f.name in responses)) continue;
    const value = display(responses[f.name], optionLabels(f.options));
    if (!value) continue;
    out.push({ name: f.name, label: typeof f.label === "string" && f.label ? f.label : f.name, value });
  }
  for (const [name, raw] of Object.entries(responses)) {
    if (seen.has(name) || name.startsWith("__")) continue;
    const value = display(raw, new Map());
    if (value) out.push({ name, label: name, value });
  }
  return out;
}

/** The responses on this pairing that `actor` may read, newest first. */
export async function pairingResponses(db: Db, actor: Actor, pairingId: string): Promise<ResponseView[]> {
  const scope: SQL[] = [eq(feedbackResponses.pairingId, pairingId)];
  if (!isAdmin(actor) && actor.role !== "mentor") scope.push(eq(feedbackResponses.respondentUserId, actor.id));
  const rows = await db
    .select({
      id: feedbackResponses.id,
      responses: feedbackResponses.responses,
      submittedAt: feedbackResponses.submittedAt,
      respondentUserId: feedbackResponses.respondentUserId,
      respondentName: users.name,
      kind: feedbackForms.kind,
      audience: feedbackForms.audience,
      schema: feedbackForms.schema,
    })
    .from(feedbackResponses)
    .innerJoin(feedbackForms, eq(feedbackForms.id, feedbackResponses.formId))
    .leftJoin(users, eq(users.id, feedbackResponses.respondentUserId))
    .where(and(...scope))
    .orderBy(desc(feedbackResponses.submittedAt))
    .limit(200);
  return rows.map((r) => ({
    id: r.id,
    title: formTitle(r.schema, r.kind, r.audience),
    kind: r.kind,
    audience: r.audience,
    respondentName: r.respondentName ?? "A former user",
    byViewer: r.respondentUserId === actor.id,
    submittedAt: r.submittedAt,
    answers: answersFor(r.schema, (r.responses ?? {}) as Record<string, unknown>),
  }));
}
