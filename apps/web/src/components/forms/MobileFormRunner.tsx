"use client";

// Spec 133 — Mobile form runner (Workflow Run 12 frontend-parity closure).
//
// Ports the JSX prototype at `LMS GML Frontend/mobile-runners.jsx::MobForm`
// (lines 297-366) into a production drop-in replacement for FormRenderer on
// touch devices. The contract is intentionally identical:
//
//   - Same `FormSchema` shape.
//   - Same `initialResponses` (draft / prior-response / prefill layering
//     already happens in the page server component, spec 130 + 131-A).
//   - Same autosave pipeline (reuses `saveDraft` from `@/lib/form-draft`,
//     same 1 s debounce so a draft saved on mobile is identical to one
//     saved on desktop).
//   - Same server-action submit contract — the `action` prop becomes the
//     `<form action={...}>` so a click on "Submit" posts the FormData the
//     server action in `forms/[slug]/page.tsx` already knows how to read.
//
// What changes is the LAYOUT — instead of stacking every field in one
// scroll, we render one field per "screen" with big 44 × 44 touch targets,
// progress dots at the top, and Previous / Next at the bottom (sticky).
// The last screen is a review list with an "Edit" link per question and
// a big Submit button.
//
// Visual style follows mobile-runners.jsx 1:1 — inline-style CSS variables
// (--ink / --paper / --line / --indigo / --r-*); no Tailwind, tokens-only.
// Safe-area-inset padding on the sticky footer so the iPhone notch /
// home-indicator doesn't eat the buttons. Touch-targets minimum 44 × 44
// (Apple HIG / Material guideline) on all interactive elements.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { saveDraft, type DraftKey } from "@/lib/form-draft";
import { useSwipe } from "@/lib/use-swipe";
import {
  isHindiNameField,
  normalizeOptions,
  validateAll,
  validateField,
  type FormField,
  type FormSchema,
} from "./FormRenderer";

