import type { z } from "zod";

/**
 * Read a form schema's field map, whatever it is wrapped in.
 *
 * `_def.shape` exists on a ZodObject and on nothing else. Several entities
 * declare their schema as `z.object({...}).refine(...)`, which produces a
 * ZodEffects WRAPPING the object, so a bare `_def.shape` is undefined for them
 * and every caller silently falls back to "no fields".
 *
 * That has now caused the same class of bug three times over, in three files
 * that each reached into `_def` themselves:
 *
 *   the grid's filters   every column filter on resources, sessions and
 *                        subjects was silently discarded
 *   the row form         `active` rendered as a FREE TEXT BOX on those three
 *                        entities instead of a true/false control, so an
 *                        administrator had to type the word "true"
 *   coerceFormData       array fields could not be submitted at all
 *
 * One implementation now, so the next caller inherits the unwrapping rather
 * than rediscovering it. `.refine()` can nest, hence a fixed point rather than
 * a single unwrap; ZodDefault and ZodOptional are unwrapped for the same reason.
 */
export function unwrapShape(schema: unknown): Record<string, z.ZodTypeAny> {
  let current = schema as z.ZodTypeAny | undefined;
  for (let depth = 0; depth < 10 && current; depth += 1) {
    const def = (current as unknown as {
      _def?: {
        shape?: (() => Record<string, z.ZodTypeAny>) | Record<string, z.ZodTypeAny>;
        schema?: z.ZodTypeAny;
        innerType?: z.ZodTypeAny;
      };
    })._def;
    if (!def) break;
    if (def.shape) {
      const raw = typeof def.shape === "function" ? def.shape() : def.shape;
      return (raw ?? {}) as Record<string, z.ZodTypeAny>;
    }
    current = def.schema ?? def.innerType;
  }
  return {};
}

/** What kind of value a field holds, after unwrapping optional/nullable/default. */
export type FieldKind = "string" | "number" | "boolean" | "array" | "date" | "unknown";

/**
 * The underlying kind of a single field.
 *
 * Optional, nullable and default wrappers are peeled off first: a
 * `z.array(z.string()).default([])` is an array, and treating it as a string --
 * which is what happened before this existed -- is what made every mentor,
 * course-outline and resource row unsaveable.
 */
export function fieldKind(zodType: z.ZodTypeAny | undefined): FieldKind {
  if (!zodType) return "unknown";
  let inner: z.ZodTypeAny = zodType;
  const peek = (t: z.ZodTypeAny) =>
    t as unknown as { _def?: { innerType?: z.ZodTypeAny; typeName?: string } };
  for (let depth = 0; depth < 10; depth += 1) {
    const next = peek(inner)._def?.innerType;
    if (!next) break;
    inner = next;
  }
  switch (peek(inner)._def?.typeName) {
    case "ZodNumber":
      return "number";
    case "ZodBoolean":
      return "boolean";
    case "ZodArray":
      return "array";
    case "ZodDate":
      return "date";
    case "ZodString":
    case "ZodEnum":
      return "string";
    default:
      return "unknown";
  }
}

/**
 * Turn what an <input> gave us back into what the schema expects.
 *
 * ARRAYS are the reason this exists. An array field was rendered by
 * JSON-stringifying it into a text box -- `["English","Math"]` came out as the
 * literal text `["English","Math"]`, and an empty array as `[]` -- and then
 * submitted as that string. zod rejected it with "Expected array, received
 * string", and `.default([])` could not save the day because a default only
 * fires on `undefined`, never on a present-but-wrong value. The result was that
 * mentors, course-outlines and resources could not be edited AT ALL: opening a
 * row and pressing Save without touching anything failed.
 *
 * Comma-separated is the input format, because that is what an administrator
 * types unprompted. A JSON array is still accepted, so anything already saved
 * in that shape keeps working.
 */
export function coerceFieldValue(kind: FieldKind, raw: string): unknown {
  switch (kind) {
    case "array": {
      const text = raw.trim();
      if (text === "") return [];
      if (text.startsWith("[")) {
        try {
          const parsed = JSON.parse(text);
          if (Array.isArray(parsed)) return parsed.map((v) => String(v));
        } catch {
          // Fall through to comma-splitting: a half-typed JSON array is far
          // more likely to be a person's list than valid JSON.
        }
      }
      return text
        .split(/[,\n]/)
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
    }
    case "number": {
      const n = Number(raw);
      return Number.isFinite(n) ? n : raw;
    }
    case "boolean":
      return raw === "true";
    default:
      return raw;
  }
}

/** Peel optional/nullable/default wrappers off a field. */
function innermost(zodType: z.ZodTypeAny): z.ZodTypeAny {
  let inner = zodType;
  for (let depth = 0; depth < 10; depth += 1) {
    const next = (inner as unknown as { _def?: { innerType?: z.ZodTypeAny } })._def?.innerType;
    if (!next) break;
    inner = next;
  }
  return inner;
}

/**
 * The allowed values of an enum field, or null for anything else. The grid
 * renders these as a <select>: a free text box for `status` accepted any
 * spelling and then failed validation with "Invalid enum value".
 */
export function enumOptions(zodType: z.ZodTypeAny | undefined): string[] | null {
  if (!zodType) return null;
  const inner = innermost(zodType) as unknown as { _def?: { typeName?: string; values?: readonly string[] } };
  return inner._def?.typeName === "ZodEnum" ? [...(inner._def.values ?? [])] : null;
}

/** True when the field may be left empty (optional, nullable or defaulted). */
export function isOptionalField(zodType: z.ZodTypeAny | undefined): boolean {
  if (!zodType) return true;
  return zodType.safeParse(undefined).success;
}

/**
 * Free text long enough to deserve a multi-line box: lesson bodies, notes,
 * descriptions (all max 5,000-20,000). URLs and bios stay single-line.
 */
export function isLongText(zodType: z.ZodTypeAny | undefined): boolean {
  if (!zodType) return false;
  const inner = innermost(zodType) as unknown as {
    _def?: { typeName?: string; checks?: Array<{ kind: string; value?: number }> };
  };
  if (inner._def?.typeName !== "ZodString") return false;
  const max = inner._def.checks?.find((c) => c.kind === "max")?.value;
  return typeof max === "number" && max > 2000;
}

/**
 * What the form calls a field: the entity's own label if it gives one, else
 * the grid column's label, else the key spelled out ("rttSubjectId" ->
 * "Rtt subject"). The form used to print the raw key -- `mentorId`,
 * `classTeacherName` -- which is a column name, not a question.
 */
export function fieldLabel(
  entity: { fields?: Record<string, { label?: string }>; displayColumns: Array<{ key: string; label: string }> },
  field: string,
): string {
  const own = entity.fields?.[field]?.label ?? entity.displayColumns.find((c) => c.key === field)?.label;
  if (own) return own;
  const words = field
    .replace(/Id$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/\b(rtt|url)\b/g, (w) => w.toUpperCase());
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Render a stored value into the string an <input> should show. */
export function toInputValue(kind: FieldKind, v: unknown): string {
  if (v === null || v === undefined) return "";
  if (kind === "array" && Array.isArray(v)) return v.map((x) => String(x)).join(", ");
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}
