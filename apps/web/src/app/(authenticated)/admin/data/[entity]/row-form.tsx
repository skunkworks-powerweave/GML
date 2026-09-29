"use client";

// Inline add-/edit-row form for the generic admin grid.
//
// Spec 012 shipped create-only. Spec 114 (admin-grid-mutations) added edit
// mode: `mode="edit"` accepts an `initialValues` object and dispatches to
// `updateRowAction` instead of `createRowAction`. The Zod schema, field list,
// and input inference are shared — only the action + submit label differ.
//
// Words: the form's own are adminData.client.rowForm; each field's label,
// hint and enum choices are the entity's (admin/labels.ts), resolved by the
// page and passed as `text`, so only this entity's reach the browser.

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import {
  unwrapShape,
  fieldKind,
  toInputValue,
  enumOptions,
  isLongText,
  isOptionalField,
  dateInputType,
} from "@/admin/zod-shape";
import type { RowFormText } from "@/admin/labels";
import { ADMIN_ENTITIES } from "@/admin/registry";
import {
  createRowAction,
  updateRowAction,
  type AdminActionState,
} from "./actions";
import { PdfUploadField } from "./pdf-upload-field";

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
  /** The entity's words in the viewer's language: rowFormText() on the server. */
  text: RowFormText;
};

/**
 * The value a defaulted enum or yes/no field takes when left alone, as the
 * form value ("" when it has none). The yes/no select used to fall back to
 * "true" whatever the schema said -- right for the `active` fields, wrong for
 * sessions.observed, so every session added from the grid was marked observed.
 */
function fieldDefault(zodType: Parameters<typeof isOptionalField>[0]): string {
  const r = zodType?.safeParse(undefined);
  return r?.success && (typeof r.data === "string" || typeof r.data === "boolean") ? String(r.data) : "";
}

const inputClass = (invalid: boolean) =>
  // i18n-ignore: CSS class list
  `rounded-md border ${
    invalid ? "border-red-400" : "border-neutral-300"
  } px-2 py-1.5 text-sm focus:border-neutral-900 focus:outline-none`;

export function RowForm({
  entitySlug,
  mode = "create",
  rowId,
  initialValues,
  options = {},
  text,
}: Props) {
  const entity = ADMIN_ENTITIES[entitySlug];
  const isEdit = mode === "edit";
  const [state, formAction, pending] = useActionState<
    AdminActionState | undefined,
    FormData
  >(isEdit ? updateRowAction : createRowAction, undefined);
  const t = useTranslations("adminData.client");
  const tAction = useTranslations("action");

  if (!entity) {
    return <p className="text-sm text-red-700">{t("rowForm.unknownEntity", { slug: entitySlug })}</p>;
  }
  if (isEdit && !rowId) {
    return <p className="text-sm text-red-700">{t("rowForm.noRowId")}</p>;
  }

  // unwrapShape, not a bare `_def.shape`: three entities wrap their schema in
  // .refine(), and reading _def.shape directly returned {} for them -- which is
  // why `active` rendered as a free text box on subjects, resources and
  // sessions instead of a true/false control.
  const shape = unwrapShape(entity.formSchema);

  const submitLabel = isEdit ? t("rowForm.saveChanges") : t("rowForm.addRow");
  const pendingLabel = isEdit ? tAction("saving") : t("rowForm.adding");
  const successLabel = isEdit ? t("rowForm.updated") : t("rowForm.added");
  const blank = (optional: boolean) => (optional ? t("rowForm.none") : t("rowForm.choose"));

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
        const dateInput = dateInputType(entity, field);
        // Priority: prior failed-submit echo → initial row value → "". The
        // echo is the string this field posted (actions.ts submittedFields),
        // "" included: an emptied box stays empty after a refusal elsewhere,
        // instead of the stored value coming back and the corrected save
        // quietly undoing the clearing.
        const echo = state?.fields?.[field];
        const initial =
          echo !== undefined ? echo : toInputValue(kind, initialValues?.[field], dateInput);
        const fieldError = state?.fieldErrors?.[field];
        const optional = isOptionalField(shape[field]);
        const refs = options[field];
        const choices = enumOptions(shape[field]);
        const choiceLabel = (v: string) => text.choices[field]?.[v] ?? v.replace(/_/g, " ");
        const help = text.fields[field]?.help;
        return (
          <label key={field} className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-neutral-700">
              {text.fields[field]?.label ?? field}
              {optional ? null : <span className="text-red-700"> *</span>}
            </span>
            {kind === "array" ? (
              <span className="text-[10px] text-neutral-500">{t("rowForm.commaList")}</span>
            ) : null}
            {help ? <span className="text-[10px] text-neutral-500">{help}</span> : null}
            {entity.fields?.[field]?.upload === "pdf" ? (
              // An uploaded file's key: a picker that uploads, not a box to
              // paste a Storage key into (./pdf-upload-field.tsx).
              <PdfUploadField entitySlug={entitySlug} field={field} initial={initial} invalid={Boolean(fieldError)} />
            ) : Array.isArray(refs) ? (
              // A foreign key, picked by name. The option VALUE is still the
              // row's UUID, so the server sees exactly what it always did.
              <select
                name={field}
                defaultValue={initial}
                aria-invalid={fieldError ? "true" : undefined}
                className={inputClass(Boolean(fieldError))}
              >
                <option value="">{blank(optional)}</option>
                {refs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : choices ? (
              <select
                name={field}
                defaultValue={initial || fieldDefault(shape[field])}
                aria-invalid={fieldError ? "true" : undefined}
                className={inputClass(Boolean(fieldError))}
              >
                {/* A defaulted enum starts on its default and needs no blank. */}
                {fieldDefault(shape[field]) ? null : <option value="">{blank(optional)}</option>}
                {choices.map((c) => (
                  <option key={c} value={c}>
                    {choiceLabel(c)}
                  </option>
                ))}
                {/* A stored value the choices lack stays selected, as itself:
                    with no option for it the select fell back to the first
                    choice, and an untouched save overwrote it (a complete
                    pairing became "active"). Saved as is, zod refuses it. */}
                {initial && !choices.includes(initial) ? (
                  <option value={initial}>{initial.replace(/_/g, " ")}</option>
                ) : null}
              </select>
            ) : kind === "boolean" ? (
              <select
                name={field}
                defaultValue={initial || fieldDefault(shape[field])}
                className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
              >
                {/* With no default, the operator must choose: no silent "yes". */}
                {fieldDefault(shape[field]) ? null : <option value="">{blank(optional)}</option>}
                <option value="true">{t("rowForm.yes")}</option>
                <option value="false">{t("rowForm.no")}</option>
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
                  // A timestamp gets date AND time (IST), a date column a date
                  // picker: a text box cut timestamps to 00:00 UTC on save.
                  type={dateInput ?? (kind === "number" ? "number" : "text")}
                  defaultValue={initial}
                  aria-invalid={fieldError ? "true" : undefined}
                  className={inputClass(Boolean(fieldError))}
                />
                {refs === null ? (
                  <span className="text-[10px] text-neutral-500">
                    {/* The grid shows links by name, never an id, so "paste the id
                        from that table's grid" pointed at nothing (page.tsx now
                        shows it in the Edit panel). */}
                    {t("rowForm.tooMany")}
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
            {tAction("cancel")}
          </a>
        ) : null}
      </div>
    </form>
  );
}
