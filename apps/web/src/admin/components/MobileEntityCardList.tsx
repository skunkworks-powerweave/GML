"use client";

// Spec 023 — Mobile fallback for the generic admin grid (≤ 768px).
//
// On desktop the [entity]/page.tsx server component renders a <table>. On
// mobile that table is unusable (5–6 columns × 50 rows = horizontal-scroll
// pain), so we render one card per row instead.
//
// This component is *presentational only*. It receives already-fetched rows
// + the entity's display columns (acting as the "registry" of which fields
// to show). Title = first displayColumn (the canonical name field). Card
// body = next 2-3 displayColumns as KV pairs. The full row is still
// reachable via the desktop view; this card view exposes:
//   - a "View row" affordance, linking to the grid's own ?edit=<id> panel.
//     It used to link to ?row=<id>, a parameter the grid has never read, so on
//     a phone the button reloaded the same list and nothing else.
//   - an Export CSV button (re-uses the generic /api/admin/data/[slug]/export
//     endpoint that the desktop header already points at — so CSV stays a
//     one-click affordance on small screens too)
//
// Hindi-name handling (SM-7): if the row has a `hindiName` or `nameHindi`
// field with a non-empty value, render it under the title in var(--deva).
// This is purely conditional — never shown when absent.

import type { CSSProperties } from "react";

export type MobileCardColumn = {
  key: string;
  label: string;
  format?: (v: unknown) => string;
};

export type MobileEntityCardListProps = {
  entitySlug: string;
  entityLabel: string;
  rows: Record<string, unknown>[];
  /** First column is treated as the card title, the rest become KV rows. */
  columns: MobileCardColumn[];
  /** Optional override for how many of `columns` (after title) to show as KV pairs. */
  maxKvFields?: number;
};

const DEFAULT_KV_COUNT = 3;

function formatCell(col: MobileCardColumn, value: unknown): string {
  if (col.format) return col.format(value);
  if (value === null || value === undefined || value === "") return "—";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function pickHindi(row: Record<string, unknown>): string | null {
  // SM-7: Hindi name fields are always optional. We accept either common
  // spelling (`hindiName` on teachers; `nameHindi` would also be valid).
  const cand = (row.hindiName ?? row.nameHindi) as unknown;
  if (typeof cand !== "string") return null;
  const trimmed = cand.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function pickRowId(row: Record<string, unknown>): string | null {
  const id = row.id;
  if (id === null || id === undefined) return null;
  return String(id);
}

const cardStyle: CSSProperties = {
  background: "var(--card-hi)",
  border: "1px solid var(--line)",
  borderRadius: "var(--r-3)",
  padding: 14,
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const titleStyle: CSSProperties = {
  fontFamily: "var(--serif)",
  fontSize: 16,
  fontWeight: 600,
  color: "var(--ink)",
  lineHeight: 1.25,
};

const labelStyle: CSSProperties = {
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: "0.07em",
  color: "var(--ink-3)",
  fontWeight: 500,
};

const valueStyle: CSSProperties = {
  fontSize: 13,
  color: "var(--ink-2)",
  marginTop: 2,
  wordBreak: "break-word",
};

const buttonRowStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  marginTop: 4,
  paddingTop: 10,
  borderTop: "1px solid var(--hairline)",
};

const buttonBaseStyle: CSSProperties = {
  flex: 1,
  fontSize: 12,
  fontWeight: 500,
  padding: "8px 10px",
  borderRadius: "var(--r-2)",
  border: "1px solid var(--line)",
  background: "var(--paper-2)",
  color: "var(--ink-2)",
  textAlign: "center",
  textDecoration: "none",
  cursor: "pointer",
};

const buttonPrimaryStyle: CSSProperties = {
  ...buttonBaseStyle,
  background: "var(--indigo-soft)",
  color: "var(--indigo)",
  borderColor: "var(--indigo-soft)",
};

export function MobileEntityCardList({
  entitySlug,
  entityLabel,
  rows,
  columns,
  maxKvFields = DEFAULT_KV_COUNT,
}: MobileEntityCardListProps) {
  if (columns.length === 0) {
    return (
      <div style={{ padding: 24, color: "var(--ink-3)", fontSize: 13 }}>
        No display columns configured for {entityLabel}.
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div
        style={{
          padding: 24,
          background: "var(--card-hi)",
          border: "1px dashed var(--line)",
          borderRadius: "var(--r-3)",
          color: "var(--ink-3)",
          fontSize: 13,
          textAlign: "center",
        }}
      >
        No {entityLabel.toLowerCase()} yet. Use the form above to add one.
      </div>
    );
  }

  const titleCol = columns[0];
  const kvCols = columns.slice(1, 1 + Math.max(0, maxKvFields));
  const csvHref = `/api/admin/data/${entitySlug}/export`;

  return (
    <div
      data-testid={`mobile-cards-${entitySlug}`}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      {rows.map((row, idx) => {
        const rowId = pickRowId(row);
        const titleValue = formatCell(titleCol, row[titleCol.key]);
        const hindi = pickHindi(row);
        // `?edit=`, not `?row=`. The grid page reads `sp.edit` to open its
        // detail panel and has never read `row` at all, so on a phone this
        // button reloaded the identical list and did nothing else -- the only
        // way to open a record from the mobile admin was to switch to a
        // desktop. Nothing reported it because the page did visibly reload.
        const viewHref = rowId
          ? `/admin/data/${entitySlug}?edit=${encodeURIComponent(rowId)}`
          : `/admin/data/${entitySlug}`;

        return (
          <article
            key={rowId ?? `row-${idx}`}
            style={cardStyle}
            aria-label={`${entityLabel} card ${titleValue}`}
          >
            <header
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: 10,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={labelStyle}>{titleCol.label}</div>
                <div style={titleStyle}>
                  {titleValue}
                  {hindi ? (
                    <span
                      style={{
                        fontFamily: "var(--deva)",
                        color: "var(--ink-3)",
                        marginLeft: 8,
                        fontSize: 13,
                        fontWeight: 400,
                      }}
                    >
                      {hindi}
                    </span>
                  ) : null}
                </div>
              </div>
              {rowId ? (
                <span
                  style={{
                    fontFamily: "var(--mono)",
                    fontSize: 10,
                    color: "var(--ink-4)",
                    background: "var(--paper-2)",
                    padding: "2px 6px",
                    borderRadius: "var(--r-1)",
                    flexShrink: 0,
                  }}
                  title={`Row id ${rowId}`}
                >
                  #{rowId.slice(0, 6)}
                </span>
              ) : null}
            </header>

            <dl style={{ display: "flex", flexDirection: "column", gap: 6, margin: 0 }}>
              {kvCols.map((col) => (
                <div key={col.key}>
                  <dt style={labelStyle}>{col.label}</dt>
                  <dd style={{ ...valueStyle, margin: 0 }}>{formatCell(col, row[col.key])}</dd>
                </div>
              ))}
            </dl>

            <div style={buttonRowStyle}>
              <a
                href={csvHref}
                style={buttonBaseStyle}
                title={`Download ${entityLabel} as CSV`}
              >
                Export CSV
              </a>
              <a
                href={viewHref}
                style={buttonPrimaryStyle}
                title={`View ${titleValue}`}
              >
                View row
              </a>
            </div>
          </article>
        );
      })}
    </div>
  );
}
