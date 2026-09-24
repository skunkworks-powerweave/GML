"use client";

// Inline add-/edit-row form for the generic admin grid.
//
// Spec 012 shipped create-only. Spec 114 (admin-grid-mutations) added edit
// mode: `mode="edit"` accepts an `initialValues` object and dispatches to
// `updateRowAction` instead of `createRowAction`. The Zod schema, field list,
// and input inference are shared — only the action + submit label differ.

import { useActionState } from "react";
import {
  unwrapShape,
  fieldKind,
  toInputValue,
  enumOptions,
  fieldLabel,
  isLongText,
  isOptionalField,
} from "@/admin/zod-shape";
import { ADMIN_ENTITIES } from "@/admin/registry";
import {
  createRowAction,
  updateRowAction,
  type AdminActionState,
} from "./actions";

type Option = { id: string; label: string };

type Props = {
  entitySlug: string;
  mode?: "create" | "edit";
  /** Required in edit mode — the primary key of the row to update. */
  rowId?: string;
  /** Existing row values, prefilled into the form inputs in edit mode. */
  initialValues?: Record<string, unknown>;
  /**
   * For each foreign-key field, the rows it may point at (admin/references.ts,
   * loaded by the page). null means "too many to list": the field stays a
   * UUID box. A field absent here is not a foreign key.
   */
  options?: Record<string, Option[] | null>;
};

/** The value a defaulted enum takes when left alone ("" when it has none). */
function enumDefault(zodType: Parameters<typeof isOptionalField>[0]): string {
  const r = zodType?.safeParse(undefined);
  return r?.success && typeof r.data === "string" ? r.data : "";
}

const inputClass = (invalid: boolean) =>
  `rounded-md border ${
    invalid ? "border-red-400" : "border-neutral-300"
  } px-2 py-1.5 text-sm focus:border-neutral-900 focus:outline-none`;

export function RowForm({
  entitySlug,
  mode = "create",
  rowId,
  initialValues,
  options = {},
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
        const optional = isOptionalField(shape[field]);
        const refs = options[field];
        const choices = enumOptions(shape[field]);
        const help = entity.fields?.[field]?.help;
        return (
          <label key={field} className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-neutral-700">
              {fieldLabel(entity, field)}
              {optional ? null : <span className="text-red-700"> *</span>}
            </span>
            {kind === "array" ? (
              <span className="text-[10px] text-neutral-500">
                Separate items with commas.
              </span>
            ) : null}
            {help ? <span className="text-[10px] text-neutral-500">{help}</span> : null}
            {Array.isArray(refs) ? (
              // A foreign key, picked by name. The option VALUE is still the
              // row's UUID, so the server sees exactly what it always did.
              <select
                name={field}
                defaultValue={initial}
                aria-invalid={fieldError ? "true" : undefined}
                className={inputClass(Boolean(fieldError))}
              >
                <option value="">{optional ? "— none —" : "Choose…"}</option>
                {refs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : choices ? (
              <select
                name={field}
                defaultValue={initial || enumDefault(shape[field])}
                aria-invalid={fieldError ? "true" : undefined}
                className={inputClass(Boolean(fieldError))}
              >
                {/* A defaulted enum starts on its default and needs no blank. */}
                {enumDefault(shape[field]) ? null : (
                  <option value="">{optional ? "— none —" : "Choose…"}</option>
                )}
                {choices.map((c) => (
                  <option key={c} value={c}>
                    {c.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            ) : kind === "boolean" ? (
              <select
                name={field}
                defaultValue={initial || "true"}
                className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
              >
                <option value="true">yes</option>
                <option value="false">no</option>
              </select>
            ) : isLongText(shape[field]) ? (
              <textarea
                name={field}
                rows={4}
                defaultValue={initial}
                aria-invalid={fieldError ? "true" : undefined}
                className={inputClass(Boolean(fieldError))}
              />
            ) : (
              <>
                <input
                  name={field}
                  type={kind === "number" ? "number" : "text"}
                  defaultValue={initial}
                  aria-invalid={fieldError ? "true" : undefined}
                  className={inputClass(Boolean(fieldError))}
                />
                {refs === null ? (
                  <span className="text-[10px] text-neutral-500">
                    Too many rows to list here: paste the id from that table&apos;s grid.
                  </span>
                ) : null}
              </>
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
