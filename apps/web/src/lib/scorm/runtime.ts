// The SCORM 1.2 runtime API: what a SCO calls through window.API.
//
// ── CONTRACT (SCORM 1.2 RTE, ADL 2001, sections 3.2-3.4) ────────────────────
//
// Eight functions; every argument and result is a string. LMSInitialize("")
// opens the one session a launch has, LMSFinish("") closes it, and between
// them LMSGetValue / LMSSetValue read and write the CMI data model, whose
// elements are each read/write, read-only or write-only. A failed call
// returns "" or "false" and leaves a code for LMSGetLastError:
//   101 general  201 invalid argument  202 no children  203 not an array
//   301 not initialized  401 not implemented  402 keyword  403 read only
//   404 write only  405 incorrect data type
//
// ── WHAT IS KEPT ─────────────────────────────────────────────────────────────
//
// Persisted per learner (lib/scorm/store.ts): lesson_status, lesson_location,
// score raw/min/max, suspend_data, exit, and the session's time. Every commit
// sends that WHOLE state, so a commit lost on a bad connection is repaired by
// the next one, and is numbered within the session, so one answered late
// cannot overwrite a newer one. Objectives, interactions, comments and
// preferences are accepted with full validation -- a SCO that cannot set them
// stops tracking -- and live for the launch only.
//
// ── LMS BEHAVIOUR THE SPEC LEAVES TO THE LMS ─────────────────────────────────
//
//   - A SCO that finishes without ever reporting a status is recorded as
//     "incomplete": it was launched, and nothing said it was completed.
//   - With a mastery score from the manifest, a reported raw score is judged
//     passed / failed (RTE 3.4.4, cmi.student_data.mastery_score) -- in
//     LMSFinish's commit whatever the status, since the session is over, and
//     in every other commit once the SCO says it has finished (completed,
//     passed, failed). So a session that ends without LMSFinish, in a closed
//     tab, is judged too, and a score part-way through is not. The judgement
//     is what is RECORDED; the SCO still reads back the status it set.
//   - Session time is the SCO's cmi.core.session_time; a SCO that never
//     reports one is credited with the time the launch was open.
//
// Pure: the transport (the player's fetch) is injected, so the behaviour
// suite drives this exactly as a SCO would.

import {
  EXIT_VALUES,
  FINISHED_STATUSES,
  LESSON_LOCATION_MAX,
  LESSON_STATUSES,
  SUSPEND_DATA_MAX,
  formatTimespan,
  parseDecimal,
  parseScore,
  parseTimespan,
  type CommitPayload,
  type LessonStatus,
} from "./cmi";

export const SCORM_ERRORS: Readonly<Record<string, string>> = {
  "0": "No error",
  "101": "General exception",
  "201": "Invalid argument error",
  "202": "Element cannot have children",
  "203": "Element not an array - cannot have count",
  "301": "Not initialized",
  "401": "Not implemented error",
  "402": "Invalid set value, element is a keyword",
  "403": "Element is read only",
  "404": "Element is write only",
  "405": "Incorrect data type",
};

export type RuntimeInit = {
  studentId: string;
  studentName: string;
  lessonStatus: LessonStatus;
  lessonLocation: string;
  scoreRaw: number | null;
  scoreMin: number | null;
  scoreMax: number | null;
  suspendData: string;
  totalTimeCs: number;
  entry: "ab-initio" | "resume" | "";
  launchData: string | null;
  masteryScore: number | null;
};

/** Hand a commit to the network. Returns false when it could not even be sent. */
export type CommitTransport = (payload: CommitPayload & { final: boolean }) => boolean;

export type Scorm12Api = {
  LMSInitialize(arg: string): string;
  LMSFinish(arg: string): string;
  LMSGetValue(element: string): string;
  LMSSetValue(element: string, value: string): string;
  LMSCommit(arg: string): string;
  LMSGetLastError(): string;
  LMSGetErrorString(code: string): string;
  LMSGetDiagnostic(code: string): string;
};

