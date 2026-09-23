// Server-side validation of a form submission against its own schema.
//
// ── WHAT THIS REPLACES ───────────────────────────────────────────────────────
//
// The submit action filtered submitted keys by FIELD NAME and nothing else:
//
//     const fieldIds = new Set((schema.fields ?? []).map((f) => f.name));
//     ...
//     if (!fieldIds.has(cleanKey)) continue;
//
// `required`, `min`, `max`, `options` and `kind` were all declared in the
// schema, rendered by the client, and consulted by no server code. So a
// submission with every field blank persisted. So did a radio value that was
// not one of its options, a number outside its range, and a 10 MB string in a
// text box.
//
// The client-side attributes are a convenience for the person filling the form
// in. They are `required` and `min` attributes in the DOM, removable with two
// keystrokes in devtools and absent entirely from a direct POST to the server
// action — which is a URL, not a private channel.

export type FormField = {
  name: string;
  kind: string;
  label?: string;
  required?: boolean;
  options?: string[];
  min?: number;
  max?: number;
};

export type ValidationError = { field: string; message: string };

/**
 * Upper bound on any single free-text answer.
 *
 * Not a style preference: these land in a jsonb column that administrators
 * read, and without a bound one submission can push an arbitrary payload into
 * a surface someone will later open.
 */
const MAX_TEXT_LENGTH = 5000;

/**
 * Kinds whose stored answer is a number, not one of `options`.
 *
 * `likert` belongs here for the same reason `rating` does: both renderers
 * submit the ordinal (1..5) and use `options` / likertLabels only to caption
 * each point.
 */
const NUMERIC_KINDS: ReadonlySet<string> = new Set(["number", "rating", "scale", "likert"]);
const MAX_SELECTIONS = 50;

function asArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (v === undefined || v === null) return [];
  return [String(v)];
}

/**
 * Check `responses` against `fields`. Returns [] when valid.
 *
 * Returns ALL errors rather than the first, so someone who left three fields
 * blank is told about three fields rather than discovering them one submit at
 * a time — on a form filled in over a slow link from a school.
 */
export function validateResponses(
  fields: FormField[],
  responses: Record<string, unknown>,
): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const field of fields) {
    const values = asArray(responses[field.name]).filter((v) => v.trim().length > 0);
    const label = field.label ?? field.name;

    if (values.length === 0) {
      if (field.required) {
        errors.push({ field: field.name, message: `${label} is required.` });
      }
      // Nothing further to check on an empty optional field.
      continue;
    }

    if (values.length > MAX_SELECTIONS) {
      errors.push({ field: field.name, message: `${label} has too many selections.` });
      continue;
    }

    for (const raw of values) {
      if (raw.length > MAX_TEXT_LENGTH) {
        errors.push({
          field: field.name,
          message: `${label} is too long (max ${MAX_TEXT_LENGTH} characters).`,
        });
        break;
      }
    }

    // OPTIONS. A radio, select or checkbox may only carry a value the schema
    // declares. Without this the stored answer can be any string at all, and
    // every downstream report that groups by it silently gains a category.
    //
    // NUMERIC SCALES ARE EXCLUDED, and that is not a loosening. On a rating,
    // scale or likert field `options` holds the LABEL FOR EACH POINT -- the
    // seeded mentor form declares ["1 - No movement", "2", "3 - On track", ...]
    // -- while both renderers submit the ordinal the user picked. Treating
    // those labels as the permitted value set rejected every rating whose
    // label was not the bare number, so the mentor progress and final forms
    // could not be submitted at all. The numeric block below is the real
    // constraint for these kinds, and it is stricter: it enforces min/max
    // rather than mere membership.
    if (field.options && field.options.length > 0 && !NUMERIC_KINDS.has(field.kind)) {
      const allowed = new Set(field.options);
      for (const v of values) {
        if (!allowed.has(v)) {
          errors.push({
            field: field.name,
            message: `${label}: "${v.slice(0, 40)}" is not one of the available choices.`,
          });
          break;
        }
      }
    }

    // NUMBERS.
    if (NUMERIC_KINDS.has(field.kind)) {
      for (const v of values) {
        const n = Number(v);
        if (!Number.isFinite(n)) {
          errors.push({ field: field.name, message: `${label} must be a number.` });
          break;
        }
        if (field.min !== undefined && n < field.min) {
          errors.push({ field: field.name, message: `${label} must be at least ${field.min}.` });
          break;
        }
        if (field.max !== undefined && n > field.max) {
          errors.push({ field: field.name, message: `${label} must be at most ${field.max}.` });
          break;
        }
      }
      continue;
    }

    // Non-numeric fields can still carry min/max as a length bound.
    if (field.min !== undefined || field.max !== undefined) {
      for (const v of values) {
        if (field.min !== undefined && v.length < field.min) {
          errors.push({
            field: field.name,
            message: `${label} must be at least ${field.min} characters.`,
          });
          break;
        }
        if (field.max !== undefined && v.length > field.max) {
          errors.push({
            field: field.name,
            message: `${label} must be at most ${field.max} characters.`,
          });
          break;
        }
      }
    }
  }

  return errors;
}

/**
 * May this role answer a form aimed at this audience?
 *
 * The GET path already checks this; the server action is a SEPARATE entry
 * point, and POSTing to it directly skipped the gate entirely.
 */
export function audienceAllows(role: string, audience: string): boolean {
  if (role === "programme_admin" || role === "super_admin") return true;
  if (audience === "mentor") return role === "mentor";
  if (audience === "mentee") return role === "teacher";
  return false;
}
