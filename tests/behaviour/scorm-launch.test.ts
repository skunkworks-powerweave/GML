// The SCORM launch page, /scorm/[id]: the real server page against Postgres,
// and the real player component under the _ui.ts hook harness.
//
// ── WHAT MUST HOLD ───────────────────────────────────────────────────────────
//
//   - Only a learner who may launch the package reaches it (lib/scorm/
//     store.ts); anyone else gets the 404 page, a signed-out visitor /login.
//   - The page hands the player the launch URL on OUR origin (the content
//     route, percent-encoded, with the manifest's query) and the learner's
//     resume state, so a relaunch continues where she stopped.
//   - The player installs window.API BEFORE the iframe exists: a SCO calls
//     LMSInitialize as soon as it loads, and one that finds no API runs
//     untracked. The iframe carries SCORM_SANDBOX.
//   - Commits go to /api/scorm/attempts/<id> as JSON with keepalive (they must
//     survive the page closing); the page going away flushes the session; a
//     commit that fails is said so on screen and re-sent when the phone is
//     back online; LMSFinish shows the way back to the subject.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { mount, hostElements, textOf } from "./_ui.js";
import { signIn, closeAppDb, outcome } from "./_server-actions.js";
import { needsDatabase } from "./_harness.js";
import { rttWorld } from "./_rtt-world.js";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

type El = { type: unknown; props: Record<string, unknown> };

/** The first element in a returned (unrendered) tree whose type is `type`. */
function find(node: unknown, type: unknown): El | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = find(n, type);
      if (hit) return hit;
    }
    return null;
  }
  if (!node || typeof node !== "object" || !("props" in node)) return null;
  const el = node as El;
  if (el.type === type) return el;
  return find(el.props.children, type);
}

test("cmi.core.student_name is 'Last, First', from the one name the LMS holds", async () => {
  const { cmiStudentName } = await import("../../apps/web/src/lib/scorm/cmi.ts");
  assert.equal(cmiStudentName("Tsering Angmo Dolma", null), "Dolma, Tsering Angmo");
  assert.equal(cmiStudentName("Stanzin", null), "Stanzin");
  assert.equal(cmiStudentName("  ", "t@example.test"), "t@example.test");
  assert.equal(cmiStudentName(null, null), "Learner");
  assert.equal(cmiStudentName("x".repeat(300), null).length, 255, "a CMIString255");
});

test("the launch page gives the player our-origin launch URL and the learner's resume state; others get a 404", { skip }, async () => {
  const w = await rttWorld("scla");
  try {
    const { insertPackage, commitAttempt } = await import("../../apps/web/src/lib/scorm/store.ts");
    const { default: ScormLaunchPage } = await import("../../apps/web/src/app/(authenticated)/scorm/[id]/page.tsx");
    const { ScormPlayer } = await import("../../apps/web/src/app/(authenticated)/scorm/[id]/player.tsx");
    const db = drizzle(w.c);
    const subjectId = await w.subject({ zoneId: w.zoneId });
    const id = randomUUID();
    await insertPackage(db, {
      id,
      rttSubjectId: subjectId,
      title: `Reading circles ${w.T}`,
      manifestIdentifier: "x",
      launchPath: "sco/my lesson.html",
      launchQuery: "?lang=bo",
      masteryScore: 70,
      launchData: "start=2",
      uploadedByUserId: w.admin.id,
      totalBytes: 1,
      files: [],
    });
    await commitAttempt(db, w.teacher.id, id, {
      sessionId: randomUUID(),
      lessonStatus: "incomplete",
      lessonLocation: "slide-9",
      scoreRaw: null,
      scoreMin: null,
      scoreMax: null,
      suspendData: "q=4",
      exit: "suspend",
      sessionTimeCs: 6000,
    });
    const page = (pid: string) => ScormLaunchPage({ params: Promise.resolve({ id: pid }) });

    signIn(w.teacher);
    const tree = await page(id);
    const player = find(tree, ScormPlayer);
    assert.ok(player, "the page mounts the player");
    const props = player!.props as { packageId: string; src: string; title: string; backHref: string; init: Record<string, unknown> };
    assert.equal(props.packageId, id);
    assert.equal(props.src, `/api/scorm/content/${id}/sco/my%20lesson.html?lang=bo`, "same origin, encoded, the manifest's query kept");
    assert.equal(props.backHref, `/rtt/subject/${subjectId}`);
    assert.equal(props.init.entry, "resume");
    assert.equal(props.init.suspendData, "q=4");
    assert.equal(props.init.lessonLocation, "slide-9");
    assert.equal(props.init.totalTimeCs, 6000);
    assert.equal(props.init.studentId, w.teacher.id);
    assert.equal(props.init.masteryScore, 70);
    assert.equal(props.init.launchData, "start=2");
    assert.match(String(props.init.studentName), /, Teacher$/, "Last, First");

    const outsider = await w.addTeacher("Far", w.zoneYId);
    signIn(outsider.user);
    assert.deepEqual(await outcome(() => page(id)), { kind: "notFound" }, "not taught in her place");
    signIn(w.teacher);
    assert.deepEqual(await outcome(() => page("nope")), { kind: "notFound" });
    signIn(null);
    assert.equal(((await outcome(() => page(id))) as { location?: string }).location?.startsWith("/login"), true);
  } finally {
    signIn(null);
    await w.cleanup();
  }
});

