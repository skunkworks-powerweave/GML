// What both form runners do when an autosave does not land.
//
// flushSave used to catch every failure -- offline, a 401 once the session
// had expired, a 500 -- and show "Save failed — retrying…". Nothing retried,
// and the answers lived only in React state, so on a 2G link a teacher who
// typed her last answer while the connection was down and closed the tab lost
// it, having been told it was being retried. These helpers are the pieces the
// two runners (FormRenderer, MobileFormRunner) now share:
//   - a copy of the answers kept on the device (localStorage) from the moment
//     they change until the server has them, and restored on the next visit
//     when it is newer than what the server handed the page;
//   - a retry with backoff for failures that can succeed later (offline, a
//     5xx, a 429), plus an immediate one when the browser comes back online;
//   - no retry, and a message that says what to do, for those that cannot
//     (401 session expired, 403 section locked, any other 4xx refusal).
//
// The device copy is removed as soon as a save lands, so on a shared school
// phone it exists only while there is something the server does not have --
// and it is keyed by user as well as form and pairing, so it is only ever
// offered back to the person who typed it.

import { useCallback, useEffect, useRef, useState } from "react";
import { saveDraft, type DraftKey } from "@/lib/form-draft";

export type SaveFailure = "offline" | "error" | "expired" | "locked" | "rejected";
export type SaveState = "idle" | "pending" | "saved" | "error";

/**
 * The autosave both runners share: PUT the latest answers, and on failure
 * keep them on the device and -- when trying again can help -- try again,
 * with backoff and as soon as the browser is back online.
 *
 * `valuesRef` must always hold the latest answers; the runners write it in
 * setField as well as in their commit effect, so a save or a device copy
 * made between a keystroke and the next render is never a stale one.
 *
 * `owner` is the signed-in user the device copy belongs to; without one no
 * copy is kept (see storageKey).
 */
