"use client";

// A form posted to a server action, with the action's answer shown under it.
//
// The fields are the caller's -- rendered on the server, labelled from the
// server-side bundle -- so this component carries no words of its own: the
// message it shows is the sentence the action returned, already in the
// viewer's language. Used by /admin/grading and /teaching/marks for every
// small form (details, make default, switch off, delete, send for approval).

import type { CSSProperties, ReactNode } from "react";
import { useActionState } from "react";

export type FormState = { ok: boolean; message: string } | undefined;

export function ActionForm({
  action,
  children,
  style,
  testId,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  children: ReactNode;
  style?: CSSProperties;
  testId?: string;
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, undefined);
  return (
    <form action={formAction} style={style} data-testid={testId}>
      {children}
      {state ? (
        <p
          role={state.ok ? "status" : "alert"}
          style={{ margin: "8px 0 0", fontSize: 13, color: state.ok ? "var(--lichen)" : "var(--rust)", lineHeight: 1.45 }}
        >
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
