"use client";

// Inline add-/edit-row form for the generic admin grid.
//
// Spec 012 shipped create-only. Spec 114 (admin-grid-mutations) added edit
// mode: `mode="edit"` accepts an `initialValues` object and dispatches to
// `updateRowAction` instead of `createRowAction`. The Zod schema, field list,
// and input inference are shared — only the action + submit label differ.

import { useActionState } from "react";
import { z } from "zod";
import { ADMIN_ENTITIES } from "@/admin/registry";
import {
  createRowAction,
  updateRowAction,
  type AdminActionState,
} from "./actions";

type Props = {
  entitySlug: string;
  mode?: "create" | "edit";
  /** Required in edit mode — the primary key of the row to update. */
  rowId?: string;
  /** Existing row values, prefilled into the form inputs in edit mode. */
  initialValues?: Record<string, unknown>;
};

function inferInputType(
  zodType: z.ZodTypeAny,
): "text" | "number" | "checkbox" | "textarea" {
  let inner: z.ZodTypeAny = zodType;
  const peek = (z: z.ZodTypeAny) =>
    z as unknown as { _def?: { innerType?: z.ZodTypeAny; typeName?: string } };
  while (peek(inner)._def?.innerType) inner = peek(inner)._def!.innerType!;
  const name = peek(inner)._def?.typeName as string | undefined;
  if (name === "ZodNumber") return "number";
  if (name === "ZodBoolean") return "checkbox";
  return "text";
}

/** Stringify a prefilled value safely for an HTML input's `defaultValue`. */
function toInputValue(v: unknown): string {
  if (v === null || v === undefined) return "";
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

export function RowForm({
  entitySlug,
  mode = "create",
  rowId,
  initialValues,
}: Props) {
  const entity = ADMIN_ENTITIES[entitySlug];
  const isEdit = mode === "edit";
  const [state, formAction, pending] = useActionState<
    AdminActionState | undefined,
    FormData
  >(isEdit ? updateRowAction : createRowAction, undefined);

  if (!entity) {
    return <p className="text-sm text-red-700">Unknown entity: {entitySlug}</p>;
  }
  if (isEdit && !rowId) {
    return (
      <p className="text-sm text-red-700">
        Edit mode requires a rowId — none was supplied.
      </p>
    );
  }

  // Pull the Zod object's shape so we can iterate fields.
  const formDef = entity.formSchema._def as unknown as {
    shape?: (() => Record<string, z.ZodTypeAny>) | Record<string, z.ZodTypeAny>;
  };
  const rawShape =
    typeof formDef.shape === "function" ? formDef.shape() : formDef.shape;
  const shape = (rawShape ?? {}) as Record<string, z.ZodTypeAny>;

  const submitLabel = isEdit ? "Save changes" : "Add row";
  const pendingLabel = isEdit ? "Saving…" : "Adding…";
  const successLabel = isEdit ? "Row updated." : "Row added.";

  return (
    <form
      action={formAction}
      className="grid grid-cols-1 gap-3 md:grid-cols-2"
      data-form-mode={mode}
    >
      <input type="hidden" name="entitySlug" value={entitySlug} />
      {isEdit && rowId ? (
        <input type="hidden" name="rowId" value={rowId} />
      ) : null}
      {entity.formFields.map((field) => {
        const fieldSchema = shape[field];
        const inputType = fieldSchema ? inferInputType(fieldSchema) : "text";
        // Priority: prior failed-submit echo → initial row value → "".
        const echo = state?.fields?.[field];
        const initial =
          echo !== undefined && echo !== ""
            ? echo
            : toInputValue(initialValues?.[field]);
        const fieldError = state?.fieldErrors?.[field];
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
                aria-invalid={fieldError ? "true" : undefined}
                className={`rounded-md border ${
                  fieldError ? "border-red-400" : "border-neutral-300"
                } px-2 py-1.5 text-sm focus:border-neutral-900 focus:outline-none`}
              />
            )}
            {fieldError ? (
              <span className="text-[11px] text-red-700">{fieldError}</span>
            ) : null}
          </label>
        );
      })}
      {state?.error ? (
        <p className="col-span-full text-xs text-red-700" role="alert">
          {state.error}
        </p>
      ) : state?.ok ? (
        <p className="col-span-full text-xs text-emerald-700">{successLabel}</p>
      ) : null}
      <div className="col-span-full flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-60"
        >
          {pending ? pendingLabel : submitLabel}
        </button>
        {isEdit ? (
          <a
            href={`/admin/data/${entitySlug}`}
            className="text-xs text-neutral-600 hover:underline"
          >
            Cancel
          </a>
        ) : null}
      </div>
    </form>
  );
}