// ── The player, in the hook harness ──────────────────────────────────────────

type Call = { url: string; init: RequestInit };

function fakeBrowser(respond: () => Promise<Response>) {
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, document: g.document, fetch: g.fetch };
  const win = new EventTarget() as EventTarget & Record<string, unknown>;
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const calls: Call[] = [];
  g.window = win;
  g.document = doc;
  g.fetch = (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond();
  };
  return {
    win,
    doc,
    calls,
    restore: () => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete g[k];
        else g[k] = v;
      }
    },
  };
}

const INIT = {
  studentId: "u-1",
  studentName: "Dolma, Tsering",
  lessonStatus: "not attempted" as const,
  lessonLocation: "",
  scoreRaw: null,
  scoreMin: null,
  scoreMax: null,
  suspendData: "",
  totalTimeCs: 0,
  entry: "ab-initio" as const,
  launchData: null,
  masteryScore: null,
};

const settle = () => new Promise((r) => setTimeout(r, 0));

/** A stand-in <iframe> that records whether window.API existed when navigation began. */
function fakeFrame(win: Record<string, unknown>) {
  const frame = { loaded: "", apiAtLoad: false };
  Object.defineProperty(frame, "src", {
    set(v: string) {
      frame.apiAtLoad = Boolean(win.API);
      frame.loaded = v;
    },
    get: () => frame.loaded,
  });
  return frame;
}

/** Render the player and attach its iframe, as React's commit would. */
function attached(ScormPlayer: (p: never) => unknown, props: unknown, win: Record<string, unknown>) {
  const m = mount(ScormPlayer, props as never, { effects: true });
  const iframe = hostElements(m.tree).find((e) => e.type === "iframe");
  assert.ok(iframe, "the frame is part of the page");
  const frame = fakeFrame(win);
  const detach = (iframe!.props.ref as (el: unknown) => (() => void) | void)(frame);
  return { m, iframe: iframe!, frame, detach: () => (typeof detach === "function" ? detach() : undefined) };
}

