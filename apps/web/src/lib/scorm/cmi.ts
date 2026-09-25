// SCORM 1.2 data-model VALUES: the vocabularies and formats of the elements
// this LMS persists, and the check a commit must pass on the server.
//
// Pure and dependency-free, because both sides use it: the runtime adapter in
// the browser (lib/scorm/runtime.ts) validates what a SCO sets, and the commit
// route re-validates what the browser sends -- the browser is not trusted, and
// a learner can call window.API from the console.
//
// References are to the SCORM 1.2 Run-Time Environment (ADL, 2001), section
// 3.4 (data model) and 3.3 (data types).

export const LESSON_STATUSES = ["passed", "completed", "failed", "incomplete", "browsed", "not attempted"] as const;
export type LessonStatus = (typeof LESSON_STATUSES)[number];

/** Statuses that mean the learner finished the SCO (with or without success). */
export const FINISHED_STATUSES: ReadonlySet<string> = new Set(["passed", "completed", "failed"]);

/**
 * Order used when a later session reports a LOWER status than one recorded.
 *
 * A teacher who passed and later reopens a module to review it must not
 * vanish from the staff completion view because the SCO said "incomplete" on
 * the way in; the record keeps her best outcome (store.ts, commitAttempt).
 */
export const STATUS_RANK: readonly LessonStatus[] = ["not attempted", "browsed", "incomplete", "failed", "completed", "passed"];

export const EXIT_VALUES = ["time-out", "suspend", "logout", ""] as const;
export type ExitValue = (typeof EXIT_VALUES)[number];

export const LESSON_LOCATION_MAX = 255;
export const SUSPEND_DATA_MAX = 4096;

/** CMITimespan: HHHH:MM:SS.SS, hours 2-4 digits, seconds to at most 2 decimals. */
const TIMESPAN = /^(\d{2,4}):([0-5]\d):([0-5]\d)(\.\d{1,2})?$/;

/** A CMITimespan in centiseconds, or null when it is not one. */
export function parseTimespan(value: string): number | null {
  const m = TIMESPAN.exec(value);
  if (!m) return null;
  const frac = m[4] ? Math.round(Number(m[4]) * 100) : 0;
  return ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 100 + frac;
}

/** Centiseconds as a CMITimespan, "0000:00:00.00". Hours cap at 9999. */
export function formatTimespan(cs: number): string {
  const total = Math.max(0, Math.min(Math.round(cs), (9999 * 3600 + 59 * 60 + 59) * 100 + 99));
  const hours = Math.floor(total / 360000);
  const minutes = Math.floor((total % 360000) / 6000);
  const seconds = Math.floor((total % 6000) / 100);
  const hundredths = total % 100;
  const two = (n: number) => String(n).padStart(2, "0");
  return `${String(hours).padStart(4, "0")}:${two(minutes)}:${two(seconds)}.${two(hundredths)}`;
}

/** CMIDecimal: an optional sign, up to three integer digits, any decimals. */
export function parseDecimal(value: string): number | null {
  if (!/^-?(\d{1,3}(\.\d*)?|\.\d+)$/.test(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** A score element (raw, min, max): CMIDecimal in 0..100, or blank. */
export function parseScore(value: string): number | null | undefined {
  if (value === "") return null;
  const n = parseDecimal(value);
  return n !== null && n >= 0 && n <= 100 ? n : undefined;
}

/** What the browser sends on LMSCommit / LMSFinish; see parseCommitPayload. */
export type CommitPayload = {
  /** One per LMSInitialize; lets the server fold a session's time in once. */
  sessionId: string;
  lessonStatus: LessonStatus;
  lessonLocation: string;
  scoreRaw: number | null;
  scoreMin: number | null;
  scoreMax: number | null;
  suspendData: string;
  exit: ExitValue;
  /** cmi.core.session_time for this session so far, in centiseconds. */
  sessionTimeCs: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SESSION_CS = (9999 * 3600 + 59 * 60 + 59) * 100 + 99;

const scoreOk = (v: unknown): v is number | null => v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100);

/** The commit body, validated field by field, or null. Unknown fields are ignored. */
export function parseCommitPayload(body: unknown): CommitPayload | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.sessionId !== "string" || !UUID.test(b.sessionId)) return null;
  if (typeof b.lessonStatus !== "string" || !(LESSON_STATUSES as readonly string[]).includes(b.lessonStatus)) return null;
  if (typeof b.lessonLocation !== "string" || b.lessonLocation.length > LESSON_LOCATION_MAX) return null;
  if (!scoreOk(b.scoreRaw) || !scoreOk(b.scoreMin) || !scoreOk(b.scoreMax)) return null;
  if (typeof b.suspendData !== "string" || b.suspendData.length > SUSPEND_DATA_MAX) return null;
  if (typeof b.exit !== "string" || !(EXIT_VALUES as readonly string[]).includes(b.exit)) return null;
  if (typeof b.sessionTimeCs !== "number" || !Number.isInteger(b.sessionTimeCs) || b.sessionTimeCs < 0 || b.sessionTimeCs > MAX_SESSION_CS) {
    return null;
  }
  return {
    sessionId: b.sessionId.toLowerCase(),
    lessonStatus: b.lessonStatus as LessonStatus,
    lessonLocation: b.lessonLocation,
    scoreRaw: b.scoreRaw,
    scoreMin: b.scoreMin,
    scoreMax: b.scoreMax,
    suspendData: b.suspendData,
    exit: b.exit as ExitValue,
    sessionTimeCs: b.sessionTimeCs,
  };
}
