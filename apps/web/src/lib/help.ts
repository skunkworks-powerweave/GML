// Help dictionary — every term, status, role and concept used in the LMS.
//
// Spec 122 (frontend-parity Run 10): ports the prototype's ~50-entry HELP map
// from `LMS GML Frontend/help.jsx`. Each entry is keyed by a stable slug used
// in URLs (e.g. `?help=cycle`), in JSX call-sites (`<HelpTip k="cycle">`), and
// in tour-step `data-help-anchor` attributes.
//
// THE WORDS ARE IN THE "help" MESSAGE NAMESPACE, in the reader's language:
// help.entries.<slug>.{title, short, long} (fetched by the panel: components/help/entries.ts) and help.client.groups.<id>
// (apps/web/src/i18n/locales/<locale>/help.json). This module holds what does
// not change with the language: which topics exist, which are related, where
// each points, and how the browse view groups them. The articles were English
// here, so a Hindi or Bhoti reader opened the ? panel from a translated page
// onto an English dictionary. They sit under `client` because the panel and
// the tooltips that show them are client components.
//
// Tone (carried over from the prototype): friendly, concrete, often with an
// example. No jargon. `short` = tooltip line (≤ 25 words). `long` = side-panel
// explanation (2-3 paragraphs), absent for status pills and roles.
//
// The dictionary is exported as a frozen object so neither a server component
// nor a client component can mutate it at runtime. Topic groups for the
// "Browse all" view live in HELP_GROUPS, and the keyset is exposed via
// HELP_KEYS for fuzzy-search (HelpPanel's search input).

export type HelpEntry = {
  /** Slugs of related topics — rendered as chips in the side panel. */
  related?: readonly string[];
  /** Optional route hints, e.g. "/repo/schools" for a deep-link "see also" affordance. */
  seeAlso?: readonly string[];
};

/** An entry's words in one language (from help.entries.<slug>). */
export type HelpText = {
  /** Friendly title shown at the top of the tooltip and the side-panel header. */
  title: string;
  /** One-line definition — ≤ 25 words. Always present, drives the tooltip body. */
  short: string;
  /** Two-to-three paragraph explanation shown in the side panel. Absent for status pills + roles. */
  long?: string;
};

export const HELP: Readonly<Record<string, HelpEntry>> = Object.freeze({
  // ── Top-level objects ──────────────────────────────────────────────────────
  school: { related: ["class", "teacher", "zone", "district"], seeAlso: ["/repo/schools"] },
  class: { related: ["school", "student", "grade", "section"] },
  subject: { related: ["outline", "session", "grade"], seeAlso: ["/repo/subjects"] },
  outline: { related: ["subject", "grade", "term", "session", "outcome"], seeAlso: ["/repo/outlines"] },
  session: { related: ["class", "teacher", "topic", "attendance", "outline"], seeAlso: ["/repo/sessions"] },
  teacher: { related: ["school", "mentor", "phase", "pairing"], seeAlso: ["/repo/teachers"] },
  mentor: { related: ["pairing", "mentee", "cycle", "feedback"], seeAlso: ["/repo/mentors"] },
  mentee: { related: ["mentor", "pairing", "teacher"] },
  pairing: { related: ["mentor", "mentee", "quarter", "cycle"], seeAlso: ["/mentorship"] },
  student: { related: ["class", "attendance", "guardian"], seeAlso: ["/repo/students"] },
  resource: { related: ["subject", "handbook"], seeAlso: ["/repo/resources"] },

  // ── Observation ────────────────────────────────────────────────────────────
  observation: { related: ["cycle", "pre_form", "post_form", "sign_off", "video"], seeAlso: ["/observation"] },
  cycle: { related: ["pre_form", "post_form", "sign_off", "kind", "status"] },
  pre_form: { related: ["cycle", "observation", "post_form"] },
  post_form: { related: ["cycle", "strength", "growth_move", "commitment", "rubric"] },
  sign_off: { related: ["cycle", "post_form", "audit"] },
  baseline: { related: ["cycle", "developmental", "evaluative"] },
  developmental: { related: ["cycle", "baseline", "evaluative"] },
  evaluative: { related: ["cycle", "developmental", "phase"] },
  rubric: { related: ["post_form", "domain", "cycle"] },

  // ── RTT structure ──────────────────────────────────────────────────────────
  // rtt: Refresher Teacher Training, as the page metadata and teach-back say;
  // this entry and the sign-in page once expanded it as "Recruit, Train,
  // Transform".
  rtt: { related: ["phase", "phase_1", "phase_2", "phase_3"], seeAlso: ["/rtt"] },
  phase: { related: ["rtt", "phase_1", "phase_2", "phase_3"] },
  phase_1: { related: ["phase", "rtt"] },
  phase_2: { related: ["phase", "cohort", "cycle"] },
  phase_3: { related: ["phase", "evaluative", "certification"] },
  district: { related: ["zone", "school"] },
  zone: { related: ["district", "school"] },
  term: { related: ["outline", "week"] },
  quarter: { related: ["pairing", "cycle"] },

  // ── Mentorship internals ───────────────────────────────────────────────────
  feedback_form: { related: ["quarter", "pairing", "mentor"] },
  commitment: { related: ["post_form", "cycle"] },
  growth_move: { related: ["post_form", "commitment"] },
  strength: { related: ["post_form", "feedback"] },

  // ── Status values (status pills) ───────────────────────────────────────────
  status_nominated: {},
  status_pre_submitted: {},
  status_observed: {},
  status_post_submitted: {},
  status_complete: {},
  status_planned: {},
  status_in_progress: {},

  // ── Video pipeline ─────────────────────────────────────────────────────────
  watermark: { related: ["confidentiality", "audit"] },
  hls: { related: ["video", "upload"] },
  transcoding: { related: ["video", "upload", "hls"] },
  whatsapp_ingest: { related: ["upload", "video", "cycle"], seeAlso: ["/uploads"] },
  // The next three entries (and the "start" group below) carry what the mobile
  // help sheet used to say in five hardcoded bullets, before its ? button was
  // pointed at this panel. "password" in particular was the only in-app
  // instruction a locked-out teacher had, and existed nowhere else.
  upload: { related: ["whatsapp_ingest", "transcoding", "video"], seeAlso: ["/uploads"] },
  navigation: { related: ["password", "confidentiality"] },
  password: { related: ["section_gate", "navigation"] },

  // ── Auth / security ────────────────────────────────────────────────────────
  section_gate: { related: ["audit", "password", "admin"] },
  audit: { related: ["section_gate", "confidentiality"], seeAlso: ["/admin/audit"] },
  confidentiality: { related: ["watermark", "audit"] },

  // ── Roles ──────────────────────────────────────────────────────────────────
  role_super_admin: {},
  role_programme_admin: {},
  role_mentor: {},
  role_observer: {},
  role_teacher: {},

  // ── Common fields ──────────────────────────────────────────────────────────
  attendance: { related: ["session", "class"] },
  cohort: { related: ["session", "phase", "peer"] },
});

