// Help dictionary — every term, status, role and concept used in the LMS.
//
// Spec 122 (frontend-parity Run 10): ports the prototype's ~50-entry HELP map
// from `LMS GML Frontend/help.jsx`. Each entry is keyed by a stable slug used
// in URLs (e.g. `?help=cycle`), in JSX call-sites (`<HelpTip k="cycle">`), and
// in tour-step `data-help-anchor` attributes.
//
// Tone (carried over from the prototype): friendly, concrete, often with an
// example. No jargon. `short` = tooltip line (≤ 25 words). `long` = side-panel
// explanation (2-3 paragraphs).
//
// The dictionary is exported as a frozen object so neither a server component
// nor a client component can mutate it at runtime. Topic groups for the
// "Browse all" view live in HELP_GROUPS, and the keyset is exposed via
// HELP_KEYS for fuzzy-search (HelpPanel's search input).

export type HelpEntry = {
  /** Friendly title shown at the top of the tooltip and the side-panel header. */
  title: string;
  /** One-line definition — ≤ 25 words. Always present, drives the tooltip body. */
  short: string;
  /** Two-to-three paragraph explanation shown in the side panel. Optional for status pills + roles. */
  long?: string;
  /** Slugs of related topics — rendered as chips in the side panel. */
  related?: readonly string[];
  /** Optional route hints, e.g. "/repo/schools" for a deep-link "see also" affordance. */
  seeAlso?: readonly string[];
};

