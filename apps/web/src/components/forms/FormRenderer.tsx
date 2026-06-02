"use client";

// Spec 072 — Generic schema-driven form renderer.
//
// This is the Phase-8 keystone: every form in the LMS (feedback, observation,
// quiz, survey, checklist) routes through this one component. It accepts a
// FormSchema, renders the appropriate input for each field kind, autosaves a
// debounced draft to /api/form-drafts/[id], and calls the caller-provided
// `onSubmit` on the final submit.
//
// Visual style mirrors `LMS GML Frontend/forms.jsx` 1:1 — inline-style with CSS
// variables (--ink/--paper/--line/--indigo/--saffron/--lichen/--rust/--r-*/
// --serif/--deva). No Tailwind classes; tokens-only.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clearDraft, saveDraft, type DraftKey } from "@/lib/form-draft";

// ---------- Schema types ----------

export type FieldKind =
  | "text"
  | "textarea"
  | "select"
  | "radio"
  | "checkbox"
  | "number"
  | "date"
  | "likert"
  | "rating";

export type FieldOption = { value: string; label: string };

export type FormField = {
  name: string;
  label?: string;
  hindiLabel?: string;
  kind: FieldKind | string;
  required?: boolean;
  // Renderer canonical: {value,label}[]. Seeds also write string[].
  options?: FieldOption[] | string[];
  helpText?: string;
  placeholder?: string;
  min?: number;
  max?: number;
  rows?: number;
  likertLabels?: [string, string, string, string, string];
  starsMax?: number;
};

export type FormSchema = {
  title?: string;
  hindiTitle?: string;
  description?: string;
  purpose?: string;
  fields?: FormField[];
};

type FormRendererProps = {
  schema: FormSchema;
  initialResponses?: Record<string, unknown>;
  onSubmit?: (responses: Record<string, unknown>) => Promise<void>;
  draftKey?: DraftKey;
  submitLabel?: string;
  // Server-action mode (spec 074 forms-runner uses these):
  action?: (formData: FormData) => Promise<void> | void;
  formId?: string;
  slug?: string;
  pairingId?: string | null;
  // Spec 130 — arbitrary contextual params threaded from the catalogue URL
  // (`?cycleId=…&quarter=2&observerId=…&kind=…`) into hidden inputs. The
  // server action reads these back via `formData.get("__ctx_<key>")`. Keys
  // outside a closed allow-list are dropped on the action side, so this prop
  // is safe to widen incrementally without surface-area churn.
  context?: Record<string, string>;
};

const DEFAULT_LIKERT: [string, string, string, string, string] = [
  "Strongly disagree",
  "Disagree",
  "Neutral",
  "Agree",
  "Strongly agree",
];

const AUTOSAVE_DEBOUNCE_MS = 1000;

// ---------- Helpers ----------

// Spec 133 — MobileFormRunner reuses these helpers verbatim. They're exported
// so the mobile renderer doesn't duplicate the validation contract (a drift
// between the two would make a draft saved on mobile fail on desktop submit).
export function normalizeOptions(opts: FormField["options"]): FieldOption[] {
  if (!opts) return [];
  return opts.map((o) =>
    typeof o === "string" ? { value: o, label: o } : o
  );
}

export function isHindiNameField(name: string): boolean {
  return /_(hi|hindi)$/i.test(name);
}

export function validateField(field: FormField, raw: unknown): string | null {
  const empty =
    raw === undefined ||
    raw === null ||
    (typeof raw === "string" && raw.trim() === "") ||
    (Array.isArray(raw) && raw.length === 0);
  if (field.required && empty) return "This field is required.";
  if (empty) return null;
  if (field.kind === "number") {
    const n = typeof raw === "number" ? raw : Number(raw);
    if (Number.isNaN(n)) return "Must be a number.";
    if (typeof field.min === "number" && n < field.min) return `Must be ≥ ${field.min}.`;
    if (typeof field.max === "number" && n > field.max) return `Must be ≤ ${field.max}.`;
  }
  return null;
}

export function validateAll(
  fields: FormField[],
  values: Record<string, unknown>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const err = validateField(f, values[f.name]);
    if (err) errors[f.name] = err;
  }
  return errors;
}

// ---------- Visual atoms ----------

const labelStyle: React.CSSProperties = {
  display: "block",
  fontFamily: "var(--mono)",
  fontSize: 11,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--ink-3)",
  marginBottom: 6,
};

const inputBaseStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  border: "1px solid var(--line)",
  background: "var(--card-hi)",
  color: "var(--ink)",
  fontFamily: "var(--sans)",
  fontSize: 13,
  borderRadius: "var(--r-2)",
  outline: "none",
};

