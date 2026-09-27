// The repository speaks the reader's language -- executed.
//
// ── THE DEFECT (UAT, 2026-09-27) ─────────────────────────────────────────────
//
// A user who picked Hindi or Bhoti got a translated menu over English
// repository pages: /repo and every index and record page under it (schools,
// classes, subjects, outlines, sessions, teachers, mentors, learners, reading
// material) -- headings, table columns, filters, empty states, the status
// chips, and dates with English month names. All of it was written into the
// components in English.
//
// What is rendered here is the real page or component, with next-intl's real
// translator over the app's own bundles (tests/behaviour/_ui.ts), in Hindi and
// in Bhoti. Each check pairs a string from the repo namespace that must appear
// with its English original that must not. What people typed or an
// administrator loaded -- school, teacher and subject names, codes, topics --
// stays as stored; a stored status or stage shows as its translated label.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { render, request, mount, hostElements, decodeEntities, withAppRouter } from "./_ui.js";
import { signIn, closeAppDb, type TestUser } from "./_server-actions.js";
import { needsDatabase } from "./_harness.js";
import { observationWorld } from "./_observation-world.js";

const skip = needsDatabase();
after(async () => {
  if (!skip) await closeAppDb();
});

const APP = "../../apps/web/src/app/(authenticated)/repo";

/** Run `body` with the fake request in `locale`, back to English afterwards. */
async function inLocale<T>(locale: "hi" | "bo", body: () => Promise<T> | T): Promise<T> {
  request.locale = locale;
  try {
    return await body();
  } finally {
    request.locale = "en";
  }
}

