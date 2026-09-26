"use client";

// A cycle-form textarea that does not lose what was typed when the submit is
// refused (lapsed gate, invalid answer, failed save). See
// lib/observation/drafts.ts for why the browser keeps it and how the key is
// chosen.
//
// CONTROLLED, deliberately. For every <form action> submission React calls
// form.reset() once the action's transition finishes, whatever the outcome, so
// an uncontrolled textarea came back empty after a refusal too. A controlled
// one keeps its text (React keeps its defaultValue in step with the value).
//
// What is shown: the text typed against THIS version of the field's form, else
// the draft saved for it. A new version -- the one thing that means this
// form's text was saved -- therefore shows the (absent) draft for the new
// version: an empty box.
// The saved draft is read through useSyncExternalStore, whose server snapshot
// is null, so the server render and hydration agree and the draft appears
// straight after.

import { useState, useSyncExternalStore, type TextareaHTMLAttributes } from "react";
import { readDraft, saveDraft } from "@/lib/observation/drafts";

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "defaultValue" | "onChange"> & {
  /** draftScope(userId, cycleId, field) */
  draftScope: string;
  /** Moves only when THIS field's form is saved (lib/observation/drafts.ts). */
  draftVersion: string;
};

// sessionStorage can be missing or throw (private modes, blocked storage);
// the textarea then behaves as a plain controlled one.
function sessionStore(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

// sessionStorage is this tab's alone; nothing else writes it while we watch.
const subscribe = () => () => {};

export function DraftTextarea({ draftScope, draftVersion, ...props }: Props) {
  const saved = useSyncExternalStore(
    subscribe,
    () => {
      try {
        const store = sessionStore();
        return store ? readDraft(store, draftScope, draftVersion) : null;
      } catch {
        return null;
      }
    },
    () => null,
  );
  const [typed, setTyped] = useState<{ version: string; text: string } | null>(null);
  const value = typed !== null && typed.version === draftVersion ? typed.text : (saved ?? "");

  return (
    <textarea
      {...props}
      data-draft-key={draftScope + draftVersion}
      value={value}
      onChange={(e) => {
        const text = e.currentTarget.value;
        setTyped({ version: draftVersion, text });
        try {
          const store = sessionStore();
          if (store) saveDraft(store, draftScope, draftVersion, text);
        } catch {
          // Storage full or blocked: the text is still in the box.
        }
      }}
    />
  );
}
