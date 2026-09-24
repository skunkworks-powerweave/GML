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
import { clearDraft, type DraftKey } from "@/lib/form-draft";
import { failureMessage, keepLocalCopy, readLocalCopy, useDraftAutosave } from "./draft-resilience";
import {
  MAX_TEXT_LENGTH,
  validateResponses,
  type FormField as ServerFormField,
} from "@/lib/forms/validate";

/**
 * A scale answer as a number, or null when genuinely unanswered.
 *
 * Handles both shapes the same value arrives in: a number from an autosaved
 * draft (JSON preserves it) and a string from a previously SUBMITTED response
 * (FormData stringifies everything). Anything non-numeric, including "" and
 * null, is unanswered.
 */
function coerceScaleValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}


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

// hindiLabel on an option is seeded (seed_forms_mentee.ts: "हाँ" / "नहीं") and
// was rendered by neither runner until the 2026-09 freeze.
export type FieldOption = { value: string; label: string; hindiLabel?: string };

export type FormField = {
  name: string;
  label?: string;
  hindiLabel?: string;
  kind: FieldKind | string;
  required?: boolean;
  // Renderer canonical: {value,label}[]. Seeds also write string[].
  options?: FieldOption[] | string[];
  helpText?: string;
  /** Hindi companion to helpText. Seeded, and referenced nowhere until 2026-09. */
  helpHindi?: string;
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
  // Spec 142 — `onSubmit` and `action` are a discriminated union. Exactly
  // one of them is expected at a time:
  //   - `onSubmit` runs as a client callback (admin form-builder preview,
  //     in-test renderers). No FormData is POSTed; we just hand the caller
  //     the typed responses dictionary.
  //   - `action` is a Next.js server action; the <form action={...}> path
  //     POSTs the FormData natively and the browser handles the redirect.
  //     The forms-runner page (spec 074) lives on this path.
  // Passing both is a programmer mistake and is asserted in dev.
  onSubmit?: (responses: Record<string, unknown>) => Promise<void>;
  action?: (formData: FormData) => Promise<void> | void;
  draftKey?: DraftKey;
  submitLabel?: string;
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

const NO_INITIAL_RESPONSES: Record<string, unknown> = {};

/**
 * `submitting`, ended by the server's answer.
 *
 * A server-action submission ends one of two ways: success redirects to
 * /forms/[slug]/thanks and this component unmounts; a rejection
 * (?error=invalid, missing_pairing, wrong_audience) redirects back to the SAME
 * route. The code used to assume that second case remounted the form too. It
 * does not: Next 16's layout router keys the page segment without its search
 * params, so the runner stays mounted with its `submitting` still true -- a
 * red banner above a disabled "Submitting…" button that only a reload cleared.
 *
 * What the rejection does bring is a fresh server render, and with it a NEW
 * `initialResponses` object. So "submitting" is recorded against the props
 * the submission was made from, and stops being true the moment different
 * ones arrive. Derived during render rather than reset in an effect, so there
 * is no frame in which a stale busy state shows.
 */
export function useSubmittingUntilServerAnswers(
  initialResponses: Record<string, unknown> | undefined,
): [boolean, (on: boolean) => void] {
  const current = initialResponses ?? NO_INITIAL_RESPONSES;
  const [submittedFrom, setSubmittedFrom] = useState<Record<string, unknown> | null>(null);
  const setSubmitting = useCallback((on: boolean) => setSubmittedFrom(on ? current : null), [current]);
  return [submittedFrom !== null && submittedFrom === current, setSubmitting];
}

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

/**
 * THE SERVER'S RULES, run in the browser. This checked only `required` and a
 * number's min/max, while submitFormAction also refuses text over 5000
 * characters, choices that are not options, too many selections and scale
 * answers off the scale -- so an answer could pass here, travel over a slow
 * link, and come back refused. lib/forms/validate.ts is dependency-free, so
 * both sides now run the one validator.
 */
export function validateField(field: FormField, raw: unknown): string | null {
  const [first] = validateResponses([field as ServerFormField], { [field.name]: raw });
  return first?.message ?? null;
}

/**
 * Field kinds whose control is a GROUP (several buttons / inputs), not one
 * element with id={field.name}. A `<label htmlFor={field.name}>` over one of
 * these points at nothing, so the wrapper renders as a plain block instead and
 * the group names itself with role + aria-label. Shared with MobileFormRunner.
 */
export function isGroupKind(kind: FormField["kind"]): boolean {
  return kind === "radio" || kind === "checkbox" || kind === "likert" || kind === "rating";
}

/**
 * Style reset for Hindi text that sits inside a Latin-styled container.
 *
 * The desktop label style is 11px uppercase JetBrains Mono with 0.06em
 * letter-spacing, and a child span inherits all of it: letter-spacing pulls
 * Devanagari matras and conjuncts apart from their base glyphs, and 11px
 * mono-metric Devanagari is unreadable. So every Hindi run resets them.
 */
const HINDI_RESET: React.CSSProperties = {
  fontFamily: "var(--deva)",
  letterSpacing: "normal",
  textTransform: "none",
  fontWeight: 400,
};

/**
 * One run of Hindi text, declared lang="hi" so assistive tech voices it with
 * a Hindi engine even when the page is English. Renders nothing when absent.
 * Shared with MobileFormRunner so both runners show the same seeded Hindi.
 */
export function HindiText({ text, style }: { text?: string; style?: React.CSSProperties }) {
  if (!text) return null;
  return (
    <span lang="hi" style={{ ...HINDI_RESET, ...style }}>
      {text}
    </span>
  );
}

/** A <select> option cannot contain markup, so its Hindi label joins the text. */
export function optionText(o: FieldOption): string {
  return o.hindiLabel ? `${o.label} / ${o.hindiLabel}` : o.label;
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
      maxLength={type === "text" ? MAX_TEXT_LENGTH : undefined}
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
      maxLength={MAX_TEXT_LENGTH}
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
          {optionText(o)}
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
    // role="radiogroup" is where aria-required legitimately belongs. It was
    // previously set on each <input type="radio">, whose implicit `radio` role
    // does not support the attribute, so assistive tech ignored it and the
    // "this answer is required" information never reached a screen-reader user.
    <div
      role="radiogroup"
      aria-required={field.required ? "true" : undefined}
      aria-label={field.label}
      style={{ display: "grid", gap: 6 }}
    >
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
            />
            <span>
              {o.label}
              <HindiText text={o.hindiLabel} style={{ marginLeft: 6, opacity: 0.8 }} />
            </span>
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
  // A SINGLE PRIOR SELECTION COMES BACK AS A BARE STRING.
  //
  // Responses are stored as jsonb and read back through FormData, where a
  // checkbox group with exactly one box ticked round-trips as a string rather
  // than a one-element array. This read `Array.isArray(value) ? ... : []`, so
  // that one selection was discarded: reopening a saved form showed the box
  // unchecked, and re-submitting silently cleared an answer the user had
  // already given. Groups with two or more selections restored correctly,
  // which is why it looked like an intermittent fault rather than a rule.
  const selected = Array.isArray(value)
    ? (value as string[])
    : typeof value === "string" && value.length > 0
      ? [value]
      : [];
  const toggle = (v: string) => {
    const next = selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v];
    onChange(next);
  };
  return (
    // A named group, like Radio's radiogroup: the field label above it is not
    // a <label for> (there is no single control for it to point at).
    <div role="group" aria-label={field.label} style={{ display: "grid", gap: 6 }}>
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
            <span>
              {o.label}
              <HindiText text={o.hindiLabel} style={{ marginLeft: 6, opacity: 0.8 }} />
            </span>
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
  // Accept a STRING too. Prior answers come back as strings.
  //
  // A submitted response is read out of FormData and stored in
  // feedback_responses.responses as "4", not 4. Gating on
  // `typeof value === "number"` therefore treated every previously-saved
  // likert and rating answer as unanswered: reopening a completed form showed
  // every scale blank, and -- worse -- the mirrored hidden input emitted "",
  // so pressing Submit without re-clicking each scale silently dropped answers
  // the user could see they had already given. Client-side validation passed
  // them (the raw string "4" is non-empty), so the first sign of trouble was
  // the server rejecting the whole form as incomplete.
  //
  // Drafts were unaffected, because those round-trip through JSON and keep
  // their numbers -- which is why this only bit on the re-open-after-submit
  // path.
  const current = coerceScaleValue(value);
  return (
    <div
      role="group"
      aria-label={field.label}
      style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 6 }}
    >
      {/* THE VALUE HAS TO LEAVE THE PAGE.
          These controls are <button type="button"> only -- they carry no name
          and contribute nothing to FormData. This form submits natively via
          <form action={serverAction}>, so the server read NO answer at all for
          any rating or likert field: every mentor progress and final form
          failed server-side validation on "required", and an optional one
          silently stored nothing. React state is invisible to a native submit;
          a mirrored hidden input is what makes it visible. */}
      <input type="hidden" name={field.name} value={current ? String(current) : ""} />
      {labels.map((lbl, i) => {
        const n = i + 1;
        const selected = current === n;
        return (
          <button
            key={n}
            type="button"
            onClick={() => onChange(n)}
            // Selection was colour-only; a screen-reader user filling a
            // mentor feedback form heard every point identically.
            aria-pressed={selected}
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
  // Same string-vs-number problem as Likert above.
  const current = coerceScaleValue(value) ?? 0;
  const verdict = [
    "Not yet rated",
    "Emerging",
    "Developing",
    "Proficient",
    "Strong",
    "Exemplary",
  ];
  return (
    <div role="group" aria-label={field.label} style={{ display: "flex", alignItems: "center", gap: 4 }}>
      {/* THE VALUE HAS TO LEAVE THE PAGE.
          These controls are <button type="button"> only -- they carry no name
          and contribute nothing to FormData. This form submits natively via
          <form action={serverAction}>, so the server read NO answer at all for
          any rating or likert field: every mentor progress and final form
          failed server-side validation on "required", and an optional one
          silently stored nothing. React state is invisible to a native submit;
          a mirrored hidden input is what makes it visible. */}
      <input type="hidden" name={field.name} value={current > 0 ? String(current) : ""} />
      {Array.from({ length: max }, (_, i) => i + 1).map((n) => {
        const on = current >= n;
        return (
          <button
            key={n}
            type="button"
            onClick={() => onChange(n)}
            // The state lives in the NAME, once. `on` is cumulative (stars
            // 1..current all fill), so aria-pressed={on} would announce three
            // pressed buttons for a rating of 3.
            aria-label={`Rate ${n} of ${max}${current === n ? " (selected)" : ""}`}
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
  action,
  formId,
  slug,
  pairingId,
  context,
}: FormRendererProps) {
  // Spec 142 — `action` and `onSubmit` are a discriminated union, never both.
  // The forms-runner page (spec 074) plumbs `action={submitFormAction}` for
  // the server-action submit path that the catalogue links rely on; preview
  // surfaces (admin form builder, in-test renderers) pass `onSubmit` instead
  // because they don't have a server action and want the response synchronously
  // for previewing. Wiring both at once would mean the click ran the callback
  // AND posted the FormData server-side — silent double-submit. Catch that
  // mistake in dev so it never reaches production.
  //
  // Spec 167 — upgraded from `console.error` to `throw new Error`. The prior
  // shape relied on a developer noticing a console message scroll past during
  // local dev or a test run; in practice a noisy console-error can sit unread
  // for weeks while the silent double-submit ships. Throwing in non-production
  // ensures the mistake surfaces as a hard test failure (jsdom rethrows) and
  // a visible React error boundary in dev, so it can never reach a prod build.
  // The production guard preserves graceful fallback: a misbehaving caller in
  // production silently picks `action` (the native <form action={...}> path)
  // and the click goes through cleanly rather than crashing the page.
  if (process.env.NODE_ENV !== "production" && action && onSubmit) {
    throw new Error(
      "FormRenderer: pass either `action` (server) or `onSubmit` (client), not both.",
    );
  }

  const [values, setValues] = useState<Record<string, unknown>>(initialResponses ?? {});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useSubmittingUntilServerAnswers(initialResponses);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Autosave bookkeeping (saveState / lastSavedAt / flushSave come from
  // useDraftAutosave below, shared with MobileFormRunner).
  //
  // A live clock for the "Saved Ns ago" label. This used to be a discarded
  // tick counter (`const [, forceTick] = useState(0)`), which re-rendered this
  // 802-line form once a second while the label it existed to update never
  // changed -- savedIndicator's useMemo did not depend on the tick. Holding the
  // timestamp in state fixes the label AND keeps Date.now() out of render.
  const [nowMs, setNowMs] = useState<number | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Server-action submit is two passes through onFormSubmit (see there):
  // formRef lets the first pass re-submit the form once the final draft PUT
  // has landed; flushedRef marks the second pass so it is let through.
  const formRef = useRef<HTMLFormElement | null>(null);
  const flushedRef = useRef(false);
  const valuesRef = useRef(values);
  // Assigned in an effect, never in the render body. Writing to a ref during
  // render is a render-phase side effect (react-hooks/refs) and is unsafe
  // under StrictMode's double render and concurrent features. No dep array
  // means this runs after every commit, preserving the "always latest"
  // contract. Safe because valuesRef is read only inside the debounced async saveDraft call.
  useEffect(() => {
    valuesRef.current = values;
  });

  const autosaveEnabled = useMemo(
    () => Boolean(draftKey && (draftKey.templateId || draftKey.observationCycleId)),
    [draftKey],
  );

  // A failed save is kept on the device and, when trying again can help,
  // tried again -- it used to say "retrying" and do nothing (draft-resilience.ts).
  const { saveState, failure: saveFailure, lastSavedAt, flushSave, cancelRetry } = useDraftAutosave(
    draftKey,
    autosaveEnabled,
    valuesRef,
  );

  const scheduleSave = useCallback(() => {
    if (!autosaveEnabled) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(flushSave, AUTOSAVE_DEBOUNCE_MS);
  }, [autosaveEnabled, flushSave]);

  // "Saved Ns ago" needs a live ticker. Only run it once there is actually a
  // save to count from -- previously it ticked from mount, burning a render per
  // second on a low-bandwidth target while displaying nothing.
  useEffect(() => {
    if (!autosaveEnabled || lastSavedAt === null) return;
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [autosaveEnabled, lastSavedAt]);

  // Flush any pending save on unmount.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // Answers this device kept because the server never got them (the tab was
  // closed offline, the session expired) come back on the next visit, and go
  // to the server with the next save.
  useEffect(() => {
    if (!autosaveEnabled || !draftKey) return;
    const kept = readLocalCopy(draftKey);
    if (!kept) return;
    // From a timer, once hydration has painted the server's copy: the device
    // copy is the newer one, and goes straight to the server.
    const t = setTimeout(async () => {
      valuesRef.current = { ...valuesRef.current, ...kept };
      setValues((prev) => ({ ...prev, ...kept }));
      await flushSave();
    }, 0);
    return () => clearTimeout(t);
    // Once, on mount: later changes are this component's own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setField = useCallback(
    (name: string, raw: unknown) => {
      setValues((prev) => {
        const next = { ...prev, [name]: raw };
        return next;
      });
      // Onto the device AT ONCE, before the debounced PUT: this copy is what
      // survives a closed tab on a dead link. The ref is written here too (not
      // only after commit) so the copy and the next save are never a keystroke
      // behind.
      valuesRef.current = { ...valuesRef.current, [name]: raw };
      if (autosaveEnabled && draftKey) keepLocalCopy(draftKey, valuesRef.current);
      // Clear any prior error on this field optimistically; full validation re-runs on submit.
      setErrors((prev) => {
        if (!prev[name]) return prev;
        const { [name]: _ignored, ...rest } = prev;
        return rest;
      });
      scheduleSave();
    },
    [autosaveEnabled, draftKey, scheduleSave],
  );

  // Spec 142 — client-callback submit path (`onSubmit`).
  //
  // The gate uses the LOCAL `errs` constant — never the `errors` state — so
  // a rapid double-click can't read a stale snapshot from the previous render
  // and skip past validation. We also set `submitting` BEFORE the await and
  // disable the submit button on it, which is the second half of the race
  // guard: the second click on a button that is already `disabled` cannot
  // re-enter this handler. Both halves are required: a screen-reader user
  // could fire submit via Enter on a focused-but-not-yet-disabled button,
  // and the local-errs gate covers that hand-off window. `submitting` is
  // always reset in finally so a thrown server action doesn't lock the form.
  const onFormSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      // Server-action mode: don't preventDefault. Let the browser POST the
      // FormData up to the action declared on <form action={...}>. We still
      // run validation client-side so the user sees errors immediately, and
      // the action re-validates on the server. If client validation fails we
      // preventDefault to keep the user on the page with the error showing.
      const isServerAction = Boolean(action);
      if (isServerAction && flushedRef.current) {
        // SECOND PASS: the requestSubmit() below, re-entering this handler
        // after the final draft PUT has landed. Validation already passed on
        // the first pass and the values have not changed since. Do NOT
        // preventDefault -- that is what lets React dispatch the action.
        flushedRef.current = false;
        return;
      }
      const errs = validateAll(schema.fields ?? [], values);
      // Set state for rendering; do NOT use it for the gate below.
      setErrors(errs);
      setSubmitError(null);
      if (Object.keys(errs).length > 0) {
        e.preventDefault();
        return;
      }
      if (isServerAction) {
        // FIRST PASS: hold the submit until the last autosave has landed.
        //
        // This used to be `void flushSave()` and let the POST go at once --
        // the shape MobileFormRunner's spec-149 comment describes as the bug.
        // The submit transaction deletes the draft row; a PUT that landed
        // after it committed re-created the row, and the next visit painted
        // "Draft loaded" over a form that had in fact been submitted.
        //
        // The flush is kept, not dropped: on a server-side validation
        // redirect the page re-renders from the draft, so the last keystrokes
        // must be on disk. requestSubmit() re-dispatches submit through THIS
        // handler (the form is visible and has onSubmit, unlike mobile's
        // hidden one), so flushedRef marks the second pass or it would loop.
        e.preventDefault();
        if (debounceRef.current) clearTimeout(debounceRef.current);
        setSubmitting(true);
        // flushSave never rejects: it records a failure in saveState, and the
        // answers travel in the POST either way.
        if (autosaveEnabled) await flushSave();
        // The POST carries the answers; a retried PUT after it would re-create
        // the draft the submit deletes.
        cancelRetry();
        const form = formRef.current;
        if (!form) {
          setSubmitting(false);
          return;
        }
        flushedRef.current = true;
        form.requestSubmit();
        return;
      }
      // Client-callback mode (preview surfaces). preventDefault, then run
      // the caller's async onSubmit and clear the draft.
      e.preventDefault();
      if (!onSubmit) return;
      setSubmitting(true);
      try {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        if (autosaveEnabled) await flushSave();
        await onSubmit(values);
        cancelRetry();
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
    [action, autosaveEnabled, cancelRetry, draftKey, flushSave, onSubmit, schema.fields, setSubmitting, values],
  );

  // Spec 131-B — "Saved Ns ago" indicator. Internal-only; we don't expose
  // it as a prop because the autosave bookkeeping above is the only source
  // of truth. The forceTick interval already running for autosave gives us
  // a 1 s ticker for free — no extra timer needed here.
  const savedIndicator = useMemo(() => {
    if (!autosaveEnabled) return null;
    if (saveState === "error") return failureMessage(saveFailure ?? "error");
    if (saveState === "pending") return "Saving…";
    if (lastSavedAt === null) return "Not saved yet";
    const seconds = Math.max(0, Math.floor(((nowMs ?? lastSavedAt) - lastSavedAt) / 1000));
    if (seconds < 1) return "Saved just now";
    return `Saved ${seconds}s ago`;
  }, [autosaveEnabled, lastSavedAt, saveFailure, saveState, nowMs]);

  return (
    <form
      // Spec 142 — when `action` is provided we render a real server-action
      // form. The browser handles the POST + redirect natively; our onSubmit
      // only runs client validation and toggles `submitting`. When `onSubmit`
      // is provided instead, action stays undefined and the click runs the
      // callback. The dev-mode assertion above catches the both-set mistake.
      action={action}
      onSubmit={onFormSubmit}
      ref={formRef}
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
        const heading = (
          <>
            <span>{field.label}</span>
            {field.required ? (
              <span style={{ color: "var(--rust)", marginLeft: 4 }} aria-hidden="true">
                *
              </span>
            ) : null}
            {/* The seeded Hindi prompt. It rendered on the phone runner only,
                so the same form was Hindi on a phone and English-only on a
                classroom laptop. Resets the label's mono/uppercase/tracking
                (see HINDI_RESET). */}
            <HindiText
              text={field.hindiLabel}
              style={{ display: "block", fontSize: 14, color: "var(--ink-3)", marginTop: 2 }}
            />
          </>
        );
        return (
          <div key={field.name} style={{ display: "block" }}>
            {/* Group kinds have no element with id={field.name}, so a <label
                for> over them named nothing. They name themselves (role +
                aria-label) and the heading is a plain block. */}
            {isGroupKind(field.kind) ? (
              <div style={labelStyle}>{heading}</div>
            ) : (
              <label htmlFor={field.name} style={labelStyle}>
                {heading}
              </label>
            )}
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
            <HindiText text={field.helpHindi} style={{ ...helpStyle, display: "block" }} />
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
          // Spec 142 — `disabled={submitting}` is the second half of the
          // double-submit race guard. The first half is the local-errs gate
          // inside onFormSubmit; together they ensure no second click can
          // re-enter the submit path until the first one has resolved.
          disabled={submitting}
          data-testid="form-renderer-submit"
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
