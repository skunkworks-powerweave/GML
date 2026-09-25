// Keeping what someone typed into a cycle form when the submit does not land.
//
// Three refusals return a user to the cycle with nothing recorded: the section
// grant lapsed while they wrote (8 hours, or a password rotation), so the
// action sent them through /gate; an answer was blank or over the length cap
// (?error=invalid_form); or the save itself failed (?error=submit_failed). In
// each the typed text was thrown away. The server has nothing to give back,
// and must not write on behalf of a user whose grant has lapsed, so the
// browser keeps it: the textarea saves to sessionStorage as it is typed and
// restores itself when the same form is shown again (DraftTextarea.tsx).
//
// "The same form" is the key: user, cycle, field, and a version of that
// field's OWN form, which only that form being saved moves (the cycle page
// uses the cycle's status for a stage form, the number of entries for the
// note). So a draft comes back only onto the version it was typed against: a
// note that was saved does not reappear in the box, saving one form leaves
// what is typed in another alone, and nobody else signing in on the same tab
// sees it. The version was once the cycle's updated_at, which every write
// moves: saving a note emptied an unsent rubric. sessionStorage ends with the
// tab.
//
// Pure functions of a Storage, so tests/behaviour can run them.

export type DraftStore = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

const PREFIX = "gml:obs-draft:";

/** Every version of one field's draft shares this prefix. */
export function draftScope(userId: string, cycleId: string, field: string): string {
  return `${PREFIX}${userId}:${cycleId}:${field}:`;
}

/** The draft saved for this version of the field, or null. Reads only. */
export function readDraft(store: DraftStore, scope: string, version: string): string | null {
  return store.getItem(scope + version);
}

/**
 * Save as typed; an emptied box leaves nothing behind. Drafts of the same
 * field typed against an older version of the cycle go: whatever they were for
 * has since been saved or superseded.
 */
export function saveDraft(store: DraftStore, scope: string, version: string, text: string): void {
  const key = scope + version;
  for (let i = store.length - 1; i >= 0; i--) {
    const k = store.key(i);
    if (k !== null && k.startsWith(scope) && k !== key) store.removeItem(k);
  }
  if (text.trim()) store.setItem(key, text);
  else store.removeItem(key);
}
