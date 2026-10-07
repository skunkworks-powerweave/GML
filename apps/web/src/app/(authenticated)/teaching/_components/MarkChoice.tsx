"use client";

// One student's attendance marks, as radios in the roster form.
//
// Why a component and not four plain radios: React calls form.reset() once a
// <form action> has settled, whatever the action answered. Plain radios with no
// recorded mark come back unticked after a refused save, so every tick she had
// made was gone under a message asking her to mark the class. Here the pick is
// kept in state and handed back as the radios' DEFAULT, which is what a reset
// restores. (Not `checked`: React 19 does not move a controlled radio's default
// with its value, as it does a textarea's in observation/DraftTextarea.)
//
// The state starts from the recorded mark. The page keys each fieldset by that
// mark, so a mark that changes on the server (a save, a CSV) starts it afresh.

import { useState } from "react";

export function MarkChoice({
  name,
  current,
  options,
}: {
  /** The form field: status_<learner id>. */
  name: string;
  /** The recorded mark, or null when none is. */
  current: string | null;
  options: ReadonlyArray<{ value: string; label: string }>;
}) {
  const [picked, setPicked] = useState(current);
  return (
    <>
      {options.map((o) => (
        <label key={o.value} style={{ display: "inline-flex", gap: 4, alignItems: "center", fontSize: 13, minHeight: 32 }}>
          <input type="radio" name={name} value={o.value} defaultChecked={picked === o.value} onChange={() => setPicked(o.value)} required />
          {o.label}
        </label>
      ))}
    </>
  );
}
