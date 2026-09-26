// How long the page took to reach the runner, taken off a timed quiz's
// countdown (W3-18).
//
// The page measures what is left of the attempt as it renders and hands the
// runner that many seconds, which the runner counted from the moment it
// mounted. The time between -- delivering the page and hydrating it -- was
// never taken off: the countdown showed that much more than the server allows,
// and the difference was paid out of the 30 s submit grace. A cold first load
// on 2G (a couple of hundred kB of script) can take longer than the grace, and
// then the auto-submit at 00:00 was refused and every answer discarded.
//
// So the page also sends the database's clock as it rendered, and the runner
// takes off the gap between that and its own clock at mount. They are two
// machines' clocks: a gap that is negative, or longer than any page load, is a
// phone clock set wrong rather than latency, and is ignored -- the countdown
// then starts from mount, as before. A phone clock a little fast costs the
// learner that much time on the countdown, never an answer.

/** The longest gap read as page-load time rather than a wrong clock. */
export const MAX_LOAD_LATENCY_MS = 60_000;

/** Milliseconds to take off the countdown, given the server's clock at render and this device's at mount. */
export function loadLatencyMs(serverNowMs: number | null | undefined, clientNowMs: number): number {
  if (typeof serverNowMs !== "number" || !Number.isFinite(serverNowMs)) return 0;
  const gap = clientNowMs - serverNowMs;
  return gap > 0 && gap <= MAX_LOAD_LATENCY_MS ? gap : 0;
}
