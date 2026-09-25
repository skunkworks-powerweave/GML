// The SCORM 1.2 runtime API a SCO calls through window.API -- executed.
//
// ── WHAT A SCO RELIES ON (SCORM 1.2 RTE, ADL 2001, sections 3.2-3.4) ────────
//
// Eight functions, every argument and result a string: LMSInitialize,
// LMSFinish, LMSGetValue, LMSSetValue, LMSCommit, LMSGetLastError,
// LMSGetErrorString, LMSGetDiagnostic. The data model is read/write,
// read-only or write-only per element; each failure leaves one of the
// standard error codes (101, 201-203, 301, 401-405) for LMSGetLastError. A
// SCO that gets a wrong code, a wrong format, or a value it did not set
// back typically stops tracking without telling anyone.
//
// And what the LMS relies on: a commit carries the SCO's whole persisted
// state, the same session id for every commit of one launch, a number that
// orders it within the launch (the requests can be answered in any order), a
// session time -- the SCO's own report, or the time the launch was open when
// it never reports one -- and, with a mastery score, the status that score
// earns once the SCO has finished.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Scorm12Runtime, type RuntimeInit } from "../../apps/web/src/lib/scorm/runtime.ts";
import type { CommitPayload } from "../../apps/web/src/lib/scorm/cmi.ts";

type Sent = CommitPayload & { final: boolean };

function runtime(over: Partial<RuntimeInit> = {}, opts: { accept?: boolean; now?: () => number } = {}) {
  const sent: Sent[] = [];
  const init: RuntimeInit = {
    studentId: "0b9c7d1e-0000-4000-8000-000000000001",
    studentName: "Dolma, Tsering",
    lessonStatus: "not attempted",
    lessonLocation: "",
    scoreRaw: null,
    scoreMin: null,
    scoreMax: null,
    suspendData: "",
    totalTimeCs: 0,
    entry: "ab-initio",
    launchData: null,
    masteryScore: null,
    ...over,
  };
  const rt = new Scorm12Runtime(init, (p) => (sent.push(p), opts.accept ?? true), { now: opts.now });
  return { api: rt.api, rt, sent };
}

const error = (api: Scorm12Runtime["api"]) => api.LMSGetLastError();

test("nothing works before LMSInitialize(''), which takes only the empty string, once", () => {
  const { api, sent } = runtime();
  assert.equal(api.LMSGetValue("cmi.core.lesson_status"), "");
  assert.equal(error(api), "301");
  assert.equal(api.LMSSetValue("cmi.core.lesson_status", "completed"), "false");
  assert.equal(error(api), "301");
  assert.equal(api.LMSCommit(""), "false");
  assert.equal(api.LMSFinish(""), "false");
  assert.equal(api.LMSGetErrorString("301"), "Not initialized");

  assert.equal(api.LMSInitialize("x"), "false");
  assert.equal(error(api), "201");
  assert.equal(api.LMSInitialize(""), "true");
  assert.equal(error(api), "0");
  assert.equal(api.LMSInitialize(""), "false", "already initialized");
  assert.equal(error(api), "101");
  assert.equal(sent.length, 0, "initializing sends nothing");
});

test("the launch state is what the SCO reads: identity, resume data, total time, mode, mastery, launch data", () => {
  const { api } = runtime({
    lessonStatus: "incomplete",
    lessonLocation: "slide-7",
    scoreRaw: 40,
    suspendData: "q1=a;q2=c",
    totalTimeCs: (3600 + 15 * 60) * 100 + 5,
    entry: "resume",
    launchData: "start=2",
    masteryScore: 80,
  });
  api.LMSInitialize("");
  const read = (el: string) => api.LMSGetValue(el);
  assert.equal(read("cmi._version"), "3.4");
  assert.equal(read("cmi.core.student_id"), "0b9c7d1e-0000-4000-8000-000000000001");
  assert.equal(read("cmi.core.student_name"), "Dolma, Tsering");
  assert.equal(read("cmi.core.lesson_status"), "incomplete");
  assert.equal(read("cmi.core.lesson_location"), "slide-7");
  assert.equal(read("cmi.core.entry"), "resume");
  assert.equal(read("cmi.core.total_time"), "0001:15:00.05");
  assert.equal(read("cmi.core.credit"), "credit");
  assert.equal(read("cmi.core.lesson_mode"), "normal");
  assert.equal(read("cmi.core.score.raw"), "40");
  assert.equal(read("cmi.core.score.max"), "", "blank when never set");
  assert.equal(read("cmi.suspend_data"), "q1=a;q2=c");
  assert.equal(read("cmi.launch_data"), "start=2");
  assert.equal(read("cmi.student_data.mastery_score"), "80");
  assert.equal(read("cmi.core._children"), "student_id,student_name,lesson_location,credit,lesson_status,entry,score,total_time,lesson_mode,exit,session_time");
  assert.equal(read("cmi.core.score._children"), "raw,min,max");
  assert.equal(error(api), "0");
});

