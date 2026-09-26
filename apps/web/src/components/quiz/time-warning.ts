// What a timed quiz's countdown SAYS to a screen reader, and when (F135).
//
// Both runners show the countdown as role="timer", which is aria-live="off"
// by definition: its value changes every second. They used to add
// aria-live="polite" to it, so a screen reader queued "08:42", "08:41", ...
// one after another over the question the learner was listening to. The time
// is now spoken only as it crosses a threshold, from a separate polite region
// whose text changes at those moments and at no others.

/** Seconds left at which the learner is told, largest first. */
const THRESHOLDS: ReadonlyArray<readonly [number, string]> = [
  [300, "5 minutes remaining."],
  [60, "1 minute remaining."],
];

/**
 * The warning due with `remaining` seconds left of an attempt that opened
 * with `limit` seconds: "" until the first threshold is crossed, then the
 * latest one crossed. A threshold the attempt opened below is never said --
 * one that opens with 3 minutes left is not told "5 minutes remaining".
 */
export function timeWarning(remaining: number, limit: number): string {
  if (remaining <= 0) return "Time is up. Your answers are being submitted.";
  let said = "";
  for (const [at, text] of THRESHOLDS) if (at < limit && remaining <= at) said = text;
  return said;
}

/**
 * Said instead of the time-up warning above when there was nothing to send: a
 * runner that appeared with no time left and nothing chosen does not submit
 * blank answers (W3-17), so "being submitted" would not be true.
 */
export const TIME_UP_NOTHING_SENT = "Time is up. Nothing was submitted.";
