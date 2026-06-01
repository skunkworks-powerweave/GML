"use client";

// Inline add-row form. Uses plain server-action form (rhf+zod arrives with spec 072
// FormRenderer — this is the deliberately-minimal scaffold for spec 012).

import { useActionState } from "react";
import { z } from "zod";
import { ADMIN_ENTITIES } from "@/admin/registry";
import { createRowAction, type AdminActionState } from "./actions";

type Props = {
  entitySlug: string;
  mode?: "create"; // edit mode lands in spec 022 alongside CSV import/export
};

function inferInputType(zodType: z.ZodTypeAny): "text" | "number" | "checkbox" | "textarea" {
  // Unwrap optional/nullable/default to look at the inner shape.
  let inner: z.ZodTypeAny = zodType;
  // zod 3 exposes _def on ZodTypeAny; cast through unknown to access the internals.
  const peek = (z: z.ZodTypeAny) => z as unknown as { _def?: { innerType?: z.ZodTypeAny; typeName?: string } };
  while (peek(inner)._def?.innerType) inner = peek(inner)._def!.innerType!;
  const name = peek(inner)._def?.typeName as string | undefined;
  if (name === "ZodNumber") return "number";
  if (name === "ZodBoolean") return "checkbox";
  return "text";
}

export function RowForm({ entitySlug, mode = "create" }: Props) {
  const entity = ADMIN_ENTITIES[entitySlug];
  const [state, formAction, pending] = useActionState<AdminActionState | undefined, FormData>(
    createRowAction,
    undefined,
  );

  if (!entity) {
    return <p className="text-sm text-red-700">Unknown entity: {entitySlug}</p>;
  }
  if (mode !== "create") {
    // Edit/update UI lands in spec 022.
    return <p className="text-sm text-neutral-500">Edit mode not yet wired.</p>;
  }

  // Pull the Zod object's shape so we can iterate fields.
  const formDef = entity.formSchema._def as unknown as { shape?: (() => Record<string, z.ZodTypeAny>) | Record<string, z.ZodTypeAny> };
  const rawShape = typeof formDef.shape === "function" ? formDef.shape() : formDef.shape;
  const shape = (rawShape ?? {}) as Record<string, z.ZodTypeAny>;

  return (
    <form action={formAction} className="grid grid-cols-1 gap-3 md:grid-cols-2">
      <input type="hidden" name="entitySlug" value={entitySlug} />
      {entity.formFields.map((field) => {
        const fieldSchema = shape[field];
        const inputType = fieldSchema ? inferInputType(fieldSchema) : "text";
        const initial = state?.fields?.[field] ?? "";
        return (
          <label key={field} className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-neutral-700">{field}</span>
            {inputType === "checkbox" ? (
              <select
                name={field}
                defaultValue={initial || "true"}
                className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
              >
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : (
              <input
                name={field}
                type={inputType === "number" ? "number" : "text"}
                defaultValue={initial}
                className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm focus:border-neutral-900 focus:outline-none"
              />
            )}
          </label>
        );
      })}
      {state?.error ? (
        <p className="col-span-full text-xs text-red-700" role="alert">{state.error}</p>
      ) : state?.ok ? (
        <p className="col-span-full text-xs text-emerald-700">Row added.</p>
      ) : null}
      <div className="col-span-full">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-60"
        >
          {pending ? "Adding…" : "Add row"}
        </button>
      </div>
    </form>
  );
}