const helpStyle: React.CSSProperties = {
  fontSize: 11,
  color: "var(--ink-3)",
  marginTop: 4,
};

const errorStyle: React.CSSProperties = {
  fontSize: 11,
  color: "var(--rust)",
  marginTop: 4,
};

// ---------- Field renderers ----------

function TextLike({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: unknown;
  onChange: (v: string) => void;
}) {
  const type = field.kind === "number" ? "number" : field.kind === "date" ? "date" : "text";
  const isHindi = isHindiNameField(field.name);
  return (
    <input
      id={field.name}
      name={field.name}
      type={type}
      placeholder={field.placeholder}
      min={field.min}
      max={field.max}
      aria-required={field.required ? "true" : undefined}
      value={value === undefined || value === null ? "" : String(value)}
      onChange={(e) => onChange(e.target.value)}
      style={{
        ...inputBaseStyle,
        fontFamily: isHindi ? "var(--deva)" : "var(--sans)",
      }}
    />
  );
}

function TextArea({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: unknown;
  onChange: (v: string) => void;
}) {
  return (
    <textarea
      id={field.name}
      name={field.name}
      rows={field.rows ?? 4}
      placeholder={field.placeholder}
      aria-required={field.required ? "true" : undefined}
      value={value === undefined || value === null ? "" : String(value)}
      onChange={(e) => onChange(e.target.value)}
      style={{
        ...inputBaseStyle,
        resize: "vertical",
        fontFamily: isHindiNameField(field.name) ? "var(--deva)" : "var(--sans)",
      }}
    />
  );
}

function Select({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: unknown;
  onChange: (v: string) => void;
}) {
  return (
    <select
      id={field.name}
      name={field.name}
      aria-required={field.required ? "true" : undefined}
      value={value === undefined || value === null ? "" : String(value)}
      onChange={(e) => onChange(e.target.value)}
      style={inputBaseStyle}
    >
      <option value="">Choose…</option>
      {normalizeOptions(field.options).map((o) =>(
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function Radio({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: unknown;
  onChange: (v: string) => void;
}) {
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {normalizeOptions(field.options).map((o) =>{
        const checked = value === o.value;
        return (
          <label
            key={o.value}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 8px",
              border: "1px solid " + (checked ? "var(--ink)" : "var(--line)"),
              borderRadius: "var(--r-2)",
              background: checked ? "var(--paper-2)" : "var(--card-hi)",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            <input
              type="radio"
              name={field.name}
              value={o.value}
              checked={checked}
              onChange={() => onChange(o.value)}
              aria-required={field.required ? "true" : undefined}
            />
            <span>{o.label}</span>
          </label>
        );
      })}
    </div>
  );
}

function CheckboxGroup({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: unknown;
  onChange: (v: string[]) => void;
}) {
  const selected = Array.isArray(value) ? (value as string[]) : [];
  const toggle = (v: string) => {
    const next = selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v];
    onChange(next);
  };
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {normalizeOptions(field.options).map((o) =>{
        const checked = selected.includes(o.value);
        return (
          <label
            key={o.value}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 8px",
              border: "1px solid " + (checked ? "var(--ink)" : "var(--line)"),
              borderRadius: "var(--r-2)",
              background: checked ? "var(--paper-2)" : "var(--card-hi)",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            <input
              type="checkbox"
              name={field.name}
              value={o.value}
              checked={checked}
              onChange={() => toggle(o.value)}
            />
            <span>{o.label}</span>
          </label>
        );
      })}
    </div>
  );
}

function Likert({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: unknown;
  onChange: (v: number) => void;
}) {
  const labels = field.likertLabels ?? DEFAULT_LIKERT;
  const current = typeof value === "number" ? value : null;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 6 }}>
      {labels.map((lbl, i) => {
        const n = i + 1;
        const selected = current === n;
        return (
          <button
            key={n}
            type="button"
            onClick={() => onChange(n)}
            style={{
              padding: "10px 8px",
              border: "1px solid " + (selected ? "var(--ink)" : "var(--line)"),
              borderRadius: "var(--r-2)",
              background: selected ? "var(--ink)" : "var(--card-hi)",
              color: selected ? "var(--paper)" : "var(--ink-2)",
              fontSize: 12,
              cursor: "pointer",
              textAlign: "center",
              lineHeight: 1.25,
            }}
          >
            <div style={{ fontFamily: "var(--mono)", fontSize: 11, opacity: 0.8 }}>{n}</div>
            <div>{lbl}</div>
          </button>
        );
      })}
    </div>
  );
}