test("each misuse leaves its standard error code", () => {
  const { api } = runtime();
  api.LMSInitialize("");
  const get = (el: string, code: string) => {
    assert.equal(api.LMSGetValue(el), "", el);
    assert.equal(error(api), code, `get ${el}`);
  };
  const set = (el: string, value: string, code: string) => {
    assert.equal(api.LMSSetValue(el, value), "false", `${el} = ${value}`);
    assert.equal(error(api), code, `set ${el} = ${JSON.stringify(value)}`);
  };
  get("cmi.core.nope", "201");
  get("", "201");
  get("toString", "201");
  get("__proto__", "201");
  set("constructor", "x", "201");
  get("cmi.core.exit", "404");
  get("cmi.core.session_time", "404");
  get("cmi.core.student_id._children", "202");
  get("cmi.core._count", "203");
  set("cmi.core.student_id", "someone-else", "403");
  set("cmi.core.total_time", "0000:00:01", "403");
  set("cmi.core._children", "x", "402");
  set("cmi._version", "9", "402");
  set("cmi.core.lesson_status", "done", "405");
  set("cmi.core.lesson_status", "not attempted", "405");
  set("cmi.core.score.raw", "101", "405");
  set("cmi.core.score.raw", "abc", "405");
  set("cmi.core.score.min", "-1", "405");
  set("cmi.core.session_time", "1:00:00", "405");
  set("cmi.core.session_time", "0000:61:00", "405");
  set("cmi.core.exit", "quit", "405");
  set("cmi.core.lesson_location", "x".repeat(256), "405");
  set("cmi.suspend_data", "x".repeat(4097), "405");
  set("cmi.student_preference.audio", "101", "405");
  set("cmi.nope", "1", "201");
  assert.match(api.LMSGetDiagnostic(""), /suspend|4096|preference|nope/i, "the diagnostic says what was wrong with the last call");
  assert.equal(api.LMSGetErrorString("405"), "Incorrect data type");
  assert.equal(api.LMSGetErrorString("999"), "");
  // A good call clears the error.
  assert.equal(api.LMSSetValue("cmi.core.score.raw", ""), "true");
  assert.equal(error(api), "0");
});

test("what the SCO sets is read back and committed as its whole state, under one session id", () => {
  const { api, sent } = runtime();
  api.LMSInitialize("");
  assert.equal(api.LMSSetValue("cmi.core.lesson_status", "incomplete"), "true");
  assert.equal(api.LMSSetValue("cmi.core.lesson_location", "slide-3"), "true");
  // SCOs pass numbers as often as strings.
  assert.equal((api.LMSSetValue as (e: string, v: unknown) => string)("cmi.core.score.raw", 72.5), "true");
  assert.equal(api.LMSSetValue("cmi.core.score.min", "0"), "true");
  assert.equal(api.LMSSetValue("cmi.core.score.max", "100"), "true");
  assert.equal(api.LMSSetValue("cmi.suspend_data", "a=1"), "true");
  assert.equal(api.LMSSetValue("cmi.core.exit", "suspend"), "true");
  assert.equal(api.LMSSetValue("cmi.core.session_time", "0000:02:30.5"), "true");
  assert.equal(api.LMSGetValue("cmi.core.score.raw"), "72.5");
  assert.equal(api.LMSGetValue("cmi.suspend_data"), "a=1");
  assert.equal(api.LMSCommit(""), "true");
  assert.equal(api.LMSCommit(""), "true");
  assert.equal(sent.length, 2);
  const [a, b] = sent;
  assert.match(a!.sessionId, /^[0-9a-f-]{36}$/);
  assert.equal(a!.sessionId, b!.sessionId, "one launch, one session");
  assert.deepEqual(
    { ...a, sessionId: "" },
    { sessionId: "", seq: 1, lessonStatus: "incomplete", lessonLocation: "slide-3", scoreRaw: 72.5, scoreMin: 0, scoreMax: 100, suspendData: "a=1", exit: "suspend", sessionTimeCs: 15050, final: false },
  );
  assert.equal(api.LMSCommit("x"), "false");
  assert.equal(error(api), "201");
});