export function useDraftAutosave(
  draftKey: DraftKey | undefined,
  enabled: boolean,
  valuesRef: { current: Record<string, unknown> },
  owner: string | null | undefined,
) {
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [failure, setFailure] = useState<SaveFailure | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  // `epoch` counts cancellations (cancelRetry, unmount); a save started before
  // one must not act after it. `queue` is the save in flight, if any.
  const retry = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    attempt: number;
    epoch: number;
    queue: Promise<void>;
  }>({ timer: null, attempt: 0, epoch: 0, queue: Promise.resolve() });

  const flushSave = useCallback(async () => {
    if (!enabled || !draftKey) return;
    // A SAVE STARTED BEFORE A CANCEL STAYS CANCELLED. cancelRetry() and the
    // unmount cleanup used to clear only a retry timer already pending. A PUT
    // still on the wire -- the debounced save a second before Submit, any save
    // when the user navigates away -- reached its catch afterwards and set a
    // fresh timer nothing cleared: it PUT the draft back after the submit
    // transaction had deleted it ("Draft loaded" over a submitted form), and
    // kept retrying for the rest of the session. A generation, not a one-way
    // flag: after a submission the server sends back (?error=), the runner
    // stays mounted and its later saves must still retry. Nor does a cancelled
    // save keep a device copy: one written after the submission would be newer
    // than it, and be restored and sent on the next visit. setField wrote the
    // copy that matters at keystroke time.
    const epoch = retry.current.epoch;
    const attempt = async (): Promise<void> => {
      if (retry.current.epoch !== epoch) return;
      if (retry.current.timer) clearTimeout(retry.current.timer);
      retry.current.timer = null;
      setSaveState("pending");
      try {
        await saveDraft({ ...draftKey, responses: valuesRef.current });
        if (retry.current.epoch !== epoch) return;
        retry.current.attempt = 0;
        dropLocalCopy(owner, draftKey);
        setFailure(null);
        setLastSavedAt(Date.now());
        setSaveState("saved");
      } catch (err) {
        if (retry.current.epoch !== epoch) return;
        const kind = saveFailureKind(err);
        keepLocalCopy(owner, draftKey, valuesRef.current);
        setFailure(kind);
        setSaveState("error");
        if (isRetryable(kind)) {
          if (retry.current.timer) clearTimeout(retry.current.timer);
          retry.current.timer = setTimeout(() => void enqueue(), retryDelayMs(retry.current.attempt++));
        }
      }
    };
    // ONE SAVE AT A TIME. The runners' Submit does `await flushSave()` so that
    // no PUT lands after the POST; that awaited only the PUT it issued itself,
    // and a debounced one already in flight could still land (or fail and
    // retry) afterwards. Queued, the Submit's save starts once the earlier one
    // has settled, so awaiting it awaits both -- and an older answer can no
    // longer overwrite a newer one by arriving second.
    const enqueue = () => (retry.current.queue = retry.current.queue.then(attempt).catch(() => undefined));
    await enqueue();
  }, [draftKey, enabled, owner, valuesRef]);

  // Back online: send what is waiting now rather than at the next backoff.
  useEffect(() => {
    if (!enabled || !draftKey || typeof window === "undefined") return;
    const onOnline = async () => {
      if (readLocalCopy(owner, draftKey)) await flushSave();
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [draftKey, enabled, flushSave, owner]);

  useEffect(() => {
    const r = retry.current;
    return () => {
      if (r.timer) clearTimeout(r.timer);
      r.timer = null;
      r.epoch += 1;
    };
  }, []);

  /**
   * Stop a pending retry, and any retry a save still in flight would schedule.
   * Called once a submission is under way: the POST carries the answers, and a
   * draft PUT landing after the submit transaction deleted the draft would
   * re-create it -- "Draft loaded" over a form that was in fact submitted.
   */
  const cancelRetry = useCallback(() => {
    if (retry.current.timer) clearTimeout(retry.current.timer);
    retry.current.timer = null;
    retry.current.epoch += 1;
  }, []);

  return { saveState, failure, lastSavedAt, flushSave, cancelRetry };
}

/**
 * Classify a saveDraft() rejection. No HTTP status means no response at all.
 * Only a 5xx or a 429 is the server having a bad moment; any other 4xx is a
 * refusal of this request (a 400, a 404, a 413), and sending the same answers
 * again every minute on a 2G link cannot change it.
 */
export function saveFailureKind(err: unknown): SaveFailure {
  const status = (err as { status?: unknown } | null)?.status;
  if (status === 401) return "expired";
  if (status === 403) return "locked";
  if (typeof status !== "number") return "offline";
  if (status >= 500 || status === 429) return "error";
  return "rejected";
}

/** Worth trying again later: the link was down, or the server had a bad moment. */
export function isRetryable(kind: SaveFailure): boolean {
  return kind === "offline" || kind === "error";
}

/** 2 s, 4 s, 8 s ... capped at a minute. */
export function retryDelayMs(attempt: number): number {
  return Math.min(60_000, 2000 * 2 ** Math.max(0, attempt));
}

export function failureMessage(kind: SaveFailure): string {
  switch (kind) {
    case "expired":
      return "Your session expired — sign in again. Your answers are kept on this device.";
    case "locked":
      return "The mentorship section locked — enter its password again. Your answers are kept on this device.";
    case "rejected":
      return "Not saved — the server refused these answers. They are kept on this device; if it keeps happening, tell your programme administrator.";
    case "offline":
      return "Offline — answers kept on this device, retrying…";
    default:
      return "Not saved — answers kept on this device, retrying…";
  }
}

/**
 * Where this user's copy of this draft lives on the device. The USER is part
 * of the key: on a shared school phone, a key of form and pairing alone
 * offered one teacher's unsaved answers to the next person to open the form.
 * No owner, no copy.
 */
function storageKey(owner: string | null | undefined, key: DraftKey): string | null {
  if (!owner) return null;
  if (key.templateId) return `gml-form-draft:${owner}:t:${key.templateId}:${key.pairingId || "-"}`;
  if (key.observationCycleId) return `gml-form-draft:${owner}:c:${key.observationCycleId}`;
  return null;
}

/** localStorage, or null where it is absent or refuses (private mode, SSR). */
function store(): Storage | null {
  try {
    const s = (globalThis as { localStorage?: Storage }).localStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

type LocalCopy = { savedAt: number; responses: Record<string, unknown> };

export function keepLocalCopy(owner: string | null | undefined, key: DraftKey, responses: Record<string, unknown>): void {
  const k = storageKey(owner, key);
  const s = store();
  if (!k || !s) return;
  try {
    s.setItem(k, JSON.stringify({ savedAt: Date.now(), responses }));
  } catch {
    // Quota or a disabled store: the server copy is still being attempted.
  }
}

export function readLocalCopy(owner: string | null | undefined, key: DraftKey): LocalCopy | null {
  const k = storageKey(owner, key);
  const s = store();
  if (!k || !s) return null;
  try {
    const raw = s.getItem(k);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { savedAt?: unknown; responses?: unknown };
    if (!parsed.responses || typeof parsed.responses !== "object") return null;
    return {
      savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : 0,
      responses: parsed.responses as Record<string, unknown>,
    };
  } catch {
    return null;
  }
}

/**
 * The device copy to restore over what the server handed the page, or null.
 *
 * Only a copy made AFTER the server's (`serverSavedAt`, ms; null when the
 * server has neither a draft nor an answer) is newer. It used to be restored
 * unconditionally, so a stale copy on one phone -- saves failed there, the
 * work went on and was saved from another device -- replaced the newer draft
 * in full. An older copy is dropped. savedAt is this device's clock and
 * serverSavedAt the server's; a phone whose clock is badly wrong compares
 * wrongly, which no ordering without a shared clock avoids.
 */
export function takeNewerLocalCopy(
  owner: string | null | undefined,
  key: DraftKey,
  serverSavedAt: number | null,
): Record<string, unknown> | null {
  const kept = readLocalCopy(owner, key);
  if (!kept) return null;
  if (serverSavedAt !== null && kept.savedAt <= serverSavedAt) {
    dropLocalCopy(owner, key);
    return null;
  }
  return kept.responses;
}

export function dropLocalCopy(owner: string | null | undefined, key: DraftKey): void {
  const k = storageKey(owner, key);
  const s = store();
  if (!k || !s) return;
  try {
    s.removeItem(k);
  } catch {
    // ignore
  }
}

/** Every device copy on this device, whoever it belongs to (storageKey's prefix). */
function allLocalCopyKeys(s: Storage): string[] {
  const keys: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i);
    if (k !== null && k.startsWith("gml-form-draft:")) keys.push(k);
  }
  return keys;
}

/** Whether this device holds form answers the server does not have yet. */
export function hasLocalCopies(): boolean {
  const s = store();
  if (!s) return false;
  try {
    return allLocalCopyKeys(s).length > 0;
  } catch {
    return false;
  }
}

/**
 * Remove every device copy, for sign-out (SignOutButton). A copy is otherwise
 * removed only when a save lands (or a newer one supersedes it on the next
 * visit), and localStorage outlives the tab and the browser, so a shared
 * school machine kept one user's unsent answers after she had signed out. Every owner's, not only the signed-in user's: the button
 * does not know who that is, and a copy an earlier user left behind is just
 * what a shared machine should not keep. The button asks before calling this,
 * since each copy was promised to be kept.
 */
export function clearAllLocalCopies(): void {
  const s = store();
  if (!s) return;
  try {
    for (const k of allLocalCopyKeys(s)) s.removeItem(k);
  } catch {
    // Blocked storage: nothing can be read from it either.
  }
}
