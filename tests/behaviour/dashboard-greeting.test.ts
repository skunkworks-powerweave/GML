// The dashboard greets people by the programme's clock, not UTC's (F132).
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// The greeting took its hour from `new Date().getUTCHours()`. The programme
// runs in IST (UTC+5:30), so every user in Ladakh was told "Late night" from
// 05:30 to 10:30, "Good morning" until 17:30 and "Good evening" after midnight
// -- right about 3 hours in 24. The date line under it used the server
// process's time zone, which is IST only because docker-compose sets TZ; on a
// host without it the date turned over at 05:30 IST.
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// The REAL dashboard is rendered with the clock frozen at chosen instants and
// the process in UTC (as a container without TZ would be), then the helper it
// uses is checked at the edges, midnight included.

import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import { signIn, closeAppDb } from "./_server-actions.js";
import { render, withAppRouter } from "./_ui.js";
import { needsDatabase } from "./_harness.js";
import { observationWorld } from "./_observation-world.js";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

test("the dashboard's greeting and date follow IST, whatever the server's time zone", { skip }, async () => {
  const w = await observationWorld("greet");
  const tz = process.env.TZ;
  process.env.TZ = "UTC";
  try {
    const { default: DashboardPage } = await import("../../apps/web/src/app/(authenticated)/dashboard/page.tsx");
    const cases: Array<[string, RegExp, RegExp]> = [
      // [instant, greeting, date line]
      ["2026-09-25T09:30:00+05:30", /Good morning/, /Friday, 25 September 2026/],
      ["2026-09-25T14:00:00+05:30", /Good afternoon/, /Friday, 25 September 2026/],
      ["2026-09-25T18:00:00+05:30", /Good evening/, /Friday, 25 September 2026/],
      // Before 05:30 IST it is still the 24th in UTC.
      ["2026-09-25T00:20:00+05:30", /Late night/, /Friday, 25 September 2026/],
    ];
    for (const [at, greeting, date] of cases) {
      mock.timers.enable({ apis: ["Date"], now: new Date(at) });
      try {
        signIn(w.teacher);
        const html = await render(withAppRouter(await DashboardPage()));
        const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "").replace(/<[^>]*>/g, "");
        assert.match(h1, greeting, `at ${at}: "${h1}"`);
        assert.match(html.replace(/<[^>]*>/g, ""), date, `at ${at}: the date line is IST's`);
      } finally {
        mock.timers.reset();
      }
    }
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
    await w.cleanup();
  }
});

test("greetingKey: the thresholds in the programme's zone, midnight included", async () => {
  const { greetingKey } = await import("../../apps/web/src/app/(authenticated)/dashboard/greeting.ts");
  const at = (iso: string) => greetingKey(new Date(iso));
  assert.equal(at("2026-09-25T00:00:00+05:30"), "lateNight", "midnight is hour 0, not 24");
  assert.equal(at("2026-09-25T04:59:00+05:30"), "lateNight");
  assert.equal(at("2026-09-25T05:00:00+05:30"), "morning");
  assert.equal(at("2026-09-25T11:59:00+05:30"), "morning");
  assert.equal(at("2026-09-25T12:00:00+05:30"), "afternoon");
  assert.equal(at("2026-09-25T16:59:00+05:30"), "afternoon");
  assert.equal(at("2026-09-25T17:00:00+05:30"), "evening");
  assert.equal(at("2026-09-25T23:59:00+05:30"), "evening");
  // An explicit zone is honoured.
  assert.equal(greetingKey(new Date("2026-09-25T09:30:00Z"), "UTC"), "morning");
});
