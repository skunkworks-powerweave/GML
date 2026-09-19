import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const SPEC_DIR = "specs/118-mentorship-action-buttons";
const ACTIONS = "apps/web/src/app/(authenticated)/mentorship/[pairingId]/actions.ts";
const PAGE = "apps/web/src/app/(authenticated)/mentorship/[pairingId]/page.tsx";

test("Spec 118: all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist`,
    );
  }
});

test("Spec 118: actions.ts file exists at the expected path", () => {
  assert.ok(
    existsSync(resolve(root, ACTIONS)),
    `${ACTIONS} must exist — the three server actions live here`,
  );
});

test("Spec 118: actions.ts is a top-of-file server module", () => {
  const src = read(ACTIONS);
  assert.match(
    src,
    /^"use server"/,
    `${ACTIONS} must start with "use server" so Next.js treats every exported function as a server action`,
  );
});

test("Spec 118: actions.ts exports all three server actions", () => {
  const src = read(ACTIONS);
  assert.match(
    src,
    /export async function logMeetingAction\b/,
    "logMeetingAction must be exported — it inserts mentor_meetings and bumps cached counters",
  );
  assert.match(
    src,
    /export async function completePairingAction\b/,
    "completePairingAction must be exported — it transitions pairings to status='complete'",
  );
  assert.match(
    src,
    /export async function toggleCommitmentAction\b/,
    "toggleCommitmentAction must be exported — it audit-logs commitment toggles (v1 stub)",
  );
});

test("Spec 118: log-meeting action inserts into mentor_meetings", () => {
  const src = read(ACTIONS);
  assert.match(
    src,
    /import\s*\{[^}]*\bmentorMeetings\b[^}]*\}\s*from\s*"@gml\/db\/schema"/,
    "actions.ts must import mentorMeetings from @gml/db/schema",
  );
  assert.match(
    src,
    /db\s*[\s\S]*?\.\s*insert\(\s*mentorMeetings\s*\)/,
    "logMeetingAction must call db.insert(mentorMeetings) — that's the row that powers the Meetings list",
  );
});