// Same prop shape as FormRenderer (spec 072) so the page server component
// can swap one for the other based on the device cookie.
//
// Spec 142 — `action` and `onSubmit` are a discriminated union, never both:
// `action` is the server-action submit path the forms-runner uses; `onSubmit`
// is the client-callback path admin preview surfaces use. The dev-mode
// assertion in the component body catches the both-set mistake.
export type MobileFormRunnerProps = {
  schema: FormSchema;
  initialResponses?: Record<string, unknown>;
  draftKey?: DraftKey;
  submitLabel?: string;
  action?: (formData: FormData) => Promise<void> | void;
  onSubmit?: (responses: Record<string, unknown>) => Promise<void>;
  formId?: string;
  slug?: string;
  pairingId?: string | null;
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
const TOUCH_TARGET = 44; // Apple HIG / Material Design minimum (px).

// ---------- Visual atoms (mobile-specific overrides of the desktop tokens) ----------

const bigLabelStyle: CSSProperties = {
  fontFamily: "var(--sans)",
  fontSize: 16,
  lineHeight: 1.4,
  color: "var(--ink)",
  fontWeight: 500,
  marginBottom: 4,
};

const helpStyle: CSSProperties = {
  fontSize: 13,
  color: "var(--ink-3)",
  marginTop: 4,
  lineHeight: 1.45,
};

const errorStyle: CSSProperties = {
  fontSize: 13,
  color: "var(--rust)",
  marginTop: 6,
};

const bigInputStyle: CSSProperties = {
  width: "100%",
  minHeight: TOUCH_TARGET,
  padding: "12px 14px",
  border: "1px solid var(--line)",
  background: "var(--card-hi)",
  color: "var(--ink)",
  fontFamily: "var(--sans)",
  fontSize: 16, // 16+ so iOS doesn't zoom on focus
  borderRadius: "var(--r-2)",
  outline: "none",
  boxSizing: "border-box",
};

// ---------- Per-field renderers (touch-optimised) ----------

function BigTextLike({
  field,
  value,
  onChange,
  autoFocus,
}: {
  field: FormField;
  value: unknown;
  onChange: (v: string) => void;
  autoFocus?: boolean;
}) {
  const type = field.kind === "number" ? "number" : field.kind === "date" ? "date" : "text";
  const isHindi = isHindiNameField(field.name);
  return (
    <input
      id={field.name}
      name={field.name}
      type={type}
      autoFocus={autoFocus}
      placeholder={field.placeholder}
      min={field.min}
      max={field.max}
      inputMode={field.kind === "number" ? "numeric" : undefined}
      aria-required={field.required ? "true" : undefined}
      value={value === undefined || value === null ? "" : String(value)}
      onChange={(e) => onChange(e.target.value)}
      style={{
        ...bigInputStyle,
        fontFamily: isHindi ? "var(--deva)" : "var(--sans)",
      }}
    />
  );
}

function BigTextArea({
  field,
  value,
  onChange,
  autoFocus,
}: {
  field: FormField;
  value: unknown;
  onChange: (v: string) => void;
  autoFocus?: boolean;
}) {
  return (
    <textarea
      id={field.name}
      name={field.name}
      autoFocus={autoFocus}
      rows={field.rows ?? 5}
      placeholder={field.placeholder}
      aria-required={field.required ? "true" : undefined}
      value={value === undefined || value === null ? "" : String(value)}
      onChange={(e) => onChange(e.target.value)}
      style={{
        ...bigInputStyle,
        minHeight: 120,
        resize: "vertical",
        fontFamily: isHindiNameField(field.name) ? "var(--deva)" : "var(--sans)",
      }}
    />
  );
}

function BigSelect({
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
      style={bigInputStyle}
    >
      <option value="">Choose…</option>
      {normalizeOptions(field.options).map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function BigRadio({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: unknown;
  onChange: (v: string) => void;
}) {
  // Vertical stack with full-width 44px-min touch targets — one large radio
  // per option. Hidden native input keeps keyboard / screen-reader semantics.
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {normalizeOptions(field.options).map((o) => {
        const checked = value === o.value;
        return (
          <label
            key={o.value}
            data-testid={`mobile-radio-${field.name}-${o.value}`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              minHeight: TOUCH_TARGET,
              padding: "12px 14px",
              border: "1px solid " + (checked ? "var(--ink)" : "var(--line)"),
              borderRadius: "var(--r-2)",
              background: checked ? "var(--ink)" : "var(--card-hi)",
              color: checked ? "var(--paper)" : "var(--ink)",
              cursor: "pointer",
              fontSize: 15,
            }}
          >
            <input
              type="radio"
              name={field.name}
              value={o.value}
              checked={checked}
              onChange={() => onChange(o.value)}
              aria-required={field.required ? "true" : undefined}
              style={{ width: 20, height: 20 }}
            />
            <span>{o.label}</span>
          </label>
        );
      })}
    </div>
  );
}

function BigCheckboxGroup({
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
    <div style={{ display: "grid", gap: 10 }}>
      {normalizeOptions(field.options).map((o) => {
        const checked = selected.includes(o.value);
        return (
          <label
            key={o.value}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              minHeight: TOUCH_TARGET,
              padding: "12px 14px",
              border: "1px solid " + (checked ? "var(--ink)" : "var(--line)"),
              borderRadius: "var(--r-2)",
              background: checked ? "var(--ink)" : "var(--card-hi)",
              color: checked ? "var(--paper)" : "var(--ink)",
              cursor: "pointer",
              fontSize: 15,
            }}
          >
            <input
              type="checkbox"
              name={field.name}
              value={o.value}
              checked={checked}
              onChange={() => toggle(o.value)}
              style={{ width: 20, height: 20 }}
            />
            <span>{o.label}</span>
          </label>
        );
      })}
    </div>
  );
}

