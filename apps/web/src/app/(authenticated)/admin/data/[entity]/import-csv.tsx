"use client";

// Import CSV into an admin data table.
//
// ── WHY THIS DID NOT EXIST ───────────────────────────────────────────────────
//
// POST /api/admin/data/[entity]/import has been implemented, role-gated and
// tested since the admin tables shipped. `importCsv()` parses, coerces, runs
// every row through the entity's zod schema and returns a per-row error list.
// Nothing in the application ever called it. There was an "Export CSV" button
// and no counterpart, so the only way to bulk-load a roster was curl.
//
// That is the difference between an LMS somebody can be handed and one that
// needs an engineer present. Ladakh-UT is ~900 schools; the teachers, schools
// and learners tables are not going to be typed in one row at a time through a
// form, and "ask the developer to POST it for you" is not an onboarding plan.
//
// ── WHAT IT DOES ABOUT THE DANGEROUS PART ────────────────────────────────────
//
// A bulk insert is the single most destructive thing on this screen, so the
// flow is: pick a file, see the header row echoed back against what the entity
// actually accepts, then confirm. The result is rendered PER ROW, because
// `importCsv` returns partial success (207) -- 40 rows in, 3 rejected -- and
// collapsing that to "failed" would hide the 40 that landed, while collapsing
// it to "done" would hide the 3 that did not.

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

type ImportResult = {
  ok: boolean;
  inserted: number;
  /** Rows whose id named an existing row and were updated in place. */
  updated?: number;
  skipped: number;
  errors: { row: number; message: string }[];
};