const CORE_CHILDREN = "student_id,student_name,lesson_location,credit,lesson_status,entry,score,total_time,lesson_mode,exit,session_time";
const SCORE_CHILDREN = "raw,min,max";
const OBJECTIVE_CHILDREN = "id,score,status";
const INTERACTION_CHILDREN = "id,objectives,time,type,correct_responses,weighting,student_response,result,latency";
const SETTABLE_STATUSES: ReadonlySet<string> = new Set(LESSON_STATUSES.filter((s) => s !== "not attempted"));
const OBJECTIVE_STATUSES: ReadonlySet<string> = new Set(LESSON_STATUSES);
const EXITS: ReadonlySet<string> = new Set(EXIT_VALUES);
const INTERACTION_TYPES: ReadonlySet<string> = new Set(["true-false", "choice", "fill-in", "matching", "performance", "likert", "sequencing", "numeric"]);
const RESULTS: ReadonlySet<string> = new Set(["correct", "wrong", "unanticipated", "neutral"]);

const identifier = (v: string) => /^\S{1,255}$/.test(v);
const feedback = (v: string) => v.length <= 255;
const cmiTime = (v: string) => /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,2})?$/.test(v);
const integerIn = (min: number, max: number) => (v: string) => /^-?\d+$/.test(v) && Number(v) >= min && Number(v) <= max;
const decimal = (v: string) => parseDecimal(v) !== null;
const score = (v: string) => parseScore(v) !== undefined;

/** An element's accessors. No `get`: write-only. No `set`: read-only. */
type Element = { get?: () => string; set?: (value: string) => boolean; keyword?: boolean; detail?: string };

type Objective = { id: string; status: string; raw: string; min: string; max: string };
type Interaction = { fields: Map<string, string>; objectives: string[]; patterns: string[] };

