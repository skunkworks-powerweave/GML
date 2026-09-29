"use client";

// A form that posts to a /teaching server action and shows what it answered:
// the error in an alert, a success in a status line. The action translates its
// own messages (lib/teaching/forms.ts), so this component holds no strings and
// its fields -- server-rendered children -- keep their labels in the page's
// namespace. Without JavaScript the form still posts; the page then re-renders
// with the saved data.

import { useActionState, type CSSProperties, type ReactNode } from "react";
import type { ActionState, FormAction } from "@/lib/teaching/forms";

const alertStyle: CSSProperties = { color: "var(--rust)", fontSize: 13, margin: 0 };
const statusStyle: CSSProperties = { color: "var(--lichen)", fontSize: 13, margin: 0 };

export function ActionForm({
  action,
  children,
  style,
}: {
  action: FormAction;
  children: ReactNode;
  style?: CSSProperties;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(action, undefined);
  return (
    <form action={formAction} style={{ display: "grid", gap: 12, minWidth: 0, ...style }}>
      {children}
      {state?.error ? (
        <p role="alert" style={alertStyle}>
          {state.error}
        </p>
      ) : null}
      {state?.ok ? (
        <p role="status" style={statusStyle}>
          {state.ok}
        </p>
      ) : null}
    </form>
  );
}
