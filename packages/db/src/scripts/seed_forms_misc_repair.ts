// When seed_forms_misc.ts may rewrite a stored form, decided in one pure place.
//
// The seed's repair-on-drift exists for rows it once seeded BROKEN (fields
// keyed {id, kind} in its own vocabulary, a yes/no mapped to a checkbox with no
// options -- forms nobody could fill in). It used to fire on ANY difference
// from today's seed while a form had no responses, which is exactly when a
// programme customises a form, and deploy.sh runs the seed on every deploy: an
// administrator's edit vanished at the next one. And its "already current"
// test compared JSON.stringify of a jsonb value -- whose keys Postgres
// reorders -- with the JS literal, so it never matched and both rows were
// rewritten on every run.
//
// Now: equal ignoring key order -> current; renderable but different -> an
// administrator's edit, kept; unrenderable -> repaired, unless answered.

/**
 * What a renderer can draw: the seed's CANONICAL_FIELD_KINDS, and the kinds
 * that draw one control per option (and so nothing at all without options).
 * Passed in by seed_forms_misc.ts, which owns both lists.
 */
export type RenderRules = { kinds: readonly string[]; optionBearing: ReadonlySet<string> };

/** JSON with object keys sorted and undefined dropped: equal iff the values are. */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        const x = (v as Record<string, unknown>)[k];
        if (x !== undefined) out[k] = norm(x);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(value));
}

/**
 * A stored schema no renderer can draw -- the shapes this seed once shipped:
 * no fields array, a field without a string `name`, a kind outside the
 * canonical set, or an option-bearing kind with no options.
 */
export function isUnrenderable(stored: unknown, rules: RenderRules): boolean {
  if (!stored || typeof stored !== "object") return true;
  const fields = (stored as { fields?: unknown }).fields;
  if (!Array.isArray(fields) || fields.length === 0) return true;
  const kinds = new Set<string>(rules.kinds);
  return fields.some((f) => {
    if (!f || typeof f !== "object") return true;
    const { name, kind, options } = f as { name?: unknown; kind?: unknown; options?: unknown };
    if (typeof name !== "string" || name.length === 0) return true;
    if (typeof kind !== "string" || !kinds.has(kind)) return true;
    return rules.optionBearing.has(kind) && (!Array.isArray(options) || options.length === 0);
  });
}

export type RepairDecision = "current" | "edited" | "answered" | "repair";

export function repairDecision(stored: unknown, seeded: unknown, answers: number, rules: RenderRules): RepairDecision {
  if (canonicalJson(stored) === canonicalJson(seeded)) return "current";
  if (!isUnrenderable(stored, rules)) return "edited";
  return answers > 0 ? "answered" : "repair";
}
