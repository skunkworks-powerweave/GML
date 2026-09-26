"use client";

// A form's submit button that is disabled, and says so, while its form is
// submitting. The core mentorship and observation forms are server-rendered
// <form action> buttons; on 2G a second tap while the first was in flight
// recorded a meeting or a note twice, or answered a pre-form that had already
// gone in with "can't be performed in the cycle's current status" (FR-27).

import type { ButtonHTMLAttributes } from "react";
import { useFormStatus } from "react-dom";

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> & {
  /** What the button says while the form is being sent. */
  pendingLabel?: string;
};

export function SubmitButton({ children, pendingLabel = "Saving…", disabled, ...rest }: Props) {
  const { pending } = useFormStatus();
  return (
    <button {...rest} type="submit" disabled={pending || disabled} aria-busy={pending || undefined}>
      {pending ? pendingLabel : children}
    </button>
  );
}