function BigLikert({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: unknown;
  onChange: (v: number) => void;
}) {
  // Vertical stack of 5 large radio rows. Each row is 44px+ tall so a thumb
  // can hit it reliably; the matching scale-number lives in the rendered label.
  const labels = field.likertLabels ?? DEFAULT_LIKERT;
  const current = typeof value === "number" ? value : null;
  return (
    <div data-testid="mobile-likert" style={{ display: "grid", gap: 10 }}>
      {labels.map((lbl, i) => {
        const n = i + 1;
        const selected = current === n;
        return (
          <button
            key={n}
            type="button"
            onClick={() => onChange(n)}
            data-testid={`mobile-likert-${field.name}-${n}`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              minHeight: TOUCH_TARGET,
              padding: "12px 14px",
              border: "1px solid " + (selected ? "var(--ink)" : "var(--line)"),
              borderRadius: "var(--r-2)",
              background: selected ? "var(--ink)" : "var(--card-hi)",
              color: selected ? "var(--paper)" : "var(--ink)",
              cursor: "pointer",
              fontSize: 15,
              textAlign: "left",
              width: "100%",
            }}
          >
            <span
              style={{
                width: 32,
                height: 32,
                borderRadius: "50%",
                background: selected ? "var(--paper)" : "var(--paper-2)",
                color: selected ? "var(--ink)" : "var(--ink-3)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontFamily: "var(--mono)",
                fontSize: 13,
                fontWeight: 600,
                flexShrink: 0,
              }}
            >
              {n}
            </span>
            <span>{lbl}</span>
          </button>
        );
      })}
    </div>
  );
}