export const HELP: Readonly<Record<string, HelpEntry>> = Object.freeze({
  // ── Top-level objects ──────────────────────────────────────────────────────
  school: {
    title: "School",
    short: "A government school we work with. Each school has classes, teachers and students.",
    long: "A school is one of the 10 government schools the programme partners with in Leh and Kargil. Each school holds many classes (Grade 1, Grade 2…), has teachers, and runs sessions. Tap a school to see everything inside it.",
    related: ["class", "teacher", "zone", "district"],
    seeAlso: ["/repo/schools"],
  },
  class: {
    title: "Class (a grade)",
    short: "One grade at one school — for example, Grade 3 at GPS Chuchot. It holds students and sessions.",
    long: "A class is one grade at one school. Grade 3 at GPS Chuchot is one class; Grade 3 at GMS Khaltsi is a different class. Each class has a class teacher, students, and the subjects taught at that grade level.",
    related: ["school", "student", "grade", "section"],
  },
  subject: {
    title: "Subject",
    short: "What is being taught — English, Math, EVS, Hindi, Urdu, Science, etc.",
    long: "A subject is the topic area being taught — English, Mathematics, EVS, Hindi, Urdu, Science, and so on. Each subject is taught across a range of grades. Each subject has its own course outline per grade and term.",
    related: ["outline", "session", "grade"],
    seeAlso: ["/repo/subjects"],
  },
  outline: {
    title: "Course outline",
    short: "The plan for one subject at one grade for one term — its learning outcomes and lessons.",
    long: "A course outline is the unit plan. For example: 'English G1 — Term 2: Decoding & blending'. It lists what students should learn, week by week, and how many sessions cover it. Sessions you teach link to this outline so you can see progress.",
    related: ["subject", "grade", "term", "session", "outcome"],
    seeAlso: ["/repo/outlines"],
  },
  session: {
    title: "Session",
    short: "One lesson in one classroom on one day. It has a date, time, teacher, topic and attendance.",
    long: "A session is one teaching period — for example, the English lesson Tsering Dolma gave on 18 May 2026 to Grade 1 at GMS Khaltsi. It records the topic, the duration, who attended, and links to the lesson plan (outline) it came from.",
    related: ["class", "teacher", "topic", "attendance", "outline"],
    seeAlso: ["/repo/sessions"],
  },
  teacher: {
    title: "Teacher",
    short: "A government-school teacher in the programme. They teach sessions and grow through phases.",
    long: "A teacher is a government-school teacher enrolled in the programme. Each teacher belongs to one school, teaches one subject, and is in one of the three RTT phases. They are paired with a mentor.",
    related: ["school", "mentor", "phase", "pairing"],
    seeAlso: ["/repo/teachers"],
  },
  mentor: {
    title: "Mentor (Master Mentor)",
    short: "An expert who guides up to 5 teachers — observes them, gives feedback, holds quarterly check-ins.",
    long: "A mentor is a senior educator who works one-on-one with up to 5 teachers (called mentees). They observe lessons, hold quarterly check-ins, and write feedback. Each mentor specialises in a subject area.",
    related: ["pairing", "mentee", "cycle", "feedback"],
    seeAlso: ["/repo/mentors"],
  },
  mentee: {
    title: "Mentee",
    short: "A teacher in a mentor's care — the same word for the teacher's side of the pairing.",
    long: "A mentee is the teacher side of a mentor-teacher pairing. You will hear 'my mentor' (when the teacher speaks) and 'my mentees' (when the mentor speaks). It's the same relationship.",
    related: ["mentor", "pairing", "teacher"],
  },
  pairing: {
    title: "Mentor–mentee pairing",
    short: "The link between one mentor and one teacher. It lasts one school year.",
    long: "A pairing is the formal one-year link between a mentor and a teacher. Each pairing is reviewed every quarter (Q1–Q4). At year-end, pairings can rotate so teachers learn from different mentors.",
    related: ["mentor", "mentee", "quarter", "cycle"],
    seeAlso: ["/mentorship"],
  },
  student: {
    title: "Student / Learner",
    short: "A child enrolled in a class. Their records are private — only school staff can see them.",
    long: "A student is a child enrolled in a class. Records hold name, age, guardian and attendance. Because this is sensitive personal information, only school staff and programme leads can view it, and bulk exports are audited.",
    related: ["class", "attendance", "guardian"],
    seeAlso: ["/repo/students"],
  },
  resource: {
    title: "Reading material / Resource",
    short: "A document teachers and mentors use — handbooks, lesson templates, policy notes, worksheets.",
    long: "A resource is any document tagged into the programme — NEP policy briefs, lesson handbooks, classroom routines, festival calendars. Each resource is tagged to one or more subjects so the right ones surface in the right place.",
    related: ["subject", "handbook"],
    seeAlso: ["/repo/resources"],
  },

  // ── Observation ────────────────────────────────────────────────────────────
  observation: {
    title: "Classroom observation",
    short: "A full cycle where a mentor watches a teacher teach and then they discuss it together.",
    long: "Classroom observation is a five-step cycle: (1) The teacher writes a short Pre-form explaining what they plan to do. (2) The mentor watches the lesson — live or via a video the teacher uploads. (3) The mentor watches the video again and writes notes at exact timestamps. (4) The mentor writes a Post-form with two strengths and one growth move. (5) Both sign off.",
    related: ["cycle", "pre_form", "post_form", "sign_off", "video"],
    seeAlso: ["/observation"],
  },
  cycle: {
    title: "Observation cycle",
    short: "One round of pre-form → lesson → post-form → sign-off, run between a teacher and a mentor.",
    long: "A cycle is one complete round of observation. It has a unique ID (like c2026-001), a date, a topic, a kind (baseline, developmental or evaluative), and moves through five stages. A teacher can have several cycles in a year.",
    related: ["pre_form", "post_form", "sign_off", "kind", "status"],
  },
  pre_form: {
    title: "Pre-form (Pre-observation)",
    short: "A short note the teacher writes BEFORE the lesson — what they plan, what they want help with.",
    long: "The Pre-form is the first step of every cycle. The teacher writes the lesson objective, the class context (how many students, any context), what they plan to try differently, and what they want the mentor to look out for. Keep it short — five lines is enough.",
    related: ["cycle", "observation", "post_form"],
  },
  post_form: {
    title: "Post-form (Post-observation)",
    short: "The mentor's feedback after watching the lesson — two strengths, one growth move, a small commitment.",
    long: "The Post-form is written by the mentor after the lesson. It always has the same shape: two strengths to amplify, one specific growth move, ratings on four classroom domains, and one commitment for the next cycle. Short, kind, specific.",
    related: ["cycle", "strength", "growth_move", "commitment", "rubric"],
  },
  sign_off: {
    title: "Sign-off",
    short: "Both the teacher and mentor acknowledge the cycle is complete. It locks the record.",
    long: "Sign-off closes a cycle. Both the mentor and the teacher tap to acknowledge. Once signed, the record cannot be edited. If the teacher does not sign within 9 days, the programme admin is notified.",
    related: ["cycle", "post_form", "audit"],
  },
  baseline: {
    title: "Baseline observation",
    short: "The first observation in a teacher's journey — to understand where they're starting from.",
    long: "A baseline cycle happens at the beginning. The mentor doesn't expect perfection — they're listening for the teacher's starting place so the rest of the year is targeted to what they need.",
    related: ["cycle", "developmental", "evaluative"],
  },
  developmental: {
    title: "Developmental observation",
    short: "A normal mid-term observation focused on growth — not graded.",
    long: "Developmental cycles are about learning, not judging. The Post-form's only purpose is to help the teacher get better. Most cycles in a year are developmental.",
    related: ["cycle", "baseline", "evaluative"],
  },
  evaluative: {
    title: "Evaluative observation",
    short: "A graded check, usually mid-year or year-end. Results count towards certification.",
    long: "Evaluative cycles happen at key milestones — mid-year and year-end. The Post-form contributes to certification at the end of Phase 3.",
    related: ["cycle", "developmental", "phase"],
  },
  rubric: {
    title: "Rubric",
    short: "A scoring sheet with four domains: climate, clarity, engagement, assessment. Each rated 1–5.",
    long: "The rubric is the same across every cycle — four domains: Classroom climate, Instructional clarity, Engagement & participation, Assessment for learning. Each is scored 1 to 5. The mentor scores the same things every time so progress is comparable.",
    related: ["post_form", "domain", "cycle"],
  },

  // ── RTT structure ──────────────────────────────────────────────────────────
  rtt: {
    title: "RTT — Recruit, Train, Transform",
    short: "Our three-phase programme to grow a teacher from new recruit to confident classroom leader.",
    long: "RTT stands for Recruit, Train, Transform. It is the three-phase journey every teacher goes through over two years: Phase 1 (Foundational), Phase 2 (Application), Phase 3 (Mastery & Certification).",
    related: ["phase", "phase_1", "phase_2", "phase_3"],
    seeAlso: ["/rtt"],
  },
  phase: {
    title: "RTT phase",
    short: "The teacher's stage in the programme — Phase 1 (start), Phase 2 (apply), Phase 3 (mastery).",
    long: "Each teacher is in one of three RTT phases. They move from one to the next based on cycle outcomes and a mid-phase evaluation. Most teachers spend ~6 months in Phase 1, ~9 months in Phase 2, and ~9 months in Phase 3.",
    related: ["rtt", "phase_1", "phase_2", "phase_3"],
  },
  phase_1: {
    title: "Phase 1 — Foundational",
    short: "Onboarding and baseline. Teachers learn the basics: routines, classroom climate, lesson shape.",
    long: "Phase 1 is the foundation. The teacher is new to the programme. Focus: classroom climate, routines, lesson-planning basics, and starting to record video. Cycles are mostly baseline.",
    related: ["phase", "rtt"],
  },
  phase_2: {
    title: "Phase 2 — Application",
    short: "Putting it into practice. Teachers run live cycles with a mentor and join cohort sessions.",
    long: "Phase 2 is where the work begins. Teachers run regular developmental cycles, attend monthly cohort sessions, and complete their first major assessments. Most teachers spend the longest here.",
    related: ["phase", "cohort", "cycle"],
  },
  phase_3: {
    title: "Phase 3 — Mastery",
    short: "The home stretch. Teachers do evaluative cycles and earn certification at the end.",
    long: "Phase 3 leads to certification. Teachers run evaluative cycles, may begin mentoring junior peers, and present a final portfolio.",
    related: ["phase", "evaluative", "certification"],
  },
  district: {
    title: "District",
    short: "Leh or Kargil — the two districts that make up the Union Territory of Ladakh.",
    long: "We work in both of Ladakh's districts. Leh (the larger, lower-altitude district) and Kargil (further west). Each has its own zones, schools, and master mentor.",
    related: ["zone", "school"],
  },
  zone: {
    title: "Zone",
    short: "An administrative area inside a district — for example Khaltsi zone in Leh district.",
    long: "A zone is the level between district and school. Each district is divided into zones; each zone has 1–4 schools we work with. Mentors plan their travel route around zones.",
    related: ["district", "school"],
  },
  term: {
    title: "Term",
    short: "One third of the school year. Term 1 (Apr–Jul), Term 2 (Aug–Nov), Term 3 (Dec–Mar).",
    long: "The Ladakh school year is split into three terms. Each term lasts about 12 weeks. Course outlines are written per term, so a subject can have three outlines in a year.",
    related: ["outline", "week"],
  },
  quarter: {
    title: "Quarter (Q1–Q4)",
    short: "Mentor-mentee progress is reviewed four times a year — Q1, Q2, Q3, Q4.",
    long: "Each pairing has four quarterly progress check-ins. Q1 = baseline + onboarding. Q2 = first developmental cycle. Q3 = mid-year evaluation. Q4 = endline & certification. The four bars on a mentee card show this progress.",
    related: ["pairing", "cycle"],
  },

  // ── Mentorship internals ───────────────────────────────────────────────────
  feedback_form: {
    title: "Quarterly feedback form",
    short: "Eight questions the mentor answers each quarter to log how the mentee is growing.",
    long: "Every quarter, the mentor fills an 8-question form covering classroom routines, instructional clarity, growth area, and commitments for the next two weeks. Auto-saves every 5 seconds so you can finish it later.",
    related: ["quarter", "pairing", "mentor"],
  },
  commitment: {
    title: "Commitment",
    short: "One concrete thing the mentee (or mentor) promises to do before the next cycle.",
    long: "A commitment is the smallest possible behaviour change — for example, 'I will keep a 4-minute cool-down at the end of every lesson this week.' Mentor and mentee each leave one commitment per cycle. They're tracked openly so they don't get forgotten.",
    related: ["post_form", "cycle"],
  },
  growth_move: {
    title: "Growth move",
    short: "The single most-important behaviour to change. Make it tiny and observable.",
    long: "The Post-form asks for ONE growth move. Not five. The discipline is: pick the one thing that, if it changed next week, would help the most. Keep it observable — something a colleague could see.",
    related: ["post_form", "commitment"],
  },
  strength: {
    title: "Two strengths",
    short: "Two specific things the teacher already does well — name them so they keep doing them.",
    long: "The Post-form starts with strengths, not weaknesses. Name two things you saw the teacher do well — by name, specifically. This builds confidence and protects the relationship.",
    related: ["post_form", "feedback"],
  },

  // ── Status values (status pills) ───────────────────────────────────────────
  status_nominated: {
    title: "Nominated",
    short: "A cycle has been created but the teacher hasn't filled the Pre-form yet.",
  },
  status_pre_submitted: {
    title: "Pre-form submitted",
    short: "Teacher has filled the Pre-form. The lesson is ready to happen.",
  },
  status_observed: {
    title: "Observed",
    short: "The lesson has happened (live or recorded). Mentor will now write the Post-form.",
  },
  status_post_submitted: {
    title: "Post-form submitted",
    short: "Mentor has written feedback. Waiting for teacher to acknowledge.",
  },
  status_complete: {
    title: "Cycle complete",
    short: "Both have signed off. This cycle is closed and recorded.",
  },
  status_planned: {
    title: "Planned",
    short: "This session is on the schedule but hasn't happened yet.",
  },
  status_in_progress: {
    title: "In progress",
    short: "This session is happening today.",
  },

  // ── Video pipeline ─────────────────────────────────────────────────────────
  watermark: {
    title: "Watermark",
    short: "Faint text across the video showing who is watching. Stops videos being shared outside.",
    long: "Every classroom video has a watermark — your username and the current date — drawn faintly across every frame. This is so videos can't be copied and shared. If a video ever leaks, the watermark shows whose account it came from.",
    related: ["confidentiality", "audit"],
  },
  hls: {
    title: "HLS streaming",
    short: "Smart streaming that adjusts video quality to your network — works even on 2G.",
    long: "HLS is the technology that lets the video player automatically drop to 240p when your network is weak and bump back to 720p when it's strong. This is why videos play even in remote Ladakh schools on patchy 3G.",
    related: ["video", "upload"],
  },
  transcoding: {
    title: "Transcoding",
    short: "What happens to a video after upload — we re-make it in several sizes so it plays everywhere.",
    long: "When a teacher uploads a video, our server processes it into four versions: 240p (low-band), 480p (default), 720p (sharp), and audio-only. This takes a few minutes. While the system is transcoding, you'll see a 'Transcoding…' badge.",
    related: ["video", "upload", "hls"],
  },
  whatsapp_ingest: {
    title: "WhatsApp upload",
    short: "Forward your lesson video to our WhatsApp number — it comes straight into the system.",
    long: "Many of our teachers find it easier to send videos via WhatsApp than upload through the app. Forward your video to the programme WhatsApp number with the caption #c2026-XXX (your cycle ID) and it will land in the right place automatically.",
    related: ["upload", "video", "cycle"],
    seeAlso: ["/uploads"],
  },
  // The next three entries (and the "start" group below) carry what the mobile
  // help sheet used to say in five hardcoded bullets, before its ? button was
  // pointed at this panel. "password" in particular was the only in-app
  // instruction a locked-out teacher had, and existed nowhere else.
  upload: {
    title: "Uploading from the browser",
    short: "You can also upload a lesson video straight from this app — best on stable wifi.",
    long: "Direct browser upload works on a phone or a computer. It resumes if your connection drops, but a large video needs a steady link, so use stable wifi where you can. On a slow or patchy network, sending the video by WhatsApp is easier. Either way, your videos appear on your Uploads page within a few minutes.",
    related: ["whatsapp_ingest", "transcoding", "video"],
    seeAlso: ["/uploads"],
  },
  navigation: {
    title: "Finding your way around",
    short: "On a phone, use the bottom tabs to switch between sections. On a computer, use the sidebar.",
    long: "Every section you can use is one tap away: the bottom tabs on a phone, the sidebar on the left on a computer. Your settings, including the interface language, are under Settings in the sidebar on a computer, and behind your initial at the top of the screen on a phone. The ? button opens this help from anywhere.",
    related: ["password", "confidentiality"],
  },
  password: {
    title: "Forgot your password?",
    short: "Ask your programme admin to send you a sign-in link — it lets you in without the password.",
    long: "If you cannot sign in, ask your programme admin to send a sign-in link to your email address. Open the link on the device you want to use, then set a new password from Settings. The section gate password (for Observation, Mentorship and Admin) is different: your programme admin shares that one separately.",
    related: ["section_gate", "navigation"],
  },

  // ── Auth / security ────────────────────────────────────────────────────────
  section_gate: {
    title: "Section gate",
    short: "An extra password for sensitive areas — rotates every 30 days for safety.",
    long: "Some sections (Observation, Mentorship, Admin) require a second password after login — the section gate. It rotates every 30 days. Your programme admin shares the new code over a secure channel. Every attempt — correct or wrong — is logged.",
    related: ["audit", "password", "admin"],
  },
  audit: {
    title: "Audit log",
    short: "A record of every action — every login, view, edit, upload — kept for 7 years.",
    long: "The audit log keeps a permanent record of what happens in the system: who logged in, who viewed a video, who edited a record, who tried a wrong password. This is to protect everyone. The log cannot be edited or deleted, only read.",
    related: ["section_gate", "confidentiality"],
    seeAlso: ["/admin/audit"],
  },
  confidentiality: {
    title: "Confidentiality",
    short: "Lesson videos, names of children, and mentor notes are private to the programme.",
    long: "We treat every video, every child's record, and every mentor note as private. They are watermarked, never downloadable, and never to be shared outside the programme. The footer of every page reminds you of this.",
    related: ["watermark", "audit"],
  },

  // ── Roles ──────────────────────────────────────────────────────────────────
  role_super_admin: {
    title: "Super Admin",
    short: "Owns the system. Can do anything — including manage other admins.",
  },
  role_programme_admin: {
    title: "Programme Admin",
    short: "Day-to-day operations — teachers, schools, schedules, gates, reports.",
  },
  role_mentor: {
    title: "Mentor",
    short: "Carries up to 5 mentees. Observes, gives feedback, holds quarterly check-ins.",
  },
  role_observer: {
    title: "Observer",
    short: "Visiting role. Can join an observation, but doesn't have ongoing mentees.",
  },
  role_teacher: {
    title: "Teacher",
    short: "The reason this all exists. Learns through phases, gets observed, grows.",
  },

  // ── Common fields ──────────────────────────────────────────────────────────
  attendance: {
    title: "Attendance",
    short: "How many children turned up. Shown as 'present / total' — for example, 18 / 20.",
    long: "Attendance is recorded by the teacher per session. We track it because attendance dips often explain learning dips. Stays-above-90% is the cohort target.",
    related: ["session", "class"],
  },
  cohort: {
    title: "Cohort",
    short: "A group of teachers who go through the programme together — they meet monthly online.",
    long: "Your cohort is the group of teachers in your phase who came in around the same time. You attend cohort sessions together once a month, share lessons, and learn from each other.",
    related: ["session", "phase", "peer"],
  },
});

