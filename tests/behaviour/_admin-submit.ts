// What the admin grid does to a browser submission before zod sees it.
//
// Mirrors admin/data/[entity]/actions.ts::coerceFormData in CREATE mode, using
// the same zod-shape helpers it uses: empty inputs are skipped, numbers and
// arrays are coerced by the field's zod kind, "true"/"false" become booleans,
// everything else stays a string. actions.ts itself is a "use server" module
// that imports the database client, so it cannot be loaded by a plain node
// test; this is the smallest faithful stand-in.

import { ADMIN_ENTITIES } from "../../apps/web/src/admin/registry.ts";
import { unwrapShape, fieldKind, coerceFieldValue } from "../../apps/web/src/admin/zod-shape.ts";

export function asSubmitted(slug: string, values: Record<string, string>): Record<string, unknown> {
  const entity = ADMIN_ENTITIES[slug];
  if (!entity) throw new Error(`no admin entity ${slug}`);
  const shape = unwrapShape(entity.formSchema);
  const out: Record<string, unknown> = {};
  for (const field of entity.formFields) {
    const raw = values[field];
    if (raw === undefined || raw === "") continue;
    const kind = fieldKind(shape[field]);
    if (kind === "array" || kind === "number") out[field] = coerceFieldValue(kind, raw);
    else if (raw === "true") out[field] = true;
    else if (raw === "false") out[field] = false;
    else out[field] = raw;
  }
  return out;
}

/** Parse a submission through the entity's real form schema. */
export function parseSubmission(slug: string, values: Record<string, string>) {
  return ADMIN_ENTITIES[slug]!.formSchema.safeParse(asSubmitted(slug, values));
}

/** Parse, and throw with the zod issues if the submission is rejected. */
export function mustParse(slug: string, values: Record<string, string>): Record<string, unknown> {
  const r = parseSubmission(slug, values);
  if (!r.success) throw new Error(`${slug}: ${JSON.stringify(r.error.issues)}`);
  return r.data as Record<string, unknown>;
}