/** Header line only — enough to show the operator what they picked. */
function readHeader(text: string): string[] {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  return firstLine
    .split(",")
    .map((h) => h.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

export function ImportCsv({
  entitySlug,
  entityLabel,
  acceptedColumns,
  reportsDuplicates = false,
}: {
  entitySlug: string;
  entityLabel: string;
  /** The entity's form fields — what the importer will actually read. */
  acceptedColumns: string[];
  /** The entity declares a duplicateKey: an id-less row matching a stored record is reported (csv.ts). */
  reportsDuplicates?: boolean;
}) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [csv, setCsv] = useState<string | null>(null);
  const [header, setHeader] = useState<string[]>([]);
  const [rowCount, setRowCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setFileName(null);
    setCsv(null);
    setHeader([]);
    setRowCount(0);
    setResult(null);
    setError(null);
    if (fileInput.current) fileInput.current.value = "";
  }

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setResult(null);
    setError(null);
    const text = await file.text();
    setFileName(file.name);
    setCsv(text);
    setHeader(readHeader(text));
    setRowCount(text.split(/\r?\n/).filter((l) => l.trim() !== "").length - 1);
  }

  async function onImport() {
    if (!csv) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/data/${entitySlug}/import`, {
        method: "POST",
        headers: { "content-type": "text/csv" },
        body: csv,
      });
      // 200 all-good, 207 partial. Both carry the same body; anything else is
      // a refusal (403/404) and has no per-row detail to show.
      if (res.status !== 200 && res.status !== 207) {
        const body = (await res.json().catch(() => null)) as { error?: string; gate?: string } | null;
        setError(
          body?.error === "unknown_entity"
            ? "That table does not accept imports."
            : body?.error === "gate_required"
              ? `Unlock the ${body.gate ?? "section"} section first, then import again.`
              : res.status === 403
              ? "You do not have permission to import into this table."
              : `The import failed (HTTP ${res.status}).`,
        );
        return;
      }
      const body = (await res.json()) as ImportResult;
      setResult(body);
      if (body.inserted > 0 || (body.updated ?? 0) > 0) {
        // Rows landed; the grid behind this panel is now stale.
        router.refresh();
      }
    } catch {
      setError("The import could not be sent. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        data-testid="import-csv-open"
        onClick={() => setOpen(true)}
        className="rounded-md border border-neutral-300 bg-white px-2 py-1 hover:border-neutral-400"
        title={`Bulk-add rows to ${entityLabel} from a CSV file`}
      >
        Import CSV
      </button>
    );
  }

  const unknownColumns = header.filter((h) => !acceptedColumns.includes(h));

  return (
    <div
      data-testid="import-csv-panel"
      className="absolute right-6 z-20 mt-8 w-[28rem] rounded-lg border border-neutral-300 bg-white p-4 text-left shadow-lg"
    >
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-medium text-neutral-900">Import into {entityLabel}</h2>
        <button
          type="button"
          onClick={() => {
            reset();
            setOpen(false);
          }}
          className="text-xs text-neutral-500 hover:underline"
        >
          Close
        </button>
      </div>

      <p className="mb-3 text-xs text-neutral-600">
        A CSV with a header row. Recognised columns:{" "}
        <code className="text-[11px]">{acceptedColumns.join(", ")}</code>. Every row is validated
        before it is written; rows that fail are reported and skipped, and the rest still land.
        A row with an <code className="text-[11px]">id</code> (as in an export) updates that row;
        a row without one is added
        {reportsDuplicates ? ", unless it matches a record already on the table: that row is reported, not added again" : ""}.
        {/* Uploading the whole file again after a partial import used to add
            every row that had landed a second time. */}
        {" "}After a partial import, import again only the rows reported as failed, or an export,
        which carries ids.
      </p>

      <input
        ref={fileInput}
        type="file"
        accept=".csv,text/csv"
        onChange={onPick}
        className="mb-3 block w-full text-xs"
        data-testid="import-csv-file"
      />

      {fileName ? (
        <div className="mb-3 rounded-md border border-neutral-200 bg-neutral-50 p-2 text-xs">
          <div className="font-medium text-neutral-800">{fileName}</div>
          <div className="text-neutral-600">
            {rowCount} data row{rowCount === 1 ? "" : "s"} · columns: {header.join(", ") || "none"}
          </div>
          {unknownColumns.length > 0 ? (
            // Not an error -- the importer ignores what it does not know. But a
            // misspelt header silently dropping a column is exactly the kind of
            // thing you want to see BEFORE writing 400 rows.
            <div className="mt-1 text-amber-700">
              Ignored (not a column on this table): {unknownColumns.join(", ")}
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <div role="alert" className="mb-3 rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-800">
          {error}
        </div>
      ) : null}

      {result ? (
        <div
          role="status"
          data-testid="import-csv-result"
          className={`mb-3 rounded-md border p-2 text-xs ${
            result.errors.length === 0
              ? "border-green-300 bg-green-50 text-green-900"
              : "border-amber-300 bg-amber-50 text-amber-900"
          }`}
        >
          <div className="font-medium">
            {result.inserted} inserted · {result.updated ?? 0} updated · {result.skipped} skipped
          </div>
          {result.errors.length > 0 ? (
            <ul className="mt-1 max-h-40 list-disc space-y-0.5 overflow-auto pl-4">
              {result.errors.map((e, i) => (
                <li key={`${e.row}-${i}`}>
                  {/* The server already reports the spreadsheet line (header =
                      line 1); adding 2 again sent the operator two lines too far. */}
                  {e.row >= 0 ? `Row ${e.row}: ` : ""}
                  {e.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onImport}
          disabled={!csv || busy}
          data-testid="import-csv-submit"
          className="rounded-md border border-neutral-800 bg-neutral-900 px-3 py-1 text-xs text-white disabled:opacity-40"
        >
          {busy ? "Importing…" : `Import ${rowCount || ""} row${rowCount === 1 ? "" : "s"}`.trim()}
        </button>
        {csv ? (
          <button
            type="button"
            onClick={reset}
            className="rounded-md border border-neutral-300 px-3 py-1 text-xs hover:border-neutral-400"
          >
            Choose another file
          </button>
        ) : null}
      </div>
    </div>
  );
}
