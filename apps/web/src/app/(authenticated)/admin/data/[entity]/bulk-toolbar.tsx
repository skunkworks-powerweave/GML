"use client";

// Spec 157 — Bulk select + delete client island for the generic admin grid.
//
// This component is a "use client" island the server-component grid page mounts
// once per render. It owns three responsibilities:
//
//   1. A React context (SelectedRowsContext) that holds the Set<rowId> of
//      currently-selected rows. Two consumers read it:
//      - `BulkSelectAllCheckbox` (rendered in the table thead) sets/clears
//        every visible row id at once.
//      - `BulkRowCheckbox` (rendered in each tbody row's leftmost <td>)
//        toggles a single id.
//
//   2. A sticky `BulkDeleteToolbar` that renders ABOVE the table when
//      `selected.size > 0`. It carries the "Delete N selected" button that
//      gates submit with `window.confirm()` (same pattern as DeleteRowButton
//      from spec 114) and posts `bulkDeleteAction(entitySlug, ids[])`.
//
//   3. A `BulkSelectionProvider` wrapper the server page mounts around the
//      table region. The provider takes `allRowIds: string[]` (computed
//      server-side from the rendered rows) so the "select all" affordance
//      knows what to flip on.
//
// Native window.confirm() is deliberate for v1: zero new components, zero
// new CSS, keyboard + screen-reader accessible by default, identical UX on
// mobile. Mirrors the DeleteRowButton (spec 114) confirm gate.
//
// Role-gating: the server action (bulkDeleteAction in actions.ts) calls
// `requireRole(mutateRolesFor(entity))` so a learner with stale UI cannot
// bypass the toolbar — the server is the source of truth. The toolbar is
// only mounted on the grid the server already gated for the readRoles, but
// any client that tries to invoke the action directly still 403s.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { bulkDeleteAction } from "./actions";

type Ctx = {
  selected: Set<string>;
  allRowIds: readonly string[];
  toggle: (id: string) => void;
  setMany: (ids: readonly string[], on: boolean) => void;
  clear: () => void;
};

const SelectedRowsContext = createContext<Ctx | null>(null);

function useSelectedRows(): Ctx {
  const ctx = useContext(SelectedRowsContext);
  if (!ctx) {
    throw new Error(
      "BulkSelectionProvider missing — wrap the admin grid in <BulkSelectionProvider>",
    );
  }
  return ctx;
}

export function BulkSelectionProvider({
  allRowIds,
  children,
}: {
  allRowIds: readonly string[];
  children: ReactNode;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const setMany = useCallback((ids: readonly string[], on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setSelected(new Set());
  }, []);

  const value = useMemo<Ctx>(
    () => ({ selected, allRowIds, toggle, setMany, clear }),
    [selected, allRowIds, toggle, setMany, clear],
  );

  return (
    <SelectedRowsContext.Provider value={value}>
      {children}
    </SelectedRowsContext.Provider>
  );
}

/** Row checkbox (rendered in the leftmost <td> of every body row). */
export function BulkRowCheckbox({ rowId }: { rowId: string }) {
  const { selected, toggle } = useSelectedRows();
  const checked = selected.has(rowId);
  return (
    <input
      type="checkbox"
      checked={checked}
      onChange={() => toggle(rowId)}
      aria-label={`Select row ${rowId.slice(0, 8)}`}
      data-bulk-row-checkbox="true"
      className="h-4 w-4 rounded border-neutral-300"
    />
  );
}

/** Header checkbox (rendered in the thead leftmost <th>). */
export function BulkSelectAllCheckbox() {
  const { selected, allRowIds, setMany } = useSelectedRows();
  const total = allRowIds.length;
  const selectedCount = allRowIds.reduce(
    (n, id) => (selected.has(id) ? n + 1 : n),
    0,
  );
  const allOn = total > 0 && selectedCount === total;
  const someOn = selectedCount > 0 && selectedCount < total;
  return (
    <input
      type="checkbox"
      checked={allOn}
      ref={(el) => {
        if (el) el.indeterminate = someOn;
      }}
      onChange={() => setMany(allRowIds, !allOn)}
      aria-label={allOn ? "Deselect all rows" : "Select all rows"}
      data-bulk-select-all="true"
      className="h-4 w-4 rounded border-neutral-300"
    />
  );
}

/**
 * Sticky toolbar that appears above the table when ≥1 row is selected.
 * The "Delete N selected" button gates submit with window.confirm() then
 * posts bulkDeleteAction(entitySlug, ids[]).
 */
export function BulkDeleteToolbar({ entitySlug }: { entitySlug: string }) {
  const { selected, clear } = useSelectedRows();
  const [pending, startTransition] = useTransition();
  const count = selected.size;

  if (count === 0) return null;

  const handleDelete = () => {
    const message =
      count === 1
        ? `Delete 1 selected row? This cannot be undone.`
        : `Delete ${count} selected rows? This cannot be undone.`;
    if (typeof window !== "undefined" && !window.confirm(message)) {
      return;
    }
    const formData = new FormData();
    formData.set("entitySlug", entitySlug);
    for (const id of selected) {
      formData.append("rowIds", id);
    }
    startTransition(async () => {
      await bulkDeleteAction(formData);
      clear();
    });
  };

  return (
    <div
      className="sticky top-0 z-10 mb-2 flex items-center justify-between rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm"
      data-bulk-toolbar="true"
      role="region"
      aria-label="Bulk actions"
    >
      <span className="text-red-900">
        {count} row{count === 1 ? "" : "s"} selected
      </span>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={clear}
          className="text-xs text-red-900 hover:underline"
        >
          Clear selection
        </button>
        <button
          type="button"
          onClick={handleDelete}
          disabled={pending}
          data-bulk-delete-button="true"
          className="rounded-md bg-red-700 px-3 py-1.5 text-xs text-white disabled:opacity-50"
        >
          {pending ? "Deleting…" : `Delete ${count} selected`}
        </button>
      </div>
    </div>
  );
}