/** The visible text of rendered markup, entities decoded, whitespace collapsed. */
const text = (html: string) =>
  decodeEntities(html.replace(/<!-- -->/g, "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");

/** Every `shown` string appears in `out`, and no `hidden` one does. */
function speaks(out: string, pairs: Array<[shown: string, hidden: string]>): void {
  for (const [shown, hidden] of pairs) {
    assert.ok(out.includes(shown), `"${shown}" is shown`);
    assert.ok(!out.includes(hidden), `"${hidden}" is not`);
  }
}

// ── components (no database) ─────────────────────────────────────────────────

test("the phone card list's empty state and card labels are Hindi and Bhoti", async () => {
  const { MobileRepoCardList } = await import("../../apps/web/src/components/repo/MobileRepoCardList.tsx");
  const hiEmpty = await inLocale("hi", async () => render(withAppRouter(await MobileRepoCardList({ items: [] }))));
  speaks(text(hiEmpty), [["अभी यहाँ कुछ नहीं है।", "Nothing here yet."]]);

  const item = { id: "s1", primary: "Govt Middle School Choglamsar", href: "/repo/school/s1" };
  const bo = await inLocale("bo", async () => render(withAppRouter(await MobileRepoCardList({ items: [item] }))));
  assert.ok(bo.includes('aria-label="Govt Middle School Choglamsar ཁ་ཕྱེ།"'), "the card's label is Bhoti around the stored name");
  assert.ok(!bo.includes("Open Govt"), "no English 'Open' label");
  assert.ok(text(bo).includes("Govt Middle School Choglamsar"), "the school's name is shown as stored");
});

test("the PDF viewer's frame is named in Bhoti and Hindi (a client component)", async () => {
  const { PdfViewer } = await import("../../apps/web/src/components/pdf/PdfViewer.tsx");
  const titleIn = (locale: "hi" | "bo") => {
    const m = mount(PdfViewer as (p: unknown) => unknown, { src: "/api/media/pdf/r1", watermark: "t@example.test · OBS-CONFIDENTIAL" }, { intl: locale });
    return hostElements(m.tree).find((e) => e.type === "iframe")?.props.title;
  };
  assert.equal(titleIn("bo"), "PDF ཡིག་ཆ་ལྟ་ཆས།");
  assert.equal(titleIn("hi"), "PDF दस्तावेज़ व्यूअर");
});

// ── pages (database) ─────────────────────────────────────────────────────────

/** Render a /repo page as `user` in `locale`. */
async function repoPage(user: TestUser, locale: "hi" | "bo", run: () => Promise<unknown>): Promise<string> {
  signIn(user);
  return inLocale(locale, async () => render(withAppRouter(await run())));
}

test("/repo and its index and record pages are Hindi and Bhoti; names and codes stay as stored", { skip }, async () => {
  const w = await observationWorld("i18nrepo");
  const one = async (q: string, p: unknown[]) => (await w.c.query(q, p)).rows[0].id as string;
  let subjectId = "";
  let classId = "";
  let sessionId = "";
  try {
    subjectId = await one(`INSERT INTO subjects (name, code, grades_min, grades_max) VALUES ($1, $2, 1, 10) RETURNING id`, [
      `Subject ${w.T}`,
      w.T.slice(-12),
    ]);
    // Stored lower-case, as the phone-layout test does: the label is still found.
    classId = await one(`INSERT INTO classes (school_id, grade, stage, students_count) VALUES ($1, 5, 'primary', 30) RETURNING id`, [w.schoolId]);
    sessionId = await one(
      `INSERT INTO sessions (school_id, class_id, subject_id, teacher_id, scheduled_date, scheduled_time, topic, status, total_count, attended_count)
       VALUES ($1, $2, $3, $4, current_date, '10:00', 'Fractions on a number line', 'complete', 30, 28) RETURNING id`,
      [w.schoolId, classId, subjectId, w.teacherId],
    );
    const admin = { id: w.admin.id, role: "programme_admin", name: w.admin.name, email: w.admin.email };
    const noSearch = { searchParams: Promise.resolve({}) };
    const params = (id: string) => ({ params: Promise.resolve({ id }) });

    // /repo -- the home page.
    const { default: Home } = await import(`${APP}/page.tsx`);
    speaks(text(await repoPage(admin, "hi", () => Home())), [
      ["कार्यक्रम रिकॉर्ड", "Programme records"],
      ["रिकॉर्ड खोजें", "Find a record"],
      ["इस सप्ताह के सत्र", "This week's sessions"],
      ["दर्ज सत्र", "Sessions logged"],
    ]);
    speaks(text(await repoPage(admin, "bo", () => Home())), [
      ["ལས་གཞིའི་ཡིག་ཐོ།", "Programme records"],
      ["ཡིག་ཐོ་འཚོལ།", "Find a record"],
    ]);

    // /repo/schools -- the intro, the district tabs, the search field's name.
    // (The lists show every school and session in the database, so the
    // English that must be absent is interface copy no record could hold.)
    const { default: Schools } = await import(`${APP}/schools/page.tsx`);
    const schoolsHi = await repoPage(admin, "hi", () => Schools(noSearch));
    speaks(text(schoolsHi), [
      ["लेह और कारगिल ज़िलों के", "government schools across Leh and Kargil"],
      ["किसी भी पंक्ति पर क्लिक करके", "Click any row to see"],
    ]);
    assert.ok(schoolsHi.includes('aria-label="नाम से विद्यालय खोजें"'), "the search field is named in Hindi");
    assert.ok(!schoolsHi.includes("Search schools by name"));
    assert.ok(text(schoolsHi).includes(`School ${w.T}`), "the school's name is shown as stored");

    // /repo/sessions -- the tabs, the filters, and a stored status as a label.
    const { default: Sessions } = await import(`${APP}/sessions/page.tsx`);
    const sessionsBoHtml = await repoPage(admin, "bo", () => Sessions(noSearch));
    const sessionsBo = text(sessionsBoHtml);
    speaks(sessionsBo, [
      ["དེ་རིང་།", "Every classroom session held"],
      ["སློབ་ཚན་ཚང་མ།", "All subjects"],
      ["ཁ་ཕྱེ →", "Open →"],
    ]);
    const ours = sessionsBoHtml.slice(sessionsBoHtml.indexOf("Fractions on a number line"));
    assert.ok(ours.length > 0, "the topic is shown as stored");
    assert.match(ours.slice(0, 2000), /<span class="chip chip-lichen">ལེགས་གྲུབ།<\/span>/, "its complete status is a Bhoti chip");

    // /repo/school/[id] -- the record page's cards and details; the class's
    // stage, stored lower-case, is still found and shown as its label.
    const { default: School } = await import(`${APP}/school/[id]/page.tsx`);
    speaks(text(await repoPage(admin, "hi", () => School(params(w.schoolId)))), [
      ["प्रधानाचार्य", "Principal"],
      ["जुड़ने की तारीख़", "Onboarded"],
      ["सबसे नए पहले", "Most recent first"],
      ["कक्षा 5", "Grade 5"],
      ["प्राथमिक", "primary"],
      ["पूर्ण", "Complete"],
    ]);

    // /repo/class/[id] -- a sentence with values, and the stored stage.
    const { default: Klass } = await import(`${APP}/class/[id]/page.tsx`);
    speaks(text(await repoPage(admin, "bo", () => Klass(params(classId)))), [
      ["སློབ་ཕྲུག་ 30", "30 students"],
      ["གཞི་རིམ།", "primary"],
      ["སློབ་མ་ལྟ (30) →", "View learners"],
    ]);

    // /repo/session/[id] -- the notes, with the attendance in the sentence.
    const { default: Session } = await import(`${APP}/session/[id]/page.tsx`);
    speaks(text(await repoPage(admin, "hi", () => Session(params(sessionId)))), [
      ["पाठ टिप्पणियाँ", "Lesson notes"],
      ["28 / 30 शिक्षार्थी उपस्थित", "learners present"],
      ["पूर्ण", "Complete"],
    ]);

    // /repo/teacher/[id] -- locked cards say why, in the reader's language;
    // the onboarding date has a Hindi month.
    const { default: Teacher } = await import(`${APP}/teacher/[id]/page.tsx`);
    const teacherHi = text(await repoPage(admin, "hi", () => Teacher(params(w.teacherId))));
    speaks(teacherHi, [
      ["मेंटर जोड़ी", "Mentor pairing"],
      ["मेंटरशिप का विवरण सेक्शन पासवर्ड से सुरक्षित है।", "behind the section password"],
      ["अनलॉक करें →", "Unlock"],
    ]);
    const created = (await w.c.query(`SELECT created_at FROM teachers WHERE id = $1`, [w.teacherId])).rows[0].created_at as Date;
    const hiDate = new Date(created).toLocaleDateString("hi-IN", { day: "numeric", month: "short", year: "numeric" });
    assert.ok(teacherHi.includes(hiDate), `the onboarding date is formatted in Hindi (${hiDate})`);
    assert.ok(teacherHi.includes(`Teacher Row ${w.T}`), "the teacher's name is shown as stored");

    // Page titles, in the reader's language.
    const { generateMetadata } = await import(`${APP}/teachers/page.tsx`);
    assert.equal((await inLocale("bo", () => generateMetadata())).title, "དགེ་རྒན།");
  } finally {
    await w.c.query(`DELETE FROM sessions WHERE school_id = $1`, [w.schoolId]);
    await w.c.query(`DELETE FROM classes WHERE school_id = $1`, [w.schoolId]);
    if (subjectId) await w.c.query(`DELETE FROM subjects WHERE id = $1`, [subjectId]);
    await w.cleanup();
  }
});
