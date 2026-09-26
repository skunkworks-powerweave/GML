// Keeping a learner's quiz answers through a reload (W3-20).
//
// Both runners held the selections in React state only. A reload, a tap on a
// link or the back button remounted the runner with nothing chosen, while the
// attempt -- and on a timed quiz its clock -- carried on at the server. On a
// Ladakh connection a dropped page is ordinary, so the browser keeps them:
// every pick is saved to sessionStorage, and a runner for the same attempt
// puts them back.
//
// The key is user, quiz and attempt. So answers come back only onto the
// attempt they were chosen in (a retake is a new attempt and starts empty),
// nobody else signing in on the same tab sees them, and a save drops what an
// earlier attempt at the same quiz left behind -- not another quiz's, which
// may still be open. They are NOT cleared as the submit goes: a successful
// submit redirects, so there is no dependable moment after it, and clearing
// before it would lose the answers to a POST that never arrives (a tab
// discarded mid-upload on 2G). An entry left by a closed attempt can never be
// shown again, since no runner is rendered for that attempt, and
// sessionStorage ends with the tab.
//
// What is read back is checked against the quiz as it is now: an entry for a
// question that has gone, or an option index it no longer has, is dropped.
//
// Pure functions of a Storage, so tests/behaviour can run them; the hook at
// the end is what the runners use.

import { useMemo, useState, useSyncExternalStore } from "react";

export type AnswerStore = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

const PREFIX = "gml:quiz-answers:";

/** Every attempt of one learner at one quiz shares this prefix. */
export function answersScope(userId: string, quizSlug: string): string {
  return `${PREFIX}${userId}:${quizSlug}:`;
}

/** The raw entry saved for this attempt, or null. Reads only. */
export function readAnswers(store: AnswerStore, scope: string, attemptId: string): string | null {
  return store.getItem(scope + attemptId);
}

/**
 * The picks in a saved entry that still name one of these questions and one
 * of its options; {} for anything else, malformed JSON included.
 */
export function parseAnswers(
  raw: string | null,
  questions: ReadonlyArray<{ id: string; options: readonly unknown[] }>,
): Record<string, number> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, number> = {};
  for (const q of questions) {
    const pick = (parsed as Record<string, unknown>)[q.id];
    if (typeof pick === "number" && Number.isInteger(pick) && pick >= 0 && pick < q.options.length) out[q.id] = pick;
  }
  return out;
}

/** Save this attempt's picks; entries of the learner's other attempts at this quiz go. */
export function saveAnswers(store: AnswerStore, scope: string, attemptId: string, picks: Record<string, number>): void {
  const key = scope + attemptId;
  for (let i = store.length - 1; i >= 0; i--) {
    const k = store.key(i);
    if (k !== null && k.startsWith(scope) && k !== key) store.removeItem(k);
  }
  store.setItem(key, JSON.stringify(picks));
}

// sessionStorage can be missing or throw (private modes, blocked storage); the
// runner then keeps the answers in memory only, as it always did.
function sessionStore(): AnswerStore | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

// sessionStorage is this tab's alone; nothing else writes it while we watch.
const subscribe = () => () => {};

/**
 * A runner's selections: what was picked in this mount, else what this
 * attempt had saved. Read through useSyncExternalStore, whose server snapshot
 * is null, so the server render and hydration agree and the saved picks
 * appear straight after. Without a user or an attempt nothing is saved.
 */
export function useQuizAnswers(
  userId: string | null | undefined,
  slug: string,
  attemptId: string | null | undefined,
  questions: ReadonlyArray<{ id: string; options: readonly unknown[] }>,
): [Record<string, number>, (questionId: string, pick: number) => void] {
  const scope = userId && attemptId ? answersScope(userId, slug) : null;
  const saved = useSyncExternalStore(
    subscribe,
    () => {
      try {
        const store = sessionStore();
        return store && scope && attemptId ? readAnswers(store, scope, attemptId) : null;
      } catch {
        return null;
      }
    },
    () => null,
  );
  const [picked, setPicked] = useState<Record<string, number> | null>(null);
  const selected = useMemo(() => picked ?? parseAnswers(saved, questions), [picked, saved, questions]);
  const pick = (questionId: string, index: number) => {
    const next = { ...selected, [questionId]: index };
    setPicked(next);
    try {
      const store = sessionStore();
      if (store && scope && attemptId) saveAnswers(store, scope, attemptId, next);
    } catch {
      // Storage full or blocked: the pick still holds in memory.
    }
  };
  return [selected, pick];
}