test("Spec 118: log-meeting action increments meetings_count via SQL expression (no race)", () => {
  const src = read(ACTIONS);
  // The increment must be done in SQL, not as a JS read-modify-write, to avoid
  // racing concurrent meeting logs on the same pairing.
  assert.match(
    src,
    /import\s*\{[^}]*\bsql\b[^}]*\}\s*from\s*"drizzle-orm"/,
    "actions.ts must import `sql` from drizzle-orm so the counter increment lives in SQL",
  );
  assert.match(
    src,
    /sql`[^`]*meetingsCount[^`]*\+\s*1[^`]*`/,
    "logMeetingAction must use sql`... meetingsCount + 1 ...` for the atomic counter bump",
  );
  assert.match(
    src,
    /lastMeetingAt:/,
    "logMeetingAction must also update lastMeetingAt so the dashboard's 'most recent meeting' chip stays fresh",
  );
});

test("Spec 118: complete-pairing action is role-gated to programme_admin + super_admin", () => {
  const src = read(ACTIONS);
  assert.match(
    src,
    /import\s*\{[^}]*\brequireRole\b[^}]*\}\s*from\s*"@\/lib\/guards"/,
    "actions.ts must import requireRole from @/lib/guards for the complete-pairing role gate",
  );
  // The role gate must mention both programme_admin and super_admin.
  assert.match(
    src,
    /requireRole\(\s*\[[^\]]*"programme_admin"[^\]]*"super_admin"[^\]]*\]\s*\)|requireRole\(\s*\[[^\]]*"super_admin"[^\]]*"programme_admin"[^\]]*\]\s*\)/,
    "completePairingAction must call requireRole(['programme_admin', 'super_admin']) — these are the only roles that can transition pairings",
  );
});

test("Spec 118: complete-pairing action updates status='complete' + endedAt", () => {
  const src = read(ACTIONS);
  assert.match(
    src,
    /db\s*[\s\S]*?\.\s*update\(\s*mentorPairings\s*\)/,
    "completePairingAction must call db.update(mentorPairings) to flip status",
  );
  assert.match(
    src,
    /status:\s*"complete"/,
    "the update must set status:'complete' — that's the terminal enum value",
  );
  assert.match(
    src,
    /endedAt:/,
    "the update must also set endedAt so the timeline records when the pairing closed",
  );
});

test("Spec 118: all three actions write audit rows via recordAudit", () => {
  const src = read(ACTIONS);
  assert.match(
    src,
    /import\s*\{[^}]*\brecordAudit\b[^}]*\}\s*from\s*"@\/lib\/audit"/,
    "actions.ts must import recordAudit from @/lib/audit",
  );
  assert.match(
    src,
    /action:\s*"mentor\.meeting\.logged"/,
    "logMeetingAction must audit 'mentor.meeting.logged'",
  );
  assert.match(
    src,
    /action:\s*"mentor\.pairing\.completed"/,
    "completePairingAction must audit 'mentor.pairing.completed'",
  );
  assert.match(
    src,
    /action:\s*"mentor\.commitment\.toggled"/,
    "toggleCommitmentAction must audit 'mentor.commitment.toggled' so toggles aren't silently dropped",
  );
});

test("Spec 118: actions revalidate the detail page so the new state shows on refresh", () => {
  const src = read(ACTIONS);
  assert.match(
    src,
    /import\s*\{\s*revalidatePath\s*\}\s*from\s*"next\/cache"/,
    "actions.ts must import revalidatePath from next/cache",
  );
  assert.match(
    src,
    /revalidatePath\(\s*`\/mentorship\/\$\{pairingId\}`/,
    "actions must call revalidatePath(`/mentorship/${pairingId}`) so the server-rendered page picks up the mutation",
  );
});

test("Spec 118: page.tsx imports all three actions from ./actions", () => {
  const src = read(PAGE);
  assert.match(
    src,
    /import\s*\{[\s\S]*?logMeetingAction[\s\S]*?completePairingAction[\s\S]*?toggleCommitmentAction[\s\S]*?\}\s*from\s*"\.\/actions"/,
    "page.tsx must import all three server actions from the local actions.ts",
  );
});

test("Spec 118: page.tsx wires forms to each action", () => {
  const src = read(PAGE);
  // Each form tag may carry additional JSX attributes (key, className, style)
  // before `action={X}`, so match the `<form` opener and the `action={X}` prop
  // anywhere inside the tag — but bounded by the closing `>` so we don't match
  // across multiple <form> tags.
  for (const fn of ["logMeetingAction", "completePairingAction", "toggleCommitmentAction"]) {
    const re = new RegExp(`<form[^>]*action=\\{\\s*${fn}\\s*\\}`);
    assert.match(
      src,
      re,
      `page.tsx must render a <form ... action={${fn}}> wiring the form to the server action`,
    );
  }
});

test("Spec 118: page.tsx renders a wa.me/ link for WhatsApp deep-linking", () => {
  const src = read(PAGE);
  assert.match(
    src,
    /wa\.me\//,
    "page.tsx must render a wa.me/<phone> URL so the WhatsApp button actually opens WhatsApp",
  );
  // The phone must be sanitized to digits — anything else would break the wa.me URL.
  assert.match(
    src,
    /replace\(\s*\/\[\^0-9\]\/g\s*,\s*""\s*\)/,
    "page.tsx must strip non-digits from the phone before composing the wa.me URL",
  );
});

test("Spec 118: quarter strip links to the forms runner with pairingId + quarter", () => {
  const src = read(PAGE);
  // The quarter cards link to /forms/<kind>-<audience>-<version>?pairingId=...&quarter=...
  //
  // The slug is now assembled inline from three RESOLVED values rather than a
  // precomputed `formSlug` const, which is why the old single-capture regex no
  // longer matches. That was not a refactor: the audience and the version were
  // both hardcoded here, and both were wrong.
  //
  //   version   was the literal "1". progress_2 is seeded at version "2" for
  //             both audiences, so the Q3 link named a slug matching no
  //             feedback_forms row and rendered "Form not found". Q3 has never
  //             been openable from this page.
  //   audience  was the literal "mentor". assertCanAccessPairing admits the
  //             MENTEE on the pairing too, by design, so a teacher clicking any
  //             quarter was sent to a mentor-audience form and bounced to
  //             /forbidden by the runner's audience check.
  //
  // Both now come from the database, so the next version bump cannot silently
  // break this page the way the last one did.
  assert.match(
    src,
    /\/forms\/\$\{formKind}-\$\{formAudience}-\$\{formVersion}\?pairingId=/,
    "quarter cards must build the slug from resolved kind, audience and version",
  );
  assert.match(
    src,
    /quarter=\$\{qNum}/,
    "the quarter number must ride along in the query string",
  );
  assert.match(
    src,
    /versionByKind/,
    "the form version must be resolved from feedback_forms, not hardcoded",
  );
  assert.match(
    src,
    /formAudience/,
    "the audience must follow the viewer's role -- the mentee reaches this page too",
  );
  // The slug uses the canonical kind-audience-version shape.
  assert.match(
    src,
    /QUARTER_TO_KIND/,
    "page.tsx must expose a QUARTER_TO_KIND map (1→baseline, 2→progress_1, 3→progress_2, 4→final)",
  );
});

test("Spec 118: page.tsx role-gates the Complete-pairing button via hasAnyRole", () => {
  const src = read(PAGE);
  assert.match(
    src,
    /import\s*\{\s*hasAnyRole\s*\}\s*from\s*"@gml\/shared\/auth\/roles"/,
    "page.tsx must import hasAnyRole from @gml/shared/auth/roles for the inline role check",
  );
  assert.match(
    src,
    /hasAnyRole\(\s*session\.user\.role\s*,\s*\[\s*"programme_admin"\s*,\s*"super_admin"\s*\]\s*\)/,
    "page.tsx must compute canComplete = hasAnyRole(session.user.role, ['programme_admin', 'super_admin'])",
  );
});

test("Spec 118: plan.md follows the CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/);
  assert.match(src, /EDITED:/);
  assert.match(src, /MIGRATED:/);
  // The plan must reference both the actions.ts (created) and page.tsx (edited).
  assert.match(src, /actions\.ts/);
  assert.match(src, /page\.tsx/);
});

test("Spec 118: spec.md documents the commitments-column deferral", () => {
  const src = read(`${SPEC_DIR}/spec.md`);
  assert.match(
    src,
    /commitments/i,
    "spec.md must discuss commitments — the persistence deferral is the spec's most notable design call",
  );
  assert.match(
    src,
    /audit/i,
    "spec.md must explain that the audit row is what captures the toggle in lieu of the column",
  );
});

test("Spec 118: research.md flags the deferred commitments migration", () => {
  const src = read(`${SPEC_DIR}/research.md`);
  assert.match(
    src,
    /commitments/i,
    "research.md must call out the deferred commitments-column migration",
  );
  assert.match(
    src,
    /audit_log|recordAudit|audit row/i,
    "research.md must explain the audit-row backfill strategy for the deferred column",
  );
});