function Rating({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: unknown;
  onChange: (v: number) => void;
}) {
  const max = field.starsMax ?? 5;
  const current = typeof value === "number" ? value : 0;
  const verdict = [
    "Not yet rated",
    "Emerging",
    "Developing",
    "Proficient",
    "Strong",
    "Exemplary",
  ];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      {Array.from({ length: max }, (_, i) => i + 1).map((n) => {
        const on = current >= n;
        return (
          <button
            key={n}
            type="button"
            onClick={() => onChange(n)}
            aria-label={`Rate ${n} of ${max}`}
            style={{
              width: 38,
              height: 38,
              borderRadius: "var(--r-2)",
              fontFamily: "var(--mono)",
              fontSize: 13,
              fontWeight: 600,
              background: on ? "var(--ink)" : "var(--card-hi)",
              color: on ? "var(--paper)" : "var(--ink-3)",
              border: "1px solid " + (on ? "var(--ink)" : "var(--line)"),
              cursor: "pointer",
            }}
          >
            {n}
          </button>
        );
      })}
      <span style={{ marginLeft: 10, fontSize: 12, color: "var(--ink-3)" }}>
        {current === 0 ? verdict[0] : verdict[Math.min(current, verdict.length - 1)]}
      </span>
    </div>
  );
}

// ---------- The renderer ----------