function BigRating({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: unknown;
  onChange: (v: number) => void;
}) {
  // Large tappable star row — each star is a 56x56 tap target (well above
  // the 44px floor) so the user can pick a rating with their thumb without
  // mis-hitting the neighbour.
  const max = field.starsMax ?? 5;
  const current = typeof value === "number" ? value : 0;
  return (
    <div
      data-testid="mobile-rating"
      style={{ display: "flex", gap: 8, justifyContent: "flex-start" }}
    >
      {Array.from({ length: max }, (_, i) => i + 1).map((n) => {
        const on = current >= n;
        return (
          <button
            key={n}
            type="button"
            onClick={() => onChange(n)}
            aria-label={`Rate ${n} of ${max}`}
            data-testid={`mobile-star-${field.name}-${n}`}
            style={{
              width: 56,
              height: 56,
              borderRadius: "var(--r-2)",
              fontSize: 28,
              lineHeight: 1,
              background: on ? "var(--ink)" : "var(--card-hi)",
              color: on ? "var(--saffron)" : "var(--ink-3)",
              border: "1px solid " + (on ? "var(--ink)" : "var(--line)"),
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {on ? "★" : "☆"}
          </button>
        );
      })}
    </div>
  );
}

// ---------- The runner ----------

export function MobileFormRunner({
  schema,
  initialResponses,
  draftKey,
  submitLabel,
  action,
  onSubmit,
  formId,
  slug,
  pairingId,
  context,
}: MobileFormRunnerProps) {
  // Spec 142 — match FormRenderer's both-set guard. The forms-runner page
  // (spec 074) only ever passes `action`; preview surfaces only ever pass
  // `onSubmit`; wiring both would double-submit. Caught in dev only.
  if (process.env.NODE_ENV !== "production" && action && onSubmit) {
    // eslint-disable-next-line no-console
    console.error(
      "[MobileFormRunner] Both `action` and `onSubmit` were provided. " +
        "Use `action` for server-action submits (forms-runner) or `onSubmit` " +
        "for client-callback previews — never both.",
    );
  }

  const fields = useMemo(() => schema.fields ?? [], [schema.fields]);
  // Step index — 0..fields.length-1 = field screens, fields.length = review.
  const [step, setStep] = useState(0);
  const [values, setValues] = useState<Record<string, unknown>>(initialResponses ?? {});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Autosave bookkeeping — mirrors FormRenderer exactly so a draft saved on
  // mobile is byte-identical to one saved on desktop.
  const [saveState, setSaveState] = useState<"idle" | "pending" | "saved" | "error">("idle");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const formRef = useRef<HTMLFormElement | null>(null);

  const autosaveEnabled = useMemo(
    () => Boolean(draftKey && (draftKey.templateId || draftKey.observationCycleId)),
    [draftKey],
  );

  const flushSave = useCallback(async () => {
    if (!autosaveEnabled || !draftKey) return;
    setSaveState("pending");
    try {
      await saveDraft({ ...draftKey, responses: valuesRef.current });
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

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const setField = useCallback(
    (name: string, raw: unknown) => {
      setValues((prev) => ({ ...prev, [name]: raw }));
      setErrors((prev) => {
        if (!prev[name]) return prev;
        const { [name]: _ignored, ...rest } = prev;
        return rest;
      });
      scheduleSave();
    },
    [scheduleSave],
  );

  const totalSteps = fields.length + 1; // +1 for the review screen
  const isReview = step >= fields.length;
  const currentField = isReview ? null : fields[step];

  // ---- Step navigation ----
  // Next: validate the current field; if it has an error, surface it and
  // stay on this step. Otherwise move forward. Previous: always allowed.
  const goNext = useCallback(() => {
    if (!currentField) return;
    const err = validateField(currentField, values[currentField.name]);
    if (err) {
      setErrors((prev) => ({ ...prev, [currentField.name]: err }));
      return;
    }
    setStep((s) => Math.min(s + 1, fields.length));
  }, [currentField, fields.length, values]);

  const goPrev = useCallback(() => {
    setStep((s) => Math.max(0, s - 1));
  }, []);

  const goToField = useCallback((idx: number) => {
    setStep(Math.max(0, idx));
  }, []);

  // ---- Spec 139 — swipe gestures ----
  // Left-swipe = Next (same validation gate as the tap button below) — only
  // ever fires while on a field screen so a swipe inside the review list
  // doesn't accidentally re-submit. Right-swipe = Previous; disabled at
  // step 0 by the goPrev guard. Swipes are ADDITIVE; the Previous / Next
  // buttons stay visible as the canonical affordance.
  const { ref: swipeRef, reducedMotion } = useSwipe<HTMLDivElement>(
    () => {
      if (isReview) return; // submit happens via the explicit button only
      goNext();
    },
    () => {
      goPrev();
    },
  );

  // ---- Submit ----
  // Run validateAll one last time. If any field still has an error, jump
  // back to the first failing step so the user lands on the offending screen.
  //
  // Spec 149 (Workflow Run 13 audit closure) — mirror desktop FormRenderer
  // exactly: AWAIT the final flushSave before triggering the server-action
  // requestSubmit. The previous `void flushSave()` raced the form post — on
  // a slow link the POST landed before the autosave PATCH, so a refresh of
  // the page mid-submit could resurrect a stale draft and the user would
  // see the prior answers come back. Awaiting closes the race: the draft
  // row is byte-identical to the FormData being POSTed before the POST
  // ever leaves the browser.
  //
  // Spec 142 — rapid double-tap race guard:
  //   (a) gate the handler on `submitting` so re-entry while already in
  //       flight is a no-op (covers the keyboard-Enter + tap collision
  //       window when the button is briefly enabled);
  //   (b) the validation gate uses the LOCAL `errs` constant — never the
  //       `errors` state — so a stale snapshot can't slip a bad submit
  //       past the gate;
  //   (c) when wired through the new `onSubmit` discriminator (preview
  //       surfaces), reset `submitting` in finally so a thrown callback
  //       doesn't lock the form. The action path can't reset here because
  //       the browser is mid-navigation by then; the page unmounts on
  //       success and re-renders on a validation redirect.
  const onSubmitClick = useCallback(async () => {
    if (submitting) return;
    setSubmitError(null);
    const errs = validateAll(fields, values);
    setErrors(errs);
    if (Object.keys(errs).length > 0) {
      const firstBadIdx = fields.findIndex((f) => errs[f.name]);
      if (firstBadIdx >= 0) setStep(firstBadIdx);
      return;
    }
    setSubmitting(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (action) {
      // Server-action path — the hidden inputs in the form below already
      // carry the per-field values via serializeValue(). Submitting via the
      // ref lets the server action pick up the FormData the way it does on
      // desktop. await the flushSave so the draft row matches the FormData
      // about to be POSTed (spec 149 race fix).
      await flushSave();
      formRef.current?.requestSubmit();
      return;
    }
    // Client-callback path (preview surfaces). Match FormRenderer's contract.
    if (!onSubmit) {
      setSubmitting(false);
      return;
    }
    try {
      if (autosaveEnabled) await flushSave();
      await onSubmit(values);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [action, autosaveEnabled, fields, flushSave, onSubmit, submitting, values]);

  // ---- Progress dots ----
  // One pill per step (field screens + review). Active is a wide pill,
  // others are small dots. Tap an earlier step to jump back; later steps
  // are non-tappable until the user has reached them.
  const progressDots = (
    <div
      data-testid="mobile-progress-dots"
      style={{
        display: "flex",
        gap: 6,
        padding: "12px 16px 4px",
        alignItems: "center",
        justifyContent: "center",
        flexWrap: "wrap",
      }}
    >
      {Array.from({ length: totalSteps }, (_, i) => {
        const isActive = i === step;
        const isPast = i < step;
        const tappable = i <= step;
        return (
          <button
            key={i}
            type="button"
            disabled={!tappable}
            onClick={() => (tappable ? setStep(i) : undefined)}
            aria-label={`Step ${i + 1} of ${totalSteps}`}
            data-testid={`mobile-progress-dot-${i}`}
            style={{
              height: 8,
              width: isActive ? 28 : 8,
              borderRadius: 4,
              background: isActive
                ? "var(--ink)"
                : isPast
                  ? "var(--ink-3)"
                  : "var(--paper-3)",
              border: "none",
              cursor: tappable ? "pointer" : "default",
              padding: 0,
              transition: "width 120ms ease",
            }}
          />
        );
      })}
    </div>
  );

  // ---- Review screen ----
  // Compact list of every answer with "Edit" link per question + big Submit
  // button. Unanswered fields render an "—" so the user sees the gap.
  function renderReview() {
    return (
      <div style={{ padding: "16px 16px 24px", display: "grid", gap: 12 }}>
        <h2
          style={{
            fontFamily: "var(--serif)",
            fontSize: 22,
            margin: 0,
            color: "var(--ink)",
            letterSpacing: "-0.01em",
          }}
        >
          Review your answers
        </h2>
        <p style={{ fontSize: 13, color: "var(--ink-3)", margin: 0, lineHeight: 1.5 }}>
          Tap "Edit" on any row to go back. Press Submit when ready — your
          responses will be sealed into the record.
        </p>
        {fields.map((f, i) => {
          const raw = values[f.name];
          const display =
            raw === undefined || raw === null || raw === ""
              ? "—"
              : Array.isArray(raw)
                ? raw.join(", ")
                : String(raw);
          return (
            <div
              key={f.name}
              data-testid={`mobile-review-row-${f.name}`}
              style={{
                padding: 12,
                background: "var(--card-hi)",
                border: "1px solid var(--line)",
                borderRadius: "var(--r-2)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  alignItems: "flex-start",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontFamily: "var(--mono)",
                      fontSize: 11,
                      color: "var(--ink-3)",
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                      marginBottom: 4,
                    }}
                  >
                    {f.label ?? f.name}
                  </div>
                  <div
                    style={{
                      fontSize: 15,
                      color: raw === undefined || raw === "" ? "var(--ink-3)" : "var(--ink)",
                      wordBreak: "break-word",
                      fontFamily: isHindiNameField(f.name) ? "var(--deva)" : "var(--sans)",
                    }}
                  >
                    {display}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => goToField(i)}
                  data-testid={`mobile-review-edit-${f.name}`}
                  style={{
                    minHeight: TOUCH_TARGET,
                    minWidth: TOUCH_TARGET,
                    padding: "8px 14px",
                    background: "transparent",
                    color: "var(--indigo)",
                    border: "1px solid var(--line)",
                    borderRadius: "var(--r-2)",
                    fontSize: 13,
                    cursor: "pointer",
                  }}
                >
                  Edit
                </button>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // ---- Field screen ----
  function renderFieldScreen(field: FormField) {
    const value = values[field.name];
    const err = errors[field.name];
    const autoFocus = field.kind === "textarea" || field.kind === "text";
    return (
      <div
        data-testid={`mobile-field-screen-${field.name}`}
        style={{ padding: "16px 16px 24px", display: "grid", gap: 8 }}
      >
        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 11,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: "var(--ink-3)",
          }}
        >
          Question {step + 1} of {fields.length}
        </div>
        <label htmlFor={field.name} style={bigLabelStyle}>
          {field.label ?? field.name}
          {field.required ? (
            <span style={{ color: "var(--rust)", marginLeft: 4 }} aria-hidden="true">
              *
            </span>
          ) : null}
          {field.hindiLabel ? (
            <span
              style={{
                display: "block",
                fontFamily: "var(--deva)",
                color: "var(--ink-3)",
                fontSize: 14,
                marginTop: 2,
              }}
            >
              {field.hindiLabel}
            </span>
          ) : null}
        </label>
        <div style={{ marginTop: 8 }}>
          {field.kind === "textarea" ? (
            <BigTextArea
              field={field}
              value={value}
              onChange={(v) => setField(field.name, v)}
              autoFocus={autoFocus}
            />
          ) : field.kind === "select" ? (
            <BigSelect field={field} value={value} onChange={(v) => setField(field.name, v)} />
          ) : field.kind === "radio" ? (
            <BigRadio field={field} value={value} onChange={(v) => setField(field.name, v)} />
          ) : field.kind === "checkbox" ? (
            <BigCheckboxGroup
              field={field}
              value={value}
              onChange={(v) => setField(field.name, v)}
            />
          ) : field.kind === "likert" ? (
            <BigLikert field={field} value={value} onChange={(v) => setField(field.name, v)} />
          ) : field.kind === "rating" ? (
            <BigRating field={field} value={value} onChange={(v) => setField(field.name, v)} />
          ) : field.kind === "number" ? (
            <BigTextLike
              field={field}
              value={value}
              onChange={(v) => setField(field.name, v === "" ? "" : Number(v))}
              autoFocus={autoFocus}
            />
          ) : (
            <BigTextLike
              field={field}
              value={value}
              onChange={(v) => setField(field.name, v)}
              autoFocus={autoFocus}
            />
          )}
        </div>
        {field.helpText ? <div style={helpStyle}>{field.helpText}</div> : null}
        {err ? (
          <div role="alert" style={errorStyle}>
            {err}
          </div>
        ) : null}
      </div>
    );
  }

  // ---- Hidden form for server-action submit ----
  // We render a *non-visible* <form> with hidden inputs for every value,
  // plus the same __formId / __slug / __pairingId / __ctx_<key> contract
  // FormRenderer uses. `onSubmitClick` calls requestSubmit() on this form.
  // The submitForm action then reads FormData exactly as on desktop.
  function serializeValue(name: string, raw: unknown): React.ReactNode {
    if (Array.isArray(raw)) {
      // Multi-value checkbox group — emit one hidden input per value with
      // the `[]` suffix the server action knows to strip.
      return raw.map((v, i) => (
        <input
          key={`${name}-${i}`}
          type="hidden"
          name={`${name}[]`}
          value={typeof v === "string" ? v : String(v)}
        />
      ));
    }
    if (raw === undefined || raw === null) return null;
    return (
      <input
        type="hidden"
        name={name}
        value={typeof raw === "string" ? raw : String(raw)}
      />
    );
  }

  return (
    <div
      ref={swipeRef}
      data-testid="mobile-form-runner"
      data-reduced-motion={reducedMotion ? "true" : "false"}
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: "calc(100dvh - 60px)",
        background: "var(--card)",
        borderRadius: "var(--r-3)",
        overflow: "hidden",
        border: "1px solid var(--line)",
        // Allow vertical scroll natively; horizontal travel is the swipe.
        touchAction: "pan-y",
      }}
    >
      {/* Progress dots at top */}
      <div
        style={{
          background: "var(--card)",
          borderBottom: "1px solid var(--line)",
          // Honour iPhone notch with the env() inset, but never collapse to 0.
          paddingTop: "max(8px, env(safe-area-inset-top))",
        }}
      >
        {progressDots}
        {saveState !== "idle" ? (
          <div
            data-testid="mobile-save-state"
            aria-live="polite"
            style={{
              textAlign: "center",
              fontSize: 11,
              color: saveState === "error" ? "var(--rust)" : "var(--ink-3)",
              fontFamily: "var(--mono)",
              paddingBottom: 6,
            }}
          >
            {saveState === "pending"
              ? "Saving…"
              : saveState === "saved"
                ? "Saved"
                : "Save failed — retrying…"}
          </div>
        ) : null}
      </div>

      {/* Scrollable body */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {isReview ? renderReview() : currentField ? renderFieldScreen(currentField) : null}
        {submitError ? (
          <div role="alert" style={{ ...errorStyle, padding: "0 16px 16px" }}>
            {submitError}
          </div>
        ) : null}
      </div>

      {/* Sticky footer — Previous / Next or Submit */}
      <div
        data-testid="mobile-form-footer"
        style={{
          background: "var(--card)",
          borderTop: "1px solid var(--line)",
          display: "flex",
          gap: 10,
          padding: "12px 16px",
          // Safe-area for iPhone home indicator — never below 12px so the
          // buttons sit at the same height on devices with and without a
          // bottom inset.
          paddingBottom: "max(12px, env(safe-area-inset-bottom))",
        }}
      >
        <button
          type="button"
          onClick={goPrev}
          disabled={step === 0}
          data-testid="mobile-form-prev"
          style={{
            flex: 1,
            minHeight: TOUCH_TARGET,
            padding: "12px 14px",
            background: "var(--card-hi)",
            color: step === 0 ? "var(--ink-3)" : "var(--ink)",
            border: "1px solid var(--line)",
            borderRadius: "var(--r-2)",
            fontSize: 15,
            fontWeight: 500,
            cursor: step === 0 ? "not-allowed" : "pointer",
            opacity: step === 0 ? 0.5 : 1,
          }}
        >
          ← Previous
        </button>
        {isReview ? (
          <button
            type="button"
            onClick={onSubmitClick}
            disabled={submitting}
            data-testid="mobile-form-submit"
            style={{
              flex: 1.6,
              minHeight: TOUCH_TARGET,
              padding: "12px 14px",
              background: "var(--ink)",
              color: "var(--paper)",
              border: "1px solid var(--ink)",
              borderRadius: "var(--r-2)",
              fontSize: 15,
              fontWeight: 500,
              cursor: submitting ? "wait" : "pointer",
              opacity: submitting ? 0.7 : 1,
            }}
          >
            {submitting ? "Submitting…" : (submitLabel ?? "Submit")}
          </button>
        ) : (
          <button
            type="button"
            onClick={goNext}
            data-testid="mobile-form-next"
            style={{
              flex: 1.6,
              minHeight: TOUCH_TARGET,
              padding: "12px 14px",
              background: "var(--ink)",
              color: "var(--paper)",
              border: "1px solid var(--ink)",
              borderRadius: "var(--r-2)",
              fontSize: 15,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            {step === fields.length - 1 ? "Review →" : "Next →"}
          </button>
        )}
      </div>

      {/* Hidden form — the server action posts the same FormData shape it
          already understands from FormRenderer (spec 074 contract). */}
      <form
        ref={formRef}
        action={action}
        style={{ display: "none" }}
        aria-hidden="true"
      >
        {formId ? <input type="hidden" name="__formId" value={formId} /> : null}
        {slug ? <input type="hidden" name="__slug" value={slug} /> : null}
        {pairingId ? <input type="hidden" name="__pairingId" value={pairingId} /> : null}
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
        {fields.map((f) => (
          <span key={f.name}>{serializeValue(f.name, values[f.name])}</span>
        ))}
      </form>
    </div>
  );
}
