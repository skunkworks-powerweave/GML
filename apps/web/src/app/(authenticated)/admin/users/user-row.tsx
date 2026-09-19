"use client";

import { useActionState, useState } from "react";
import {
  setRoleAction,
  setActiveAction,
  setPasswordAction,
  type UserActionState,
} from "./actions";
import type { RoleName } from "@gml/shared/auth/roles";

type Props = {
  user: {
    id: string;
    email: string;
    name: string | null;
    role: RoleName;
    active: boolean;
    deleted: boolean;
    lastSeenAt: string | null;
  };
  roleLabel: string;
  actorRole: RoleName;
  isSelf: boolean;
};

const ROLE_VALUES: RoleName[] = [
  "teacher",
  "observer",
  "mentor",
  "programme_admin",
  "super_admin",
];

const control: React.CSSProperties = {
  padding: "6px 8px",
  border: "1px solid var(--line-2)",
  borderRadius: 6,
  background: "var(--card-hi)",
  fontSize: 12,
};

function Feedback({ state }: { state: UserActionState | undefined }) {
  if (state?.error) {
    return (
      <span role="alert" style={{ fontSize: 12, color: "var(--danger, #b91c1c)" }}>
        {state.error}
      </span>
    );
  }
  if (state?.ok) {
    return (
      <span role="status" style={{ fontSize: 12, color: "var(--ok-ink, #047857)" }}>
        {state.ok}
      </span>
    );
  }
  return null;
}

export function UserRow({ user, roleLabel, actorRole, isSelf }: Props) {
  const [roleState, roleForm, rolePending] = useActionState<UserActionState | undefined, FormData>(
    setRoleAction,
    undefined,
  );
  const [activeState, activeForm, activePending] = useActionState<
    UserActionState | undefined,
    FormData
  >(setActiveAction, undefined);
  /**
   * Which of this row's three forms was submitted last.
   *
   * The feedback line used to render `roleState ?? activeState ?? pwState`, and
   * `??` returns the first NON-NULL -- so the moment a role change had run
   * once, roleState was permanently set and the deactivate and set-password
   * forms on the same row could never show anything again. Not just their
   * confirmations: their ERRORS. A failed password change displayed the stale
   * "Role updated" message from earlier, which reads as success.
   */
  const [lastSubmitted, setLastSubmitted] = useState<"role" | "active" | "pw" | null>(null);

  const [pwState, pwForm, pwPending] = useActionState<UserActionState | undefined, FormData>(
    setPasswordAction,
    undefined,
  );
  const [showPw, setShowPw] = useState(false);

  // Mirrors the server's rule so the UI does not offer buttons that will be
  // refused. The server enforces it regardless -- this is courtesy, not a
  // control. Editing yourself is blocked because self-demotion and
  // self-deactivation are the two fastest routes to an unadministerable system.
  const targetIsAdmin = user.role === "super_admin" || user.role === "programme_admin";
  const canManage = !isSelf && (actorRole === "super_admin" || !targetIsAdmin);
  const assignable = ROLE_VALUES.filter(
    (r) =>
      actorRole === "super_admin" || (r !== "super_admin" && r !== "programme_admin"),
  );

  return (
    <div
      style={{
        border: "1px solid var(--line)",
        borderRadius: "var(--r-2, 8px)",
        padding: "12px 14px",
        background: "var(--card)",
        display: "grid",
        gap: 10,
        opacity: user.active && !user.deleted ? 1 : 0.62,
      }}
      data-testid="admin-user-row"
      data-user-active={String(user.active)}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "baseline" }}>
        <strong style={{ fontSize: 14 }}>{user.name || user.email}</strong>
        <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{user.email}</span>
        <span
          style={{
            fontSize: 11,
            padding: "2px 8px",
            borderRadius: 999,
            border: "1px solid var(--line-2)",
          }}
        >
          {roleLabel}
        </span>
        {user.deleted ? (
          <span style={{ fontSize: 11, color: "var(--danger, #b91c1c)" }}>deleted</span>
        ) : !user.active ? (
          <span style={{ fontSize: 11, color: "var(--danger, #b91c1c)" }}>deactivated</span>
        ) : null}
        {isSelf ? <span style={{ fontSize: 11, color: "var(--ink-3)" }}>(you)</span> : null}
        <span style={{ fontSize: 11, color: "var(--ink-3)", marginLeft: "auto" }}>
          {user.lastSeenAt ? `last seen ${user.lastSeenAt.slice(0, 10)}` : "never signed in"}
        </span>
      </div>

      {canManage ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <form
            action={(fd: FormData) => {
              setLastSubmitted("role");
              roleForm(fd);
            }}
            style={{ display: "flex", gap: 6, alignItems: "center" }}
          >
            <input type="hidden" name="userId" value={user.id} />
            <select name="role" defaultValue={user.role} style={control}>
              {assignable.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <button type="submit" disabled={rolePending} style={{ ...control, cursor: "pointer" }}>
              {rolePending ? "Saving…" : "Set role"}
            </button>
          </form>

          <form
            action={(fd: FormData) => {
              setLastSubmitted("active");
              activeForm(fd);
            }}
          >
            <input type="hidden" name="userId" value={user.id} />
            <input type="hidden" name="active" value={user.active ? "false" : "true"} />
            <button
              type="submit"
              disabled={activePending}
              style={{ ...control, cursor: "pointer" }}
            >
              {activePending ? "Saving…" : user.active ? "Deactivate" : "Reactivate"}
            </button>
          </form>

          <button
            type="button"
            onClick={() => setShowPw((v) => !v)}
            style={{ ...control, cursor: "pointer" }}
          >
            {showPw ? "Cancel" : "Set password"}
          </button>
        </div>
      ) : (
        <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
          {isSelf
            ? "Change your own password in Settings. Another administrator must change your role."
            : "Only a super admin can manage administrator accounts."}
        </span>
      )}

      {showPw && canManage ? (
        <form
          action={(fd: FormData) => {
            setLastSubmitted("pw");
            pwForm(fd);
          }}
          style={{ display: "flex", gap: 6, alignItems: "center" }}
        >
          <input type="hidden" name="userId" value={user.id} />
          <input
            name="password"
            type="text"
            required
            minLength={8}
            autoComplete="off"
            placeholder="New password (8+ characters)"
            style={{ ...control, minWidth: 260 }}
          />
          <button type="submit" disabled={pwPending} style={{ ...control, cursor: "pointer" }}>
            {pwPending ? "Saving…" : "Save password"}
          </button>
          <span style={{ fontSize: 11, color: "var(--ink-3)" }}>
            Signs them out everywhere.
          </span>
        </form>
      ) : null}

      {/* The state of the form the user ACTUALLY last submitted -- see
          lastSubmitted above for why `??` was wrong here. */}
      <Feedback
        state={
          lastSubmitted === "role"
            ? roleState
            : lastSubmitted === "active"
              ? activeState
              : lastSubmitted === "pw"
                ? pwState
                : undefined
        }
      />
    </div>
  );
}