test("every payload carries the session's next number, so the server can tell a late one from a new one", () => {
  const { api, rt, sent } = runtime();
  api.LMSInitialize("");
  api.LMSCommit("");
  rt.flush();
  api.LMSCommit("");
  api.LMSFinish("");
  assert.deepEqual(sent.map((p) => [p.seq, p.final]), [[1, false], [2, false], [3, false], [4, true]]);
  const next = runtime();
  next.api.LMSInitialize("");
  next.api.LMSCommit("");
  assert.equal(next.sent[0]!.seq, 1, "numbered per session");
});

test("a new launch is a new session", () => {
  const one = runtime();
  const two = runtime();
  for (const r of [one, two]) {
    r.api.LMSInitialize("");
    r.api.LMSCommit("");
  }
  assert.notEqual(one.sent[0]!.sessionId, two.sent[0]!.sessionId);
});

test("LMSFinish sends the final state and closes the session; a status the SCO never reported is incomplete", () => {
  const { api, sent } = runtime();
  api.LMSInitialize("");
  assert.equal(api.LMSFinish("x"), "false");
  assert.equal(error(api), "201");
  assert.equal(api.LMSFinish(""), "true");
  assert.equal(sent.at(-1)!.final, true);
  assert.equal(sent.at(-1)!.lessonStatus, "incomplete", "launched, nothing reported: not 'completed', which would overstate it");
  assert.equal(api.LMSGetValue("cmi.core.lesson_status"), "");
  assert.equal(error(api), "301", "nothing works after LMSFinish");
  assert.equal(api.LMSInitialize(""), "false", "a finished session is not reopened");
  assert.equal(error(api), "101");
});

test("with a mastery score, LMSFinish judges a raw score passed or failed (RTE 3.4.4)", () => {
  for (const [raw, status] of [["85", "passed"], ["80", "passed"], ["79.5", "failed"]] as const) {
    const { api, sent } = runtime({ masteryScore: 80 });
    api.LMSInitialize("");
    api.LMSSetValue("cmi.core.lesson_status", "completed");
    api.LMSSetValue("cmi.core.score.raw", raw);
    api.LMSFinish("");
    assert.equal(sent.at(-1)!.lessonStatus, status, `raw ${raw}`);
  }
  const { api, sent } = runtime({ masteryScore: 80 });
  api.LMSInitialize("");
  api.LMSSetValue("cmi.core.lesson_status", "completed");
  api.LMSFinish("");
  assert.equal(sent.at(-1)!.lessonStatus, "completed", "no raw score, nothing to judge");
  const quit = runtime({ masteryScore: 80 });
  quit.api.LMSInitialize("");
  quit.api.LMSSetValue("cmi.core.lesson_status", "incomplete");
  quit.api.LMSSetValue("cmi.core.score.raw", "50");
  quit.api.LMSFinish("");
  assert.equal(quit.sent.at(-1)!.lessonStatus, "failed", "LMSFinish ends the session: its score is judged whatever the status");
});

test("with a mastery score, a finished SCO's score is judged in every commit, so a session that never calls LMSFinish is judged too", () => {
  const { api, rt, sent } = runtime({ masteryScore: 80 });
  api.LMSInitialize("");
  api.LMSSetValue("cmi.core.lesson_status", "incomplete");
  api.LMSSetValue("cmi.core.score.raw", "50");
  api.LMSCommit("");
  rt.flush();
  assert.deepEqual(sent.map((p) => p.lessonStatus), ["incomplete", "incomplete"], "not finished yet: a score part-way is not judged");

  api.LMSSetValue("cmi.core.lesson_status", "completed");
  api.LMSCommit("");
  assert.equal(sent.at(-1)!.lessonStatus, "failed", "completed under the mastery score");
  assert.equal(api.LMSGetValue("cmi.core.lesson_status"), "completed", "the SCO still reads what it set");
  // The tab is closed (pagehide, or hidden and then discarded on a phone).
  rt.flush();
  assert.equal(sent.at(-1)!.lessonStatus, "failed");
  assert.equal(sent.at(-1)!.final, false);

  api.LMSSetValue("cmi.core.score.raw", "90");
  rt.flush();
  assert.equal(sent.at(-1)!.lessonStatus, "passed");
  api.LMSSetValue("cmi.core.lesson_status", "passed");
  api.LMSSetValue("cmi.core.score.raw", "70");
  api.LMSCommit("");
  assert.equal(sent.at(-1)!.lessonStatus, "failed", "the manifest's mastery score decides, not the SCO's own verdict");

  const none = runtime();
  none.api.LMSInitialize("");
  none.api.LMSSetValue("cmi.core.lesson_status", "completed");
  none.api.LMSSetValue("cmi.core.score.raw", "10");
  none.rt.flush();
  assert.equal(none.sent.at(-1)!.lessonStatus, "completed", "no mastery score: the SCO's status stands");
});