test("the player installs window.API before the frame navigates, sandboxes it, and commits with keepalive", async () => {
  const { ScormPlayer } = await import("../../apps/web/src/app/(authenticated)/scorm/[id]/player.tsx");
  const { SCORM_SANDBOX } = await import("../../apps/web/src/lib/scorm/sandbox.ts");
  const b = fakeBrowser(async () => new Response("{}", { status: 200 }));
  try {
    const props = { packageId: "p-1", src: "/api/scorm/content/p-1/index.html", title: "Reading", backHref: "/rtt/subject/s", init: INIT };
    // What the server sends: a frame with NOTHING to load, so the SCO cannot
    // start before the page has hydrated and installed the API.
    const first = mount(ScormPlayer, props, { effects: true });
    const bare = hostElements(first.tree).find((e) => e.type === "iframe");
    assert.equal(bare?.props.src, undefined, "no src is rendered");
    assert.equal(b.win.API, undefined, "no API until the frame is attached");
    assert.equal(bare?.props.sandbox, SCORM_SANDBOX);
    assert.equal(bare?.props.title, "Reading");

    const { frame, detach } = attached(ScormPlayer, props, b.win);
    const api = b.win.API as Record<string, (...a: string[]) => string>;
    assert.ok(api, "window.API is installed when the frame is attached");
    for (const fn of ["LMSInitialize", "LMSFinish", "LMSGetValue", "LMSSetValue", "LMSCommit", "LMSGetLastError", "LMSGetErrorString", "LMSGetDiagnostic"]) {
      assert.equal(typeof api[fn], "function", fn);
    }
    assert.equal(frame.loaded, props.src, "then the frame navigates to the launch file");
    assert.equal(frame.apiAtLoad, true, "and the API was already there when it did");

    assert.equal(api.LMSInitialize!(""), "true");
    api.LMSSetValue!("cmi.core.lesson_status", "incomplete");
    assert.equal(api.LMSCommit!(""), "true");
    assert.equal(b.calls.length, 1);
    const [call] = b.calls;
    assert.equal(call!.url, "/api/scorm/attempts/p-1");
    assert.equal(call!.init.method, "POST");
    assert.equal(call!.init.keepalive, true, "a commit must survive the page closing");
    assert.equal((call!.init.headers as Record<string, string>)["content-type"], "application/json");
    assert.equal(JSON.parse(String(call!.init.body)).lessonStatus, "incomplete");

    // The tab is hidden, then the page goes away: each flushes the session.
    b.doc.visibilityState = "hidden";
    b.doc.dispatchEvent(new Event("visibilitychange"));
    b.win.dispatchEvent(new Event("pagehide"));
    assert.equal(b.calls.length, 3);
    assert.equal(JSON.parse(String(b.calls[2]!.init.body)).final, false, "not a finish: the SCO may still be running");

    detach();
    assert.equal(b.win.API, undefined, "the API leaves with the player");
    b.win.dispatchEvent(new Event("pagehide"));
    assert.equal(b.calls.length, 4, "detaching flushed once more; its listeners are gone");
  } finally {
    b.restore();
  }
});

test("a commit that fails is said so and re-sent when back online; LMSFinish shows the way back", async () => {
  const { ScormPlayer } = await import("../../apps/web/src/app/(authenticated)/scorm/[id]/player.tsx");
  let online = false;
  const b = fakeBrowser(async () => (online ? new Response("{}", { status: 200 }) : Promise.reject(new TypeError("offline"))));
  try {
    const props = { packageId: "p-2", src: "/x", title: "T", backHref: "/rtt/subject/s2", init: INIT };
    const { m: live, detach } = attached(ScormPlayer, props, b.win);
    const api = b.win.API as Record<string, (...a: string[]) => string>;
    api.LMSInitialize!("");
    api.LMSSetValue!("cmi.suspend_data", "a=1");
    api.LMSCommit!("");
    await settle();
    const text = () => textOf(live.rerender());
    assert.match(text(), /not saved/i, "the learner is told her progress is not saved yet");

    online = true;
    b.win.dispatchEvent(new Event("online"));
    await settle();
    assert.equal(b.calls.length, 2, "re-sent on reconnect");
    assert.equal(JSON.parse(String(b.calls[1]!.init.body)).suspendData, "a=1");
    assert.doesNotMatch(text(), /not saved/i);

    api.LMSFinish!("");
    await settle();
    const tree = live.rerender();
    assert.match(textOf(tree), /finished/i);
    assert.ok(hostElements(tree).some((e) => e.type === "a" && e.props.href === "/rtt/subject/s2"), "a link back to the subject");
    detach();
  } finally {
    b.restore();
  }
});
