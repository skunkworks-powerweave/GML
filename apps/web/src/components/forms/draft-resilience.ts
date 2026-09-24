// What both form runners do when an autosave does not land.
//
// flushSave used to catch every failure -- offline, a 401 once the session
// had expired, a 500 -- and show "Save failed — retrying…". Nothing retried,
// and the answers lived only in React state, so on a 2G link a teacher who
// typed her last answer while the connection was down and closed the tab lost
// it, having been told it was being retried. These helpers are the pieces the
// two runners (FormRenderer, MobileFormRunner) now share:
//   - a copy of the answers kept on the device (localStorage) from the moment
//     they change until the server has them, and restored on the next visit;
//   - a retry with backoff for failures that can succeed later (offline, 5xx),
//     plus an immediate one when the browser comes back online;
//   - no retry, and a message that says what to do, for the two that cannot
//     (401 session expired, 403 section locked).
//
// The device copy is removed as soon as a save lands, so on a shared school
// phone it exists only while there is something the server does not have.

import { useCallback, useEffect, useRef, useState } from "react";
import { saveDraft, type DraftKey } from "@/lib/form-draft";

export type SaveFailure = "offline" | "error" | "expired" | "locked";
export type SaveState = "idle" | "pending" | "saved" | "error";

/**
 * The autosave both runners share: PUT the latest answers, and on failure
 * keep them on the device and -- when trying again can help -- try again,
 * with backoff and as soon as the browser is back online.
 *
 * `valuesRef` must always hold the latest answers; the runners write it in
 * setField as well as in their commit effect, so a save or a device copy
 * made between a keystroke and the next render is never a stale one.
 */
export function useDraftAutosave(
  draftKey: DraftKey | undefined,
  enabled: boolean,
  valuesRef: { current: Record<string, unknown> },
) {
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [failure, setFailure] = useState<SaveFailure | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const retry = useRef<{ timer: ReturnType<typeof setTimeout> | null; attempt: number }>({ timer: null, attempt: 0 });

  const flushSave = useCallback(async () => {
    if (!enabled || !draftKey) return;
    const attempt = async (): Promise<void> => {
      if (retry.current.timer) clearTimeout(retry.current.timer);
      retry.current.timer = null;
      setSaveState("pending");
      try {
        await saveDraft({ ...draftKey, responses: valuesRef.current });
        retry.current.attempt = 0;
        dropLocalCopy(draftKey);
        setFailure(null);
        setLastSavedAt(Date.now());
        setSaveState("saved");
      } catch (err) {
        const kind = saveFailureKind(err);
        keepLocalCopy(draftKey, valuesRef.current);
        setFailure(kind);
        setSaveState("error");
        if (isRetryable(kind)) {
          retry.current.timer = setTimeout(() => void attempt(), retryDelayMs(retry.current.attempt++));
        }
      }
    };
    await attempt();
  }, [draftKey, enabled, valuesRef]);

  // Back online: send what is waiting now rather than at the next backoff.
  useEffect(() => {
    if (!enabled || !draftKey || typeof window === "undefined") return;
    const onOnline = async () => {
      if (readLocalCopy(draftKey)) await flushSave();
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [draftKey, enabled, flushSave]);

  useEffect(() => {
    const r = retry.current;
    return () => {
      if (r.timer) clearTimeout(r.timer);
    };
  }, []);

  /**
   * Stop a pending retry. Called once a submission is under way: the POST
   * carries the answers, and a draft PUT landing after the submit transaction
   * deleted the draft would re-create it -- "Draft loaded" over a form that
   * was in fact submitted.
   */
  const cancelRetry = useCallback(() => {
    if (retry.current.timer) clearTimeout(retry.current.timer);
    retry.current.timer = null;
  }, []);

  return { saveState, failure, lastSavedAt, flushSave, cancelRetry };
}

/** Classify a saveDraft() rejection. No HTTP status means no response at all. */
export function saveFailureKind(err: unknown): SaveFailure {
  const status = (err as { status?: unknown } | null)?.status;
  if (status === 401) return "expired";
  if (status === 403) return "locked";
  if (typeof status === "number") return "error";
  return "offline";
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
    case "offline":
      return "Offline — answers kept on this device, retrying…";
    default:
      return "Not saved — answers kept on this device, retrying…";
  }
}

function storageKey(key: DraftKey): string | null {
  if (key.templateId) return `gml-form-draft:t:${key.templateId}:${key.pairingId || "-"}`;
  if (key.observationCycleId) return `gml-form-draft:c:${key.observationCycleId}`;
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

export function keepLocalCopy(key: DraftKey, responses: Record<string, unknown>): void {
  const k = storageKey(key);
  const s = store();
  if (!k || !s) return;
  try {
    s.setItem(k, JSON.stringify({ savedAt: Date.now(), responses }));
  } catch {
    // Quota or a disabled store: the server copy is still being attempted.
  }
}

export function readLocalCopy(key: DraftKey): Record<string, unknown> | null {
  const k = storageKey(key);
  const s = store();
  if (!k || !s) return null;
  try {
    const raw = s.getItem(k);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { responses?: unknown };
    return parsed.responses && typeof parsed.responses === "object" ? (parsed.responses as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function dropLocalCopy(key: DraftKey): void {
  const k = storageKey(key);
  const s = store();
  if (!k || !s) return;
  try {
    s.removeItem(k);
  } catch {
    // ignore
  }
}
