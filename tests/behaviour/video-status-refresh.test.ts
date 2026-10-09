// A video's status updates on the page by itself while it is being processed.
//
// QA on the live site, 9 Oct 2026: "I uploaded a video and it says queued". It
// had finished processing 46 seconds after the upload; the page simply showed
// the status it had when it loaded, and nothing on it said to reload. Every
// page that lists or shows a video now refreshes itself (the server render
// only; nothing the user typed is lost) while one of its videos is still
// received, queued or transcoding, and stops once none is.
//
// What is executed here: the "is it still processing" rule, and the Videos card
// of the session and class pages deciding whether to refresh. The pages that
// render RefreshWhileProcessing themselves are checked at the end.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { request } from "./_ui.js";

const root = resolve(import.meta.dirname, "..", "..");
const card = () => import("../../apps/web/src/components/video/SessionVideosCard.tsx");
const refresher = () => import("../../apps/web/src/components/video/RefreshWhileProcessing.tsx");
const labels = () => import("../../apps/web/src/lib/video/labels.ts");

type El = { type: unknown; props: Record<string, unknown> };
function findAll(node: unknown, type: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) for (const n of node) findAll(n, type, out);
  else if (node && typeof node === "object" && "props" in (node as object)) {
    const el = node as El;
    if (el.type === type) out.push(el);
    findAll(el.props.children, type, out);
  }
  return out;
}

const video = (status: string) => ({
  id: `00000000-0000-4000-8000-00000000000${status.length % 10}`,
  status,
  durationSec: null,
  createdAt: new Date("2026-10-09T07:01:27Z"),
  uploadedBy: "QA",
  sessionId: "00000000-0000-4000-8000-0000000000aa",
  sessionDate: "2026-10-06",
  subject: "Maths",
  topic: "Fractions",
});

test("received, queued and transcoding are still processing; ready, failed and the review states are not", async () => {
  const { isVideoProcessing } = await labels();
  for (const s of ["received", "queued", "transcoding"]) assert.equal(isVideoProcessing(s), true, s);
  for (const s of ["ready", "failed", "review_pending", "reviewed"]) assert.equal(isVideoProcessing(s), false, s);
});

test("the Videos card refreshes itself while a video is processing, and not once all are done", async () => {
  request.locale = "en";
  const { SessionVideosCard } = await card();
  const { RefreshWhileProcessing } = await refresher();

  const busy = await SessionVideosCard({ videos: [video("ready"), video("queued")], upload: null });
  const on = findAll(busy, RefreshWhileProcessing);
  assert.equal(on.length, 1, "a processing video: the card keeps itself current");
  assert.equal(on[0]!.props.active, true);

  const done = await SessionVideosCard({ videos: [video("ready"), video("failed")], upload: null });
  assert.equal(findAll(done, RefreshWhileProcessing).filter((e) => e.props.active).length, 0, "nothing to wait for: no refreshing");
});

test("the refresher re-renders the page on a timer, only while visible, and gives up after a while", () => {
  const src = readFileSync(resolve(root, "apps/web/src/components/video/RefreshWhileProcessing.tsx"), "utf8");
  assert.match(src, /^"use client"/m);
  assert.match(src, /router\.refresh\(\)/, "a server re-render: what the user typed elsewhere on the page is kept");
  assert.match(src, /setInterval/);
  assert.match(src, /clearInterval/, "stopped when the page leaves or nothing is processing");
  assert.match(src, /visibilityState/, "no refreshing a tab nobody is looking at, on a metered connection");
  assert.match(src, /STOP_AFTER_MS/, "a stuck video must not refresh the page forever");
});

test("the uploads page, the video library and the video page use it", () => {
  for (const page of [
    "apps/web/src/app/(authenticated)/uploads/page.tsx",
    "apps/web/src/app/(authenticated)/videos/page.tsx",
    "apps/web/src/app/(authenticated)/videos/[id]/page.tsx",
  ]) {
    const src = readFileSync(resolve(root, page), "utf8");
    assert.match(src, /RefreshWhileProcessing/, `${page} must keep a processing video's status current`);
    assert.match(src, /isVideoProcessing/, `${page} must decide from the videos it shows`);
  }
});
