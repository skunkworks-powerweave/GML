"use client";

// Spec 114 — Confirm-before-delete client wrapper for the admin grid.
//
// A misclick on "Delete" must not destroy a row, so the first click only asks:
// the button is replaced, in place, by the question ("Delete school:GPS
// Chuchot? ... This cannot be undone.") and two buttons, "Yes, delete" and
// "Cancel". The server action stays the same hardened path.
//
// THE QUESTION IS ON THE PAGE, NOT window.confirm(). A browser that shows no
// dialogs -- the Claude desktop app's browser pane, some phones' in-app
// browsers -- answers window.confirm() with "Cancel" at once, so on the live
// site every Delete silently did nothing (QA, 9 Oct 2026).

import { type FormEvent, useState, useTransition } from "react";
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
  const [asking, setAsking] = useState(false);
  const t = useTranslations("adminData.client");
  const tAction = useTranslations("action");

  // rowLabel is the entity's describeRow ("school:GPS Chuchot"): data.
  const target = rowLabel ?? t("deleteRow.rowFallback", { id: rowId.slice(0, 8) });
  const question = warning
    ? t("deleteRow.confirmWithEffects", { target, effects: warning })
    : t("deleteRow.confirm", { target });

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAsking(true);
  };

  const confirmDelete = () => {
    const formData = new FormData();
    formData.set("entitySlug", entitySlug);
    formData.set("rowId", rowId);
    startTransition(() => {
      void deleteRowAction(formData);
    });
  };

  if (asking) {
    return (
      <span
        role="group"
        aria-label={question}
        data-confirm-open="true"
        className="inline-flex max-w-xs flex-wrap items-center gap-2 text-left align-top"
      >
        <span className="w-full whitespace-pre-line text-xs text-red-900">{question}</span>
        <button
          type="button"
          data-confirm-yes="true"
          disabled={pending}
          onClick={confirmDelete}
          className="rounded-md bg-red-700 px-2 py-1 text-xs text-white disabled:opacity-50"
        >
          {pending ? t("deleteRow.deleting") : t("deleteRow.yes")}
        </button>
        <button
          type="button"
          data-confirm-cancel="true"
          disabled={pending}
          onClick={() => setAsking(false)}
          className="text-xs text-neutral-700 hover:underline disabled:opacity-50"
        >
          {t("deleteRow.cancel")}
        </button>
      </span>
    );
  }

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
