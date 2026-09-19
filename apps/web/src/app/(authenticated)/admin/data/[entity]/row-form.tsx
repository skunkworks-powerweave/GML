"use client";

// Inline add-/edit-row form for the generic admin grid.
//
// Spec 012 shipped create-only. Spec 114 (admin-grid-mutations) added edit
// mode: `mode="edit"` accepts an `initialValues` object and dispatches to
// `updateRowAction` instead of `createRowAction`. The Zod schema, field list,
// and input inference are shared — only the action + submit label differ.

import { useActionState } from "react";
import { unwrapShape, fieldKind, toInputValue } from "@/admin/zod-shape";
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

  // unwrapShape, not a bare `_def.shape`: three entities wrap their schema in
  // .refine(), and reading _def.shape directly returned {} for them -- which is
  // why `active` rendered as a free text box on subjects, resources and
  // sessions instead of a true/false control.
  const shape = unwrapShape(entity.formSchema);

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
        const kind = fieldKind(shape[field]);
        // Priority: prior failed-submit echo → initial row value → "".
        const echo = state?.fields?.[field];
        const initial =
          echo !== undefined && echo !== ""
            ? echo
            : toInputValue(kind, initialValues?.[field]);
        const fieldError = state?.fieldErrors?.[field];
        return (
          <label key={field} className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-neutral-700">{field}</span>
            {kind === "array" ? (
              <span className="text-[10px] text-neutral-500">
                Separate items with commas.
              </span>
            ) : null}
            {kind === "boolean" ? (
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
                type={kind === "number" ? "number" : "text"}
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
