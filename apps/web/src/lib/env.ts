// Spec 169 — Workflow Run 16 polish: environment-variable validation summary.
//
// Three optional deployment env vars feed user-facing affordances:
//
//   GML_WHATSAPP_NUMBER     — programme WhatsApp number, shown by the
//                              video UploadModal as the PRIMARY ingest
//                              path and used to build the wa.me deep
//                              link in the HelpPanel's "Talk to a
//                              person" card.
//   GML_HELPDESK_PHONE      — secondary helpdesk phone (HelpPanel
//                              wa.me fallback).
//   GML_HELPDESK_EMAIL      — programme admin mailto target for the
//                              HelpPanel "Email admin" button.
//
// Pre-spec-169 these were read with bare `?? null` fallbacks. When an
// operator typo'd a value (missing `+`, a stray space, an empty
// `tel:` prefix) the broken value was silently rendered into the UI
// — the WhatsApp button would launch wa.me with garbage in the path
// and the teacher would see a "couldn't open" error from WhatsApp
// itself with no useful context. We now validate up-front in the
// authenticated layout (server-side, runs once per page load via
// React's per-request render cycle) and downstream consumers
// (UploadModal + HelpPanel) read the validated structure rather than
// reaching into `process.env` directly.
//
// SOFT-FAIL contract: validation problems log SEVERE to console.error
// in production but never throw — a misconfigured helpdesk phone must
// not break the dashboard, FTUX, classroom-observation flow, etc.
// The validated env summary instead surfaces the invalid value as
// `null` so consumers can hide the affected affordance gracefully.

const PHONE_PATTERN = /^\+\d{8,15}$/;
// Simple email regex — intentionally NOT RFC-5322-strict. We only
// need to catch fat-finger typos like a missing `@`, a leading
// space, or a `mailto:` prefix smuggled into the env value. The
// SMTP server is the real authority on whether an address resolves;
// see SMTP_FROM in apps/web/src/lib/email.ts.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Outcome of a single env-var validation.
 *
 *   `present` = the env var is non-empty AND passes the format check.
 *   `value`   = the trimmed env value when present; otherwise null.
 *   `reason`  = human-readable rejection note for the SEVERE log line.
 *               Empty when the var was unset (which is fine — these are
 *               OPTIONAL configuration knobs, not required boot deps).
 */
export type EnvCheck = {
  present: boolean;
  value: string | null;
  reason: string;
};

/**
 * The shape consumers (UploadModal, HelpPanel) read. Each field is the
 * validated `EnvCheck` for the matching env var; downstream code uses
 * `check.value` to render and `check.present` to gate visibility.
 */
export type EnvSummary = {
  whatsappNumber: EnvCheck;
  helpdeskPhone: EnvCheck;
  helpdeskEmail: EnvCheck;
};

/**
 * The programme WhatsApp number to offer a user, or null when WhatsApp cannot
 * take a video: no valid GML_WHATSAPP_NUMBER, or ingest switched off (no
 * WHATSAPP_APP_SECRET, so the webhook refuses every message with 503
 * whatsapp_not_configured). Every "send it by WhatsApp" affordance keys on
 * this, so a deployment without WhatsApp does not steer teachers to it.
 */
export function whatsappPhoneForUsers(): string | null {
  if (!process.env.WHATSAPP_APP_SECRET?.trim()) return null;
  return assertEnv().whatsappNumber.value ?? null;
}

function checkPhone(raw: string | undefined, varName: string): EnvCheck {
  if (!raw) {
    return { present: false, value: null, reason: "" };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return {
      present: false,
      value: null,
      reason: `${varName} is set but empty after trimming whitespace`,
    };
  }
  if (!PHONE_PATTERN.test(trimmed)) {
    return {
      present: false,
      value: null,
      reason: `${varName} = ${JSON.stringify(trimmed)} does not match E.164 pattern /^\\+\\d{8,15}$/`,
    };
  }
  return { present: true, value: trimmed, reason: "" };
}

function checkEmail(raw: string | undefined, varName: string): EnvCheck {
  if (!raw) {
    return { present: false, value: null, reason: "" };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return {
      present: false,
      value: null,
      reason: `${varName} is set but empty after trimming whitespace`,
    };
  }
  if (!EMAIL_PATTERN.test(trimmed)) {
    return {
      present: false,
      value: null,
      reason: `${varName} = ${JSON.stringify(trimmed)} is not a syntactically valid email address`,
    };
  }
  return { present: true, value: trimmed, reason: "" };
}

/**
 * Rejections this process has already logged.
 *
 * assertEnv() runs in the authenticated layout, i.e. on EVERY page render
 * (twice on /videos), and it used to print its SEVERE block every time: one
 * typo in a helpdesk number filled the rotated app log with the same lines and
 * pushed out everything useful. The environment does not change while the
 * process runs, so each rejection is worth one line, the first time it is seen.
 */
const reported = new Set<string>();

/**
 * Validate the optional deployment env vars and return the structured
 * summary downstream consumers read. In production, any SET-but-INVALID
 * variable triggers a SEVERE log line to `console.error` -- once per process,
 * on the first render that meets it -- so the operator sees the
 * misconfiguration. We never throw — a typo'd helpdesk phone must not break
 * the authenticated route tree.
 *
 * The function is safe to call from a server component (process.env is
 * available) and from any other server-side context. Calling it from a
 * client bundle is a programming error; `process.env` will be undefined
 * for non-NEXT_PUBLIC keys and every field will read as absent.
 */
export function assertEnv(): EnvSummary {
  const summary: EnvSummary = {
    whatsappNumber: checkPhone(process.env.GML_WHATSAPP_NUMBER, "GML_WHATSAPP_NUMBER"),
    helpdeskPhone: checkPhone(process.env.GML_HELPDESK_PHONE, "GML_HELPDESK_PHONE"),
    helpdeskEmail: checkEmail(process.env.GML_HELPDESK_EMAIL, "GML_HELPDESK_EMAIL"),
  };

  // Production-only SEVERE log. Dev / test runs stay quiet so the
  // pnpm dev shell isn't spammed every page load while an operator
  // is still wiring the values into their .env.local.
  if (process.env.NODE_ENV === "production") {
    const failures = [
      summary.whatsappNumber.reason,
      summary.helpdeskPhone.reason,
      summary.helpdeskEmail.reason,
    ].filter((r) => r.length > 0 && !reported.has(r));
    if (failures.length > 0) {
      for (const f of failures) reported.add(f);
      console.error(
        "[SEVERE][spec169] assertEnv() rejected " +
          failures.length +
          " configured env value(s); the affected UI affordance(s) will be hidden:\n  - " +
          failures.join("\n  - "),
      );
    }
  }

  return summary;
}
