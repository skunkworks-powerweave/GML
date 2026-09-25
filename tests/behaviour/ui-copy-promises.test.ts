// What the dashboard and the sign-in page TELL people matches what the product
// does (F13; the video surfaces' copy is in video-copy.test.ts).
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
//   - The dashboard's confidentiality card said "downloads are disabled". The
//     player serves bearer segment URLs that anyone holding the playlist can
//     fetch until they expire; AntiDownloadGuard calls itself deterrence, not
//     prevention. For classroom recordings of children, a false assurance is
//     worse than none.
//   - The super-admin storage card's hint was the SQL behind it,
//     "SUM(files.size_bytes)".
//   - The sign-in page always said "or request a sign-in link by email", also
//     where email is off and the magic-link tab is hidden.
//   - RTT was "Recruit, Train & Transform" on the sign-in page and in help, and
//     "Refresher Teacher Training" in the page metadata and on teach-back. The
//     programme is Refresher Teacher Training.
//
// ── HOW ──────────────────────────────────────────────────────────────────────
//
// The real dashboard rendered for a super admin against Postgres, the real
// sign-in shell rendered with email on and off, and the real HELP entries.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { signIn, closeAppDb } from "./_server-actions.js";
import { render, renderSync, h, withAppRouter, withIntl, decodeEntities } from "./_ui.js";
import { needsDatabase } from "./_harness.js";
import { observationWorld } from "./_observation-world.js";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

const text = (html: string) => decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");

test("the dashboard promises no disabled download and shows no SQL", { skip }, async () => {
  const w = await observationWorld("copydash");
  try {
    await w.grant(w.admin.id);
    const { default: DashboardPage } = await import("../../apps/web/src/app/(authenticated)/dashboard/page.tsx");
    for (const role of ["super_admin", "teacher"]) {
      signIn({ ...(role === "teacher" ? w.teacher : w.admin), role });
      const said = text(await render(withAppRouter(await DashboardPage())));
      const promise = /.{0,60}(downloads? (are|is) disabled|cannot be downloaded)/i;
      assert.doesNotMatch(said, promise, `${role}: "${said.match(promise)?.[0]}"`);
      assert.doesNotMatch(said, /\bSUM\(|size_bytes|files\./, `${role}: no SQL in the page`);
      assert.match(said, /Confidentiality/);
    }
  } finally {
    await w.cleanup();
  }
});

test("the sign-in page offers an email link only where email works, and names RTT truly", async () => {
  const { DesktopLogin } = await import("../../apps/web/src/app/login/DesktopLogin.tsx");
  const shell = async (emailEnabled: boolean) =>
    text(renderSync(withAppRouter(await withIntl(h(DesktopLogin, { from: "/dashboard", emailEnabled }), "en"))));
  assert.doesNotMatch(await shell(false), /sign-in link by email/i, "email off: no email link is offered");
  assert.match(await shell(true), /sign-in link by email/i, "email on: it is");
  const page = await shell(true);
  assert.doesNotMatch(page, /Recruit,? Train/i);
  assert.match(page, /Refresher Teacher Training/);
});

test("help expands RTT as the programme does", async () => {
  const { HELP } = await import("../../apps/web/src/lib/help.ts");
  const rtt = `${HELP.rtt!.title} ${HELP.rtt!.short} ${HELP.rtt!.long ?? ""}`;
  assert.doesNotMatch(rtt, /Recruit,? Train/i, rtt);
  assert.match(rtt, /Refresher Teacher Training/);
});