/**
 * Topic groups used in HelpPanel's "Browse all" view. A group's name is
 * help.client.groups.<id>.
 */
export const HELP_GROUPS: ReadonlyArray<{ id: string; keys: readonly string[] }> = Object.freeze([
  // First, because it is what a new or stuck user needs; it is also where the
  // mobile help sheet's bullets went (see the upload / navigation / password
  // entries above).
  { id: "start", keys: ["navigation", "whatsapp_ingest", "upload", "confidentiality", "password"] },
  { id: "core", keys: ["rtt", "phase", "observation", "cycle", "pairing", "quarter"] },
  { id: "people", keys: ["teacher", "mentor", "mentee", "student", "role_programme_admin", "role_super_admin"] },
  { id: "place", keys: ["district", "zone", "school", "class", "term"] },
  { id: "what", keys: ["subject", "outline", "session", "resource", "cohort"] },
  {
    id: "obs",
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
  { id: "video", keys: ["whatsapp_ingest", "hls", "transcoding", "watermark"] },
  { id: "safe", keys: ["section_gate", "audit", "confidentiality", "attendance"] },
]);

/** Every slug in the dictionary — drives the search input. */
export const HELP_KEYS: readonly string[] = Object.freeze(Object.keys(HELP));

/**
 * Lookup helper. Returns null for unknown slugs so callers can degrade
 * gracefully. Own keys only: a slug arrives from URLs and props, and
 * helpFor("constructor") must not find Object.prototype's.
 */
export function helpFor(key: string | null | undefined): HelpEntry | null {
  if (!key || !Object.prototype.hasOwnProperty.call(HELP, key)) return null;
  return HELP[key] ?? null;
}

/**
 * Fuzzy-search (case-insensitive substring match against the slug, title,
 * short and long), over the words `text` gives for each slug -- the reader's
 * language, so a Hindi reader searches the Hindi articles.
 */
export function searchHelp(
  query: string,
  text: (key: string) => HelpText,
): readonly { key: string; entry: HelpEntry; text: HelpText }[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const results: { key: string; entry: HelpEntry; text: HelpText }[] = [];
  for (const key of HELP_KEYS) {
    const words = text(key);
    const hay = `${key} ${words.title} ${words.short} ${words.long ?? ""}`.toLowerCase();
    if (hay.includes(q)) results.push({ key, entry: HELP[key]!, text: words });
  }
  return results;
}
