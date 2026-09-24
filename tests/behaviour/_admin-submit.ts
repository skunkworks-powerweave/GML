// What the admin grid does to a browser submission before zod sees it.
//
// This is admin/data/[entity]/actions.ts::coerceFormData in CREATE mode: both
// call the one shared implementation, admin/zod-shape.ts::coerceFormValues, so
// this is no longer a stand-in that can drift from the real thing. Empty
// inputs are skipped; arrays, numbers and dates are coerced by the field's zod
// kind; "true"/"false" become booleans; everything else stays a string.

import { ADMIN_ENTITIES } from "../../apps/web/src/admin/registry.ts";
import { unwrapShape, coerceFormValues } from "../../apps/web/src/admin/zod-shape.ts";

export function asSubmitted(slug: string, values: Record<string, string>): Record<string, unknown> {
  const entity = ADMIN_ENTITIES[slug];
  if (!entity) throw new Error(`no admin entity ${slug}`);
  return coerceFormValues(entity.formFields, unwrapShape(entity.formSchema), (f) => values[f] ?? null);
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
