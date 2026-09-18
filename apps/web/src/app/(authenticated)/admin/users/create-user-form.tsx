"use client";

import { useActionState, useState } from "react";
import { createUserAction, type UserActionState } from "./actions";
import type { RoleName } from "@gml/shared/auth/roles";

type Person = { id: string; name: string };

const ROLE_OPTIONS: { value: RoleName; label: string; adminOnly?: boolean }[] = [
  { value: "teacher", label: "Teacher" },
  { value: "observer", label: "Observer" },
  { value: "mentor", label: "Mentor" },
  { value: "programme_admin", label: "Programme admin", adminOnly: true },
  { value: "super_admin", label: "Super admin", adminOnly: true },
];

const field: React.CSSProperties = {
  padding: "8px 10px",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--r-2, 8px)",
  background: "var(--card-hi)",
  fontSize: 13,
  width: "100%",
};

const labelText: React.CSSProperties = {
  fontSize: 11,
  color: "var(--ink-2)",
  fontWeight: 500,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

/** Generate a readable-but-random initial password so nobody types "Welcome123". */
function suggestPassword(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, "").slice(0, 14);
}

export function CreateUserForm({
  actorRole,
  unlinkedTeachers,
  unlinkedMentors,
}: {
  actorRole: RoleName;
  unlinkedTeachers: Person[];
  unlinkedMentors: Person[];
}) {
  const [state, formAction, pending] = useActionState<UserActionState | undefined, FormData>(
    createUserAction,
    undefined,
  );
  const [password, setPassword] = useState("");
  const [linkKind, setLinkKind] = useState<"" | "teacher" | "mentor">("");

  // The list is filtered here for convenience only. The action re-checks what
  // the caller is allowed to assign, because a select element is trivially
  // edited in the browser.
  const roles = ROLE_OPTIONS.filter((r) => !r.adminOnly || actorRole === "super_admin");
  const people = linkKind === "teacher" ? unlinkedTeachers : linkKind === "mentor" ? unlinkedMentors : [];

  return (
    <form action={formAction} style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
        <label style={{ display: "grid", gap: 4 }}>
          <span style={labelText}>Email</span>
          <input name="email" type="email" required autoComplete="off" style={field} />
        </label>

        <label style={{ display: "grid", gap: 4 }}>
          <span style={labelText}>Full name</span>
          <input name="name" type="text" autoComplete="off" style={field} />
        </label>

        <label style={{ display: "grid", gap: 4 }}>
          <span style={labelText}>Role</span>
          <select name="role" required defaultValue="" style={field}>
            <option value="" disabled>
              Choose…
            </option>
            {roles.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
        <label style={{ display: "grid", gap: 4 }}>
          <span style={labelText}>Initial password</span>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              name="password"
              type="text"
              required
              minLength={8}
              autoComplete="off"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={field}
            />
            <button
              type="button"
              onClick={() => setPassword(suggestPassword())}
              style={{
                padding: "8px 10px",
                border: "1px solid var(--line-2)",
                borderRadius: "var(--r-2, 8px)",
                background: "var(--card-hi)",
                fontSize: 12,
                whiteSpace: "nowrap",
                cursor: "pointer",
              }}
            >
              Generate
            </button>
          </div>
          {/* Shown as plain text on purpose: the administrator has to read it
              out to hand it over, and a masked field they cannot see would be
              copied wrong. It is never stored or logged here -- Supabase holds
              only the hash, and the audit row records that a password was set,
              never the value. */}
          <span style={{ fontSize: 11, color: "var(--ink-3)" }}>
            Shown so you can pass it on. Ask them to change it in Settings.
          </span>
        </label>

        <label style={{ display: "grid", gap: 4 }}>
          <span style={labelText}>Link to</span>
          <select
            name="linkKind"
            value={linkKind}
            onChange={(e) => setLinkKind(e.target.value as "" | "teacher" | "mentor")}
            style={field}
          >
            <option value="">Nobody yet</option>
            <option value="teacher">A teacher record</option>
            <option value="mentor">A mentor record</option>
          </select>
        </label>

        {linkKind ? (
          <label style={{ display: "grid", gap: 4 }}>
            <span style={labelText}>{linkKind === "teacher" ? "Teacher" : "Mentor"}</span>
            <select name="linkId" defaultValue="" style={field}>
              <option value="">Choose…</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {state?.error ? (
        <p role="alert" style={{ color: "var(--danger, #b91c1c)", fontSize: 13 }}>
          {state.error}
        </p>
      ) : null}
      {state?.ok ? (
        <p role="status" style={{ color: "var(--ok-ink, #047857)", fontSize: 13 }}>
          {state.ok}
        </p>
      ) : null}

      <div>
        <button
          type="submit"
          disabled={pending}
          style={{
            padding: "9px 16px",
            borderRadius: "var(--r-2, 8px)",
            border: "none",
            background: "var(--ink)",
            color: "var(--paper)",
            fontSize: 13,
            cursor: pending ? "default" : "pointer",
            opacity: pending ? 0.6 : 1,
          }}
        >
          {pending ? "Creating…" : "Create account"}
        </button>
      </div>
    </form>
  );
}