/** RFC 4122 v4 from getRandomValues, which (unlike randomUUID) exists outside secure contexts. */
function uuid(): string {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const blank = (n: number | null) => (n === null ? "" : String(n));
const num = (s: string) => (s === "" ? null : Number(s));

export class Scorm12Runtime {
  readonly api: Scorm12Api;
  readonly sessionId = uuid();

  private phase: "idle" | "running" | "finished" = "idle";
  /** The last commit's number in this session (CommitPayload.seq). */
  private seq = 0;
  private lastError = "0";
  private diagnostic = "";
  private startedAt = 0;
  private readonly now: () => number;

  private lessonStatus: string;
  private lessonLocation: string;
  private scoreRaw: string;
  private scoreMin: string;
  private scoreMax: string;
  private suspendData: string;
  private exit = "";
  private sessionTimeCs: number | null = null;
  private comments = "";
  private readonly prefs = new Map([["audio", "0"], ["language", ""], ["speed", "0"], ["text", "0"]]);
  private readonly objectives: Objective[] = [];
  private readonly interactions: Interaction[] = [];
  private readonly elements: Record<string, Element>;

  constructor(
    private readonly init: RuntimeInit,
    private readonly transport: CommitTransport,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.lessonStatus = init.lessonStatus;
    this.lessonLocation = init.lessonLocation;
    this.scoreRaw = blank(init.scoreRaw);
    this.scoreMin = blank(init.scoreMin);
    this.scoreMax = blank(init.scoreMax);
    this.suspendData = init.suspendData;
    this.elements = this.scalars();
    // Bound, because some SCOs keep a reference to one function and call it
    // bare.
    this.api = {
      LMSInitialize: (arg) => this.initialize(arg),
      LMSFinish: (arg) => this.finish(arg),
      LMSGetValue: (element) => this.getValue(element),
      LMSSetValue: (element, value) => this.setValue(element, value),
      LMSCommit: (arg) => this.commit(arg),
      LMSGetLastError: () => this.lastError,
      LMSGetErrorString: (code) => SCORM_ERRORS[String(code)] ?? "",
      LMSGetDiagnostic: (code) =>
        code === "" || code === undefined || String(code) === this.lastError ? this.diagnostic : SCORM_ERRORS[String(code)] ?? "",
    };
  }

  /** Is a session open? The player flushes one when the page goes away. */
  get running(): boolean {
    return this.phase === "running";
  }

  /** Send the current state without closing the session (pagehide, tab hidden). */
  flush(): boolean {
    return this.phase === "running" ? this.transport(this.payload(false)) : false;
  }

  private ok(result: string): string {
    this.lastError = "0";
    this.diagnostic = "";
    return result;
  }

  private fail(code: string, diagnostic: string, result: string): string {
    this.lastError = code;
    this.diagnostic = diagnostic;
    return result;
  }

  private initialize(arg: unknown): string {
    if (arg !== "" && arg !== undefined) return this.fail("201", "LMSInitialize takes the empty string", "false");
    if (this.phase === "running") return this.fail("101", "LMSInitialize was already called", "false");
    if (this.phase === "finished") return this.fail("101", "this launch's session has finished; relaunch the module", "false");
    this.phase = "running";
    this.startedAt = this.now();
    return this.ok("true");
  }

  private commit(arg: unknown): string {
    if (this.phase !== "running") return this.fail("301", "LMSCommit before LMSInitialize or after LMSFinish", "false");
    if (arg !== "" && arg !== undefined) return this.fail("201", "LMSCommit takes the empty string", "false");
    return this.transport(this.payload(false)) ? this.ok("true") : this.fail("101", "the commit could not be sent", "false");
  }

  private finish(arg: unknown): string {
    if (this.phase !== "running") return this.fail("301", "LMSFinish before LMSInitialize or after LMSFinish", "false");
    if (arg !== "" && arg !== undefined) return this.fail("201", "LMSFinish takes the empty string", "false");
    if (this.lessonStatus === "not attempted") this.lessonStatus = "incomplete";
    const sent = this.transport(this.payload(true));
    this.phase = "finished";
    return sent ? this.ok("true") : this.fail("101", "the final commit could not be sent", "false");
  }

  /** The status to record: the SCO's, or the mastery judgement of its score (see the top of this file). */
  private recordedStatus(final: boolean): LessonStatus {
    const mastery = this.init.masteryScore;
    if (mastery === null || this.scoreRaw === "" || !(final || FINISHED_STATUSES.has(this.lessonStatus))) {
      return this.lessonStatus as LessonStatus;
    }
    return Number(this.scoreRaw) >= mastery ? "passed" : "failed";
  }

  private payload(final: boolean): CommitPayload & { final: boolean } {
    return {
      sessionId: this.sessionId,
      seq: ++this.seq,
      lessonStatus: this.recordedStatus(final),
      lessonLocation: this.lessonLocation,
      scoreRaw: num(this.scoreRaw),
      scoreMin: num(this.scoreMin),
      scoreMax: num(this.scoreMax),
      suspendData: this.suspendData,
      exit: this.exit as CommitPayload["exit"],
      sessionTimeCs: this.sessionTimeCs ?? Math.max(0, Math.round((this.now() - this.startedAt) / 10)),
      final,
    };
  }

  private getValue(raw: unknown): string {
    const element = String(raw ?? "");
    if (this.phase !== "running") return this.fail("301", "LMSGetValue before LMSInitialize or after LMSFinish", "");
    const found = this.lookup(element, "get");
    if (typeof found === "string") return this.fail(found, `${element || "(empty)"}: ${SCORM_ERRORS[found]}`, "");
    if (!found.get) return this.fail("404", `${element} is write-only`, "");
    return this.ok(found.get());
  }

  private setValue(raw: unknown, rawValue: unknown): string {
    const element = String(raw ?? "");
    const value = String(rawValue ?? "");
    if (this.phase !== "running") return this.fail("301", "LMSSetValue before LMSInitialize or after LMSFinish", "false");
    const found = this.lookup(element, "set", value);
    if (typeof found === "string") return this.fail(found, `${element || "(empty)"}: ${SCORM_ERRORS[found]}`, "false");
    if (found.keyword) return this.fail("402", `${element} is a keyword`, "false");
    if (!found.set) return this.fail("403", `${element} is read-only`, "false");
    if (!found.set(value)) return this.fail("405", `${element} cannot be ${JSON.stringify(value.slice(0, 40))}${found.detail ? ` (${found.detail})` : ""}`, "false");
    return this.ok("true");
  }

  private field(get: () => string, set: (v: string) => void, valid: (v: string) => boolean, detail?: string): Element {
    return { get, set: (v) => (valid(v) ? (set(v), true) : false), detail };
  }

  private scalars(): Record<string, Element> {
    const ro = (v: () => string): Element => ({ get: v });
    const kw = (v: () => string): Element => ({ get: v, keyword: true });
    return {
      "cmi._version": kw(() => "3.4"),
      "cmi.core._children": kw(() => CORE_CHILDREN),
      "cmi.core.student_id": ro(() => this.init.studentId),
      "cmi.core.student_name": ro(() => this.init.studentName),
      "cmi.core.lesson_location": this.field(() => this.lessonLocation, (v) => (this.lessonLocation = v), (v) => v.length <= LESSON_LOCATION_MAX, "at most 255 characters"),
      "cmi.core.credit": ro(() => "credit"),
      "cmi.core.lesson_status": this.field(() => this.lessonStatus, (v) => (this.lessonStatus = v), (v) => SETTABLE_STATUSES.has(v), "passed, completed, failed, incomplete or browsed"),
      "cmi.core.entry": ro(() => this.init.entry),
      "cmi.core.score._children": kw(() => SCORE_CHILDREN),
      "cmi.core.score.raw": this.field(() => this.scoreRaw, (v) => (this.scoreRaw = v), score, "a number 0-100, or blank"),
      "cmi.core.score.min": this.field(() => this.scoreMin, (v) => (this.scoreMin = v), score, "a number 0-100, or blank"),
      "cmi.core.score.max": this.field(() => this.scoreMax, (v) => (this.scoreMax = v), score, "a number 0-100, or blank"),
      "cmi.core.total_time": ro(() => formatTimespan(this.init.totalTimeCs)),
      "cmi.core.lesson_mode": ro(() => "normal"),
      "cmi.core.exit": { set: (v) => (EXITS.has(v) ? ((this.exit = v), true) : false), detail: "time-out, suspend, logout or blank" },
      "cmi.core.session_time": {
        set: (v) => {
          const cs = parseTimespan(v);
          if (cs === null) return false;
          this.sessionTimeCs = cs;
          return true;
        },
        detail: "HHHH:MM:SS.SS",
      },
      "cmi.suspend_data": this.field(() => this.suspendData, (v) => (this.suspendData = v), (v) => v.length <= SUSPEND_DATA_MAX, "at most 4096 characters"),
      "cmi.launch_data": ro(() => this.init.launchData ?? ""),
      "cmi.comments": this.field(() => this.comments, (v) => (this.comments = v), (v) => v.length <= 4096, "at most 4096 characters"),
      "cmi.comments_from_lms": ro(() => ""),
      "cmi.objectives._children": kw(() => OBJECTIVE_CHILDREN),
      "cmi.objectives._count": kw(() => String(this.objectives.length)),
      "cmi.student_data._children": kw(() => "mastery_score,max_time_allowed,time_limit_action"),
      "cmi.student_data.mastery_score": ro(() => blank(this.init.masteryScore)),
      "cmi.student_data.max_time_allowed": ro(() => ""),
      "cmi.student_data.time_limit_action": ro(() => ""),
      "cmi.student_preference._children": kw(() => "audio,language,speed,text"),
      "cmi.student_preference.audio": this.pref("audio", integerIn(-1, 100)),
      "cmi.student_preference.language": this.pref("language", (v) => v.length <= 255),
      "cmi.student_preference.speed": this.pref("speed", integerIn(-100, 100)),
      "cmi.student_preference.text": this.pref("text", integerIn(-1, 1)),
      "cmi.interactions._children": kw(() => INTERACTION_CHILDREN),
      "cmi.interactions._count": kw(() => String(this.interactions.length)),
    };
  }

  private pref(name: string, valid: (v: string) => boolean): Element {
    return this.field(() => this.prefs.get(name) ?? "", (v) => this.prefs.set(name, v), valid);
  }

  /**
   * An array entry, for reading (it must exist) or writing (it may be the
   * next one, created only once the value is valid).
   */
  private entry<T>(list: T[], index: number, mode: "get" | "set", make: () => T, valid: boolean): T | "201" | null {
    if (index < list.length) return list[index]!;
    if (mode === "set" && index === list.length) return valid ? (list.push(make()), list[index]!) : null;
    return "201";
  }

  private lookup(element: string, mode: "get" | "set", value = ""): Element | string {
    const scalar = Object.prototype.hasOwnProperty.call(this.elements, element) ? this.elements[element] : undefined;
    if (scalar) return scalar;

    let m = /^cmi\.objectives\.(\d+)\.(id|status|score\._children|score\.raw|score\.min|score\.max)$/.exec(element);
    if (m) {
      const key = m[2]!;
      if (key === "score._children") return { get: () => SCORE_CHILDREN, keyword: true };
      const valid = key === "id" ? identifier(value) : key === "status" ? OBJECTIVE_STATUSES.has(value) : score(value);
      const o = this.entry(this.objectives, Number(m[1]), mode, () => ({ id: "", status: "not attempted", raw: "", min: "", max: "" }), valid);
      if (o === "201") return "201";
      const prop = key.replace("score.", "") as "id" | "status" | "raw" | "min" | "max";
      return { get: () => o?.[prop] ?? "", set: () => (valid && o ? ((o[prop] = value), true) : false) };
    }

    m = /^cmi\.interactions\.(\d+)\.(id|time|type|weighting|student_response|result|latency|objectives\._count|correct_responses\._count)$/.exec(element);
    if (m) {
      const key = m[2]!;
      const make = () => ({ fields: new Map<string, string>(), objectives: [], patterns: [] });
      if (key.endsWith("._count")) {
        const i = this.entry(this.interactions, Number(m[1]), "get", make, false);
        if (i === "201" || !i) return "201";
        return { get: () => String(key.startsWith("objectives") ? i.objectives.length : i.patterns.length), keyword: true };
      }
      const validators: Record<string, (v: string) => boolean> = {
        id: identifier,
        time: cmiTime,
        type: (v) => INTERACTION_TYPES.has(v),
        weighting: decimal,
        student_response: feedback,
        result: (v) => RESULTS.has(v) || decimal(v),
        latency: (v) => parseTimespan(v) !== null,
      };
      const valid = validators[key]!(value);
      const i = this.entry(this.interactions, Number(m[1]), mode, make, valid);
      if (i === "201") return "201";
      // Write-only in SCORM 1.2: no getter.
      return { set: () => (valid && i ? (i.fields.set(key, value), true) : false) };
    }

    m = /^cmi\.interactions\.(\d+)\.(objectives|correct_responses)\.(\d+)\.(id|pattern)$/.exec(element);
    if (m && ((m[2] === "objectives" && m[4] === "id") || (m[2] === "correct_responses" && m[4] === "pattern"))) {
      const i = this.interactions[Number(m[1])];
      if (!i) return "201";
      const list = m[2] === "objectives" ? i.objectives : i.patterns;
      const valid = m[2] === "objectives" ? identifier(value) : feedback(value);
      const index = Number(m[3]);
      if (index > list.length || (mode === "get" && index === list.length)) return "201";
      return { set: () => (valid ? ((list[index] = value), true) : false) };
    }

    // A known element asked for children or a count it does not have.
    const known = (base: string) =>
      Object.prototype.hasOwnProperty.call(this.elements, base) ||
      ["cmi.core", "cmi.core.score", "cmi.objectives", "cmi.student_data", "cmi.student_preference", "cmi.interactions"].includes(base);
    if (element.endsWith("._children") && known(element.slice(0, -"._children".length))) return "202";
    if (element.endsWith("._count") && known(element.slice(0, -"._count".length))) return "203";
    return "201";
  }
}
