"use client";

// The "Request an account" form. One column at every width: it is filled in
// on a phone as often as not. Copy is login.requestAccount.* (and role.*),
// from the chrome bundle the layout provides.
//
// Its action answers with codes (./fields.ts); a refused form comes back with
// what was typed, and the fields to correct are marked and described.

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { requestAccountAction } from "./actions";
import {
  HONEYPOT_FIELD,
  REQUESTABLE_ROLES,
  type RequestAccountField,
  type RequestAccountState,
} from "./fields";

type School = { id: string; name: string };

const inputStyle: React.CSSProperties = {
  minHeight: 44,
  padding: "10px 12px",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--r-2)",
  background: "var(--card-hi)",
  // 16px stops iOS zooming in on focus.
  fontSize: 16,
  width: "100%",
  boxSizing: "border-box",
};

const labelStyle: React.CSSProperties = { fontSize: 13, color: "var(--ink-2)", fontWeight: 500 };

/** A field's message when the action asked for it to be corrected. */
function Problem({ field, invalid }: { field: RequestAccountField; invalid: Set<RequestAccountField> }) {
  const t = useTranslations("login.requestAccount");
  if (!invalid.has(field)) return null;
  return (
    <span id={`request-${field}-error`} style={{ fontSize: 13, color: "var(--rust)" }}>
      {t(`invalid.${field}`)}
    </span>
  );
}

export function RequestAccountForm({ schools }: { schools: School[] }) {
  const [state, formAction, pending] = useActionState<RequestAccountState | undefined, FormData>(
    requestAccountAction,
    undefined,
  );
  const t = useTranslations("login.requestAccount");
  const tRole = useTranslations("role");

  if (state?.done) {
    return (
      <p role="status" data-testid="request-account-done" style={{ fontSize: 15, lineHeight: 1.55 }}>
        {t("done")}
      </p>
    );
  }

  const values = state?.values ?? {};
  const invalid = new Set(state?.invalid ?? []);
  /** Marks a field to correct, and points it at its message (<Problem>). */
  const described = (field: RequestAccountField) =>
    invalid.has(field) ? { "aria-invalid": true, "aria-describedby": `request-${field}-error` } : {};

  return (
    <form action={formAction} style={{ display: "grid", gap: 16 }} data-testid="request-account-form">
      <label style={{ display: "grid", gap: 6 }}>
        <span style={labelStyle}>{t("fullName")}</span>
        <input
          name="fullName"
          type="text"
          required
          maxLength={160}
          autoComplete="name"
          defaultValue={values.fullName ?? ""}
          style={inputStyle}
          {...described("fullName")}
        />
        <Problem field="fullName" invalid={invalid} />
      </label>

      <label style={{ display: "grid", gap: 6 }}>
        <span style={labelStyle}>{t("email")}</span>
        <input
          name="email"
          type="email"
          required
          maxLength={254}
          autoComplete="email"
          defaultValue={values.email ?? ""}
          style={inputStyle}
          {...described("email")}
        />
        <Problem field="email" invalid={invalid} />
      </label>

      <label style={{ display: "grid", gap: 6 }}>
        <span style={labelStyle}>{t("phone")}</span>
        <input
          name="phone"
          type="tel"
          maxLength={32}
          autoComplete="tel"
          defaultValue={values.phone ?? ""}
          style={inputStyle}
          {...described("phone")}
        />
        <Problem field="phone" invalid={invalid} />
      </label>

      <label style={{ display: "grid", gap: 6 }}>
        <span style={labelStyle}>{t("role")}</span>
        <select name="role" required defaultValue={values.role ?? "teacher"} style={inputStyle} {...described("role")}>
          {REQUESTABLE_ROLES.map((r) => (
            <option key={r} value={r}>
              {tRole(r)}
            </option>
          ))}
        </select>
        <Problem field="role" invalid={invalid} />
      </label>

      <label style={{ display: "grid", gap: 6 }}>
        <span style={labelStyle}>{t("school")}</span>
        <select name="school" defaultValue={values.school ?? ""} style={inputStyle} {...described("school")}>
          <option value="">{t("schoolNone")}</option>
          {schools.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{t("schoolHint")}</span>
        <Problem field="school" invalid={invalid} />
      </label>

      <label style={{ display: "grid", gap: 6 }}>
        <span style={labelStyle}>{t("message")}</span>
        <textarea
          name="message"
          rows={4}
          maxLength={2000}
          defaultValue={values.message ?? ""}
          style={{ ...inputStyle, minHeight: 96, resize: "vertical" }}
          {...described("message")}
        />
        <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{t("messageHint")}</span>
        <Problem field="message" invalid={invalid} />
      </label>

      {/* The honeypot. Off screen and out of the tab order; a person never
          fills it in, and the action records nothing when it is filled. */}
      <div aria-hidden="true" style={{ position: "absolute", left: -10000, width: 1, height: 1, overflow: "hidden" }}>
        <input name={HONEYPOT_FIELD} type="text" tabIndex={-1} autoComplete="off" defaultValue="" aria-label={t("honeypot")} />
      </div>

      {state?.error ? (
        <p role="alert" style={{ fontSize: 14, color: "var(--rust)" }}>
          {t(`error.${state.error}`)}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        aria-busy={pending || undefined}
        className="btn btn-primary"
        style={{ minHeight: 44, width: "100%", justifyContent: "center", fontSize: 15, opacity: pending ? 0.6 : 1 }}
      >
        {pending ? t("sending") : t("submit")}
      </button>
    </form>
  );
}