test("session time is the SCO's report, or the time the launch was open when it reports none", () => {
  let t = 1_000_000;
  const { api, sent } = runtime({}, { now: () => t });
  api.LMSInitialize("");
  t += 95_430; // 95.43 s
  api.LMSCommit("");
  assert.equal(sent.at(-1)!.sessionTimeCs, 9543);
  api.LMSSetValue("cmi.core.session_time", "0000:00:10");
  api.LMSCommit("");
  assert.equal(sent.at(-1)!.sessionTimeCs, 1000, "the SCO's own report wins");
});

test("a commit the transport cannot take is reported to the SCO", () => {
  const { api } = runtime({}, { accept: false });
  api.LMSInitialize("");
  assert.equal(api.LMSCommit(""), "false");
  assert.equal(error(api), "101");
});

test("objectives and interactions: sequential indexes, counts, write-only interactions", () => {
  const { api } = runtime();
  api.LMSInitialize("");
  assert.equal(api.LMSGetValue("cmi.objectives._count"), "0");
  assert.equal(api.LMSSetValue("cmi.objectives.0.id", "obj-1"), "true");
  assert.equal(api.LMSSetValue("cmi.objectives.0.status", "passed"), "true");
  assert.equal(api.LMSSetValue("cmi.objectives.0.score.raw", "90"), "true");
  assert.equal(api.LMSGetValue("cmi.objectives._count"), "1");
  assert.equal(api.LMSGetValue("cmi.objectives.0.id"), "obj-1");
  assert.equal(api.LMSGetValue("cmi.objectives.0.score.raw"), "90");
  assert.equal(api.LMSGetValue("cmi.objectives._children"), "id,score,status");
  assert.equal(api.LMSSetValue("cmi.objectives.2.id", "skip"), "false", "indexes are filled in order");
  assert.equal(error(api), "201");
  assert.equal(api.LMSGetValue("cmi.objectives.5.id"), "");
  assert.equal(error(api), "201");
  assert.equal(api.LMSSetValue("cmi.objectives.0.status", "great"), "false");
  assert.equal(error(api), "405");

  assert.equal(api.LMSSetValue("cmi.interactions.0.id", "q1"), "true");
  assert.equal(api.LMSSetValue("cmi.interactions.0.type", "choice"), "true");
  assert.equal(api.LMSSetValue("cmi.interactions.0.student_response", "b"), "true");
  assert.equal(api.LMSSetValue("cmi.interactions.0.result", "correct"), "true");
  assert.equal(api.LMSSetValue("cmi.interactions.0.time", "10:15:00"), "true");
  assert.equal(api.LMSSetValue("cmi.interactions.0.latency", "0000:00:12"), "true");
  assert.equal(api.LMSSetValue("cmi.interactions.0.objectives.0.id", "obj-1"), "true");
  assert.equal(api.LMSSetValue("cmi.interactions.0.correct_responses.0.pattern", "b"), "true");
  assert.equal(api.LMSSetValue("cmi.interactions.0.type", "essay"), "false");
  assert.equal(error(api), "405");
  assert.equal(api.LMSGetValue("cmi.interactions._count"), "1");
  assert.equal(api.LMSGetValue("cmi.interactions.0.objectives._count"), "1");
  assert.equal(api.LMSGetValue("cmi.interactions.0.id"), "");
  assert.equal(error(api), "404", "interaction data is write-only in SCORM 1.2");
});

test("preferences and comments round-trip; the eight functions work unbound, as some SCOs call them", () => {
  const { api } = runtime();
  const { LMSInitialize, LMSSetValue, LMSGetValue, LMSGetLastError } = api;
  LMSInitialize("");
  assert.equal(LMSSetValue("cmi.student_preference.audio", "50"), "true");
  assert.equal(LMSGetValue("cmi.student_preference.audio"), "50");
  assert.equal(LMSSetValue("cmi.student_preference.speed", "-100"), "true");
  assert.equal(LMSSetValue("cmi.student_preference.text", "2"), "false");
  assert.equal(LMSGetLastError(), "405");
  assert.equal(LMSSetValue("cmi.comments", "hard module"), "true");
  assert.equal(LMSGetValue("cmi.comments"), "hard module");
  assert.equal(LMSGetValue("cmi.comments_from_lms"), "");
  assert.equal(typeof api.LMSGetErrorString, "function");
  assert.equal(typeof api.LMSGetDiagnostic, "function");
});