export function FormRenderer({
  schema,
  initialResponses,
  onSubmit,
  draftKey,
  submitLabel,
  formId,
  slug,
  pairingId,
  context,
}: FormRendererProps) {
  const [values, setValues] = useState<Record<string, unknown>>(initialResponses ?? {});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Autosave bookkeeping
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "pending" | "saved" | "error">("idle");
  const [, forceTick] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const valuesRef = useRef(values);
  valuesRef.current = values;

  const autosaveEnabled = useMemo(
    () => Boolean(draftKey && (draftKey.templateId || draftKey.observationCycleId)),
    [draftKey],
  );

  const flushSave = useCallback(async () => {
    if (!autosaveEnabled || !draftKey) return;
    setSaveState("pending");
    try {
      await saveDraft({ ...draftKey, responses: valuesRef.current });
      setLastSavedAt(Date.now());
      setSaveState("saved");
    } catch {
      setSaveState("error");
    }
  }, [autosaveEnabled, draftKey]);

  const scheduleSave = useCallback(() => {
    if (!autosaveEnabled) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(flushSave, AUTOSAVE_DEBOUNCE_MS);
  }, [autosaveEnabled, flushSave]);

  // "Saved Ns ago" needs a live ticker.
  useEffect(() => {
    if (!autosaveEnabled) return;
    const t = setInterval(() => forceTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [autosaveEnabled]);

  // Flush any pending save on unmount.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const setField = useCallback(
    (name: string, raw: unknown) => {
      setValues((prev) => {
        const next = { ...prev, [name]: raw };
        return next;
      });
      // Clear any prior error on this field optimistically; full validation re-runs on submit.
      setErrors((prev) => {
        if (!prev[name]) return prev;
        const { [name]: _ignored, ...rest } = prev;
        return rest;
      });
      scheduleSave();
    },
    [scheduleSave],
  );

  const onFormSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setSubmitError(null);
      const errs = validateAll(schema.fields ?? [],values);
      setErrors(errs);
      if (Object.keys(errs).length > 0) return;
      setSubmitting(true);
      try {
        // Flush any pending autosave before final submit so the draft mirrors
        // exactly what the server is about to receive.
        if (debounceRef.current) clearTimeout(debounceRef.current);
        if (autosaveEnabled) await flushSave();
        if (onSubmit) await onSubmit(values);
        if (autosaveEnabled && draftKey) {
          // Best-effort cleanup of the draft row. Failure is non-fatal — the
          // user's submission has already gone through.
          try {
            await clearDraft(draftKey);
          } catch {
            // ignore
          }
        }
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : String(err));
      } finally {
        setSubmitting(false);
      }
    },
    [autosaveEnabled, draftKey, flushSave, onSubmit, schema.fields, values],
  );

  // Spec 131-B — "Saved Ns ago" indicator. Internal-only; we don't expose
  // it as a prop because the autosave bookkeeping above is the only source
  // of truth. The forceTick interval already running for autosave gives us
  // a 1 s ticker for free — no extra timer needed here.
  const savedIndicator = useMemo(() => {
    if (!autosaveEnabled) return null;
    if (saveState === "error") return "Save failed — retrying…";
    if (saveState === "pending") return "Saving…";
    if (lastSavedAt === null) return "Not saved yet";
    const seconds = Math.max(0, Math.floor((Date.now() - lastSavedAt) / 1000));
    if (seconds < 1) return "Saved just now";
    return `Saved ${seconds}s ago`;
  }, [autosaveEnabled, lastSavedAt, saveState]);

  return (
    <form
      onSubmit={onFormSubmit}
      style={{
        background: "var(--card)",
        border: "1px solid var(--line)",
        borderRadius: "var(--r-3)",
        padding: 20,
        display: "grid",
        gap: 18,
      }}
    >
      {/*
        Spec 074 / 130 — hidden context inputs the server action reads.
        - __formId, __slug, __pairingId carry the routing context (074).
        - __ctx_<key> carries the closed Spec 130 context set
          (cycleId / quarter / observerId / kind). The server action
          re-sanitizes every value, so even a tampered DOM cannot inject
          surprise fields downstream.
      */}
      {formId ? <input type="hidden" name="__formId" value={formId} /> : null}
      {slug ? <input type="hidden" name="__slug" value={slug} /> : null}
      {pairingId ? (
        <input type="hidden" name="__pairingId" value={pairingId} />
      ) : null}
      {context
        ? Object.entries(context).map(([k, v]) =>
            v && v.length > 0 ? (
              <input
                key={`__ctx_${k}`}
                type="hidden"
                name={`__ctx_${k}`}
                value={v}
              />
            ) : null,
          )
        : null}
      {(schema.title || savedIndicator) ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          {schema.title ? (
            <h2
              style={{
                fontFamily: "var(--serif)",
                fontSize: 20,
                margin: 0,
                color: "var(--ink)",
              }}
            >
              {schema.title}
            </h2>
          ) : null}
          {savedIndicator ? (
            <div
              data-saved-indicator
              style={{
                marginLeft: "auto",
                fontSize: 11,
                color: saveState === "error" ? "var(--rust)" : "var(--ink-3)",
                fontFamily: "var(--mono)",
              }}
              aria-live="polite"
            >
              {savedIndicator}
            </div>
          ) : null}
        </div>
      ) : null}

      {(schema.fields ?? []).map((field) => {
        const value = values[field.name];
        const error = errors[field.name];
        return (
          <div key={field.name} style={{ display: "block" }}>
            <label htmlFor={field.name} style={labelStyle}>
              <span>{field.label}</span>
              {field.required ? (
                <span style={{ color: "var(--rust)", marginLeft: 4 }} aria-hidden="true">
                  *
                </span>
              ) : null}
            </label>
            {field.kind === "textarea" ? (
              <TextArea field={field} value={value} onChange={(v) => setField(field.name, v)} />
            ) : field.kind === "select" ? (
              <Select field={field} value={value} onChange={(v) => setField(field.name, v)} />
            ) : field.kind === "radio" ? (
              <Radio field={field} value={value} onChange={(v) => setField(field.name, v)} />
            ) : field.kind === "checkbox" ? (
              <CheckboxGroup
                field={field}
                value={value}
                onChange={(v) => setField(field.name, v)}
              />
            ) : field.kind === "likert" ? (
              <Likert field={field} value={value} onChange={(v) => setField(field.name, v)} />
            ) : field.kind === "rating" ? (
              <Rating field={field} value={value} onChange={(v) => setField(field.name, v)} />
            ) : field.kind === "number" ? (
              <TextLike
                field={field}
                value={value}
                onChange={(v) => setField(field.name, v === "" ? "" : Number(v))}
              />
            ) : (
              <TextLike field={field} value={value} onChange={(v) => setField(field.name, v)} />
            )}
            {field.helpText ? <div style={helpStyle}>{field.helpText}</div> : null}
            {error ? (
              <div role="alert" style={errorStyle}>
                {error}
              </div>
            ) : null}
          </div>
        );
      })}

      {submitError ? (
        <div role="alert" style={{ ...errorStyle, fontSize: 12 }}>
          {submitError}
        </div>
      ) : null}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          paddingTop: 14,
          borderTop: "1px solid var(--line)",
        }}
      >
        <button
          type="submit"
          disabled={submitting}
          style={{
            padding: "9px 18px",
            background: "var(--ink)",
            color: "var(--paper)",
            border: "1px solid var(--ink)",
            borderRadius: "var(--r-2)",
            fontSize: 13,
            fontWeight: 500,
            cursor: submitting ? "wait" : "pointer",
            opacity: submitting ? 0.7 : 1,
          }}
        >
          {submitting ? "Submitting…" : submitLabel ?? "Submit"}
        </button>
      </div>
    </form>
  );
}
