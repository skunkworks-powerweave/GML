"use client";

// Spec 114 — Confirm-before-delete client wrapper for the admin grid.
//
// Mirrors the JSX prototype's ConfirmModal pattern (ux.jsx::ConfirmModal):
// before posting the deleteRowAction form, fire a native window.confirm
// dialog so a misclick on "Delete" cannot silently destroy a row. The
// server action stays the same hardened path — we only gate the submit.
//
// Native confirm() is deliberate for v1: zero new components, zero new CSS,
// keyboard + screen-reader accessible by default, identical UX on mobile.
// A future spec can upgrade to a styled modal without touching the action.

import { type FormEvent, useTransition } from "react";
import { useTranslations } from "next-intl";
import { deleteRowAction } from "./actions";

type Props = {
  entitySlug: string;
  rowId: string;
  rowLabel?: string;
  /**
   * What else the delete deletes or unlinks, already in the viewer's
   * language (admin/delete-effects.ts deleteWarning, on the server): said in
   * the confirmation, before anything happens.
   */
  warning?: string;
};

export function DeleteRowButton({ entitySlug, rowId, rowLabel, warning }: Props) {
  const [pending, startTransition] = useTransition();
  const t = useTranslations("adminData.client");
  const tAction = useTranslations("action");

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // rowLabel is the entity's describeRow ("school:GPS Chuchot"): data.
    const target = rowLabel ?? t("deleteRow.rowFallback", { id: rowId.slice(0, 8) });
    const message = warning
      ? t("deleteRow.confirmWithEffects", { target, effects: warning })
      : t("deleteRow.confirm", { target });
    if (typeof window !== "undefined" && !window.confirm(message)) {
      return;
    }
    const formData = new FormData();
    formData.set("entitySlug", entitySlug);
    formData.set("rowId", rowId);
    startTransition(() => {
      void deleteRowAction(formData);
    });
  };

  return (
    <form onSubmit={handleSubmit} className="inline" data-confirm-delete="true">
      <input type="hidden" name="entitySlug" value={entitySlug} />
      <input type="hidden" name="rowId" value={rowId} />
      <button
        type="submit"
        disabled={pending}
        className="text-xs text-red-700 hover:underline disabled:opacity-50"
      >
        {pending ? t("deleteRow.deleting") : tAction("delete")}
      </button>
    </form>
  );
}
