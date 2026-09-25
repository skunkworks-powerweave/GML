// The shape of feedback_forms.schema, checked.
//
// PUT /api/admin/forms/[id] used to accept anything that JSON-parsed, and the
// runner trusted whatever was stored: `{"fields": {...}}` -- an easy slip in a
// raw-JSON textarea -- made `(schema.fields ?? []).map(...)` throw, and every
// open of that form was an HTTP 500 for every user; `42` stored a form with no
// questions that could still be submitted. One definition now serves both:
// the route refuses a schema that does not match (400, with the zod issues),
// and the runner shows a "this form is broken" panel for a stored one that
// does not, instead of crashing.
//
// Permissive where the seeds are varied (extra keys pass through: intro,
// introHindi, titleHindi, audience ...) and strict where the renderers and
// lib/forms/validate.ts depend on it: fields is a non-empty array, every field
// has a unique form-safe name and a kind a renderer draws.

import { z } from "zod";
import { FORM_FIELD_KINDS } from "@gml/db/form-field-kinds";

// The kinds the renderers draw, shared with seed_forms_misc.ts's repair rule
// (packages/db/src/formFieldKinds.ts). This list used to be its own, with a
// "scale" no renderer draws and the seed did not know, so the seed "repaired"
// an edit this route had accepted.
export const FIELD_KINDS = FORM_FIELD_KINDS;

const short = z.string().max(500);

const OptionSchema = z.union([
  z.string().max(200),
  z
    .object({ value: z.string().min(1).max(200), label: z.string().max(200).optional(), hindiLabel: z.string().max(200).optional() })
    .passthrough(),
]);

const FieldSchema = z
  .object({
    // The FormData key and the key of the stored answer.
    name: z.string().regex(/^[A-Za-z0-9_]{1,64}$/, "letters, digits and _ only (max 64)"),
    kind: z.enum(FIELD_KINDS),
    label: short.optional(),
    hindiLabel: short.optional(),
    required: z.boolean().optional(),
    options: z.array(OptionSchema).max(100).optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    helpText: short.optional(),
    helpHindi: short.optional(),
    placeholder: short.optional(),
    rows: z.number().int().min(1).max(40).optional(),
    likertLabels: z.array(z.string().max(100)).min(2).max(10).optional(),
    starsMax: z.number().int().min(1).max(10).optional(),
  })
  .passthrough();

export const FormSchemaSchema = z
  .object({
    title: z.string().max(200).optional(),
    hindiTitle: z.string().max(200).optional(),
    description: z.string().max(2000).optional(),
    purpose: z.string().max(40).optional(),
    fields: z.array(FieldSchema).min(1).max(200),
  })
  .passthrough()
  .superRefine((s, ctx) => {
    const seen = new Set<string>();
    s.fields.forEach((f, i) => {
      if (seen.has(f.name)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["fields", i, "name"], message: `duplicate field name "${f.name}"` });
      }
      seen.add(f.name);
    });
  });

export type ParsedFormSchema = z.infer<typeof FormSchemaSchema>;

/** A stored or submitted schema, or null when it is not one the runners can draw. */
export function parseFormSchema(raw: unknown): ParsedFormSchema | null {
  const r = FormSchemaSchema.safeParse(raw);
  return r.success ? r.data : null;
}
