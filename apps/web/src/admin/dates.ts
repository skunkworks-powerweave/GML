// Dates and times in the admin grid, in the programme's timezone.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
//
// The grid rendered every Date as toISOString().slice(0, 10) into a text box.
// Opening a row and saving it -- even after changing only its title -- posted
// "2026-10-01", which became midnight UTC, so every RTT webinar, observation
// schedule and pairing start moved to 05:30 IST on its first edit. Free text
// went through JS Date, which reads 05/10/2026 as 10 May, and the server's
// own timezone decided what an unzoned "2026-10-01T10:30" meant.
//
// Everything here is Asia/Kolkata (UTC+05:30, no daylight saving): the
// programme runs in Ladakh, and a value typed without a zone means what the
// person typing it meant, whatever timezone the server happens to run in.
// Only unambiguous ISO forms are accepted.

/** Asia/Kolkata. Fixed: India has no daylight saving. */
export const PROGRAMME_UTC_OFFSET = "+05:30";
const OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/;
const ZONED_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;
const ZONE = /(?:Z|([+-])(\d{2}):?(\d{2}))$/i;

/** The UTC offset a zoned ISO string names, in milliseconds. */
function zoneOffsetMs(s: string): number {
  const m = ZONE.exec(s);
  if (!m || !m[1]) return 0; // "Z"
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60 * 1000;
}

/** The wall-clock fields of `d` in the programme's timezone, as an ISO prefix. */
function istIso(d: Date): string {
  return new Date(d.getTime() + OFFSET_MS).toISOString();
}

/**
 * A typed or imported date, strictly:
 *   2026-10-01            midnight IST that day
 *   2026-10-01T10:30      10:30 IST (what a datetime-local input submits)
 *   2026-10-01T05:00:00Z  as given (what the CSV export writes)
 * Anything else -- 05/10/2026, "Oct 1", 2026-02-31 -- is an Invalid Date, which
 * the entity's z.coerce.date() rejects rather than guessing.
 */
export function parseAdminDate(raw: string): Date {
  const s = raw.trim();
  let d: Date;
  if (DATE_ONLY.test(s)) d = new Date(`${s}T00:00:00${PROGRAMME_UTC_OFFSET}`);
  else if (LOCAL_DATETIME.test(s)) d = new Date(`${s}${PROGRAMME_UTC_OFFSET}`);
  else if (ZONED_DATETIME.test(s)) d = new Date(s);
  else return new Date(Number.NaN);
  if (Number.isNaN(d.getTime())) return d;
  // Date rolls 2026-02-31 over to 3 March (and T24:00 over to the next day);
  // a date that does not exist is an error. A zoned value is checked in the
  // zone it names: 2026-02-30T00:00:00Z was accepted as 2 March.
  const wallDate = ZONED_DATETIME.test(s)
    ? new Date(d.getTime() + zoneOffsetMs(s)).toISOString().slice(0, 10)
    : istIso(d).slice(0, 10);
  if (wallDate !== s.slice(0, 10)) return new Date(Number.NaN);
  return d;
}

/** "YYYY-MM-DD" in IST: the value of an <input type="date">. */
export function toIstDate(d: Date): string {
  return istIso(d).slice(0, 10);
}

/** "YYYY-MM-DDTHH:mm" in IST: the value of an <input type="datetime-local">. */
export function toIstDateTime(d: Date): string {
  return istIso(d).slice(0, 16);
}

/** [start, end) of one IST calendar day, or null for a value that is not a date. */
export function istDayRange(ymd: string): [Date, Date] | null {
  if (!DATE_ONLY.test(ymd.trim())) return null;
  const start = parseAdminDate(ymd);
  if (Number.isNaN(start.getTime())) return null;
  return [start, new Date(start.getTime() + 24 * 60 * 60 * 1000)];
}

/**
 * The last millisecond of `d`'s IST calendar day. For a field that means "up
 * to and including this day" (a phase's end): stored as the day's START, a
 * phase entered as ending on 31 March stopped being current at 00:00 IST on
 * 31 March, because the dashboard asks `endDate >= now()`. Still that day in
 * the date picker (toIstDate), and idempotent, so saving it again is a no-op.
 */
export function endOfIstDay(d: Date): Date {
  if (Number.isNaN(d.getTime())) return d;
  const [, next] = istDayRange(toIstDate(d))!;
  return new Date(next.getTime() - 1);
}

const MINUTE_MS = 60 * 1000;

/**
 * `next`, with each timestamp that is the stored one cut to the minute put
 * back to the stored value.
 *
 * A datetime-local box shows minutes, so an untouched edit form posts a
 * stored 04:31:17.123 back as 04:31: every save moved the row's time (a
 * pairing's startedAt defaults to now(), seconds and all) and the audit diff
 * recorded a change nobody made. A time the operator actually changed differs
 * by at least a minute and is written as given.
 */
export function keepStoredPrecision(
  before: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...next };
  for (const [field, v] of Object.entries(next)) {
    const stored = before[field];
    if (!(v instanceof Date) || !(stored instanceof Date) || v.getTime() % MINUTE_MS !== 0) continue;
    if (Math.floor(stored.getTime() / MINUTE_MS) * MINUTE_MS === v.getTime()) out[field] = stored;
  }
  return out;
}