/** Topic groups used in HelpPanel's "Browse all" view. */
export const HELP_GROUPS: ReadonlyArray<{ id: string; title: string; keys: readonly string[] }> = Object.freeze([
  // First, because it is what a new or stuck user needs; it is also where the
  // mobile help sheet's bullets went (see the upload / navigation / password
  // entries above).
  {
    id: "start",
    title: "Getting started",
    keys: ["navigation", "whatsapp_ingest", "upload", "confidentiality", "password"],
  },
  { id: "core", title: "Core ideas", keys: ["rtt", "phase", "observation", "cycle", "pairing", "quarter"] },
  {
    id: "people",
    title: "People",
    keys: ["teacher", "mentor", "mentee", "student", "role_programme_admin", "role_super_admin"],
  },
  { id: "place", title: "Where", keys: ["district", "zone", "school", "class", "term"] },
  { id: "what", title: "What is taught", keys: ["subject", "outline", "session", "resource", "cohort"] },
  {
    id: "obs",
    title: "Inside an observation",
    keys: [
      "pre_form",
      "post_form",
      "sign_off",
      "rubric",
      "strength",
      "growth_move",
      "commitment",
      "baseline",
      "developmental",
      "evaluative",
    ],
  },
  { id: "video", title: "Video & uploads", keys: ["whatsapp_ingest", "hls", "transcoding", "watermark"] },
  { id: "safe", title: "Safety & access", keys: ["section_gate", "audit", "confidentiality", "attendance"] },
]);

/** Every slug in the dictionary — drives the search input. */
export const HELP_KEYS: readonly string[] = Object.freeze(Object.keys(HELP));

/** Lookup helper. Returns null for unknown slugs so callers can degrade gracefully. */
export function helpFor(key: string | null | undefined): HelpEntry | null {
  if (!key) return null;
  return HELP[key] ?? null;
}

/** Fuzzy-search (case-insensitive substring match against title + short). */
export function searchHelp(query: string): readonly { key: string; entry: HelpEntry }[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const results: { key: string; entry: HelpEntry }[] = [];
  for (const key of HELP_KEYS) {
    const entry = HELP[key]!;
    const hay = `${key} ${entry.title} ${entry.short} ${entry.long ?? ""}`.toLowerCase();
    if (hay.includes(q)) results.push({ key, entry });
  }
  return results;
}
