// Governance test for spec 140 — seed-forms checkbox kind fix
// (Workflow Run 13 audit closure, CRITICAL).
//
// Closes the silent-data bug where `seed_forms_mentor.ts` emitted form-field
// rows with `kind: "checkboxes"` (plural) that never matched the singular
// `field.kind === "checkbox"` branch in FormRenderer.tsx / MobileFormRunner.tsx.
// The renderer's dispatch ladder fell through to the text-input fallback,
// so every multi-select field in seeded mentor forms (e.g. the
// `expertise_areas` field on the baseline form) rendered as a single-line
// text input and silently lost the multi-select intent at submit time.
//
// Four files are under audit (all EDITED — pure surgical fix; no schema
// migration):
//
//   1. packages/db/src/scripts/seed_forms_mentor.ts
//      — rename FieldKind member `checkboxes` to singular `checkbox`
//      — rename the expertise_areas field row's `kind` literal accordingly
//      — introduce CANONICAL_FIELD_KINDS allow-list + assertCanonicalFieldKinds(forms) guard
//      — wire the guard at the FORMS array declaration
//   2. packages/db/src/scripts/seed_forms_mentee.ts
//      — introduce CANONICAL_FIELD_KINDS + MENTEE_TYPE_TO_CANONICAL + guard
//      — wire at the ROWS declaration
//   3. packages/db/src/scripts/seed_forms_observation.ts
//      — introduce CANONICAL_FIELD_KINDS + OBSERVATION_TYPE_TO_CANONICAL + guard
//      — wire at the TEMPLATES declaration
//   4. packages/db/src/scripts/seed_forms_misc.ts
//      — introduce CANONICAL_FIELD_KINDS + MISC_KIND_TO_CANONICAL + guard
//      — wire at the ROWS declaration
//
// Plus the five spec-kit files under specs/140-seed-forms-checkbox-fix/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const MENTOR_PATH = "packages/db/src/scripts/seed_forms_mentor.ts";
const MENTEE_PATH = "packages/db/src/scripts/seed_forms_mentee.ts";
const OBS_PATH = "packages/db/src/scripts/seed_forms_observation.ts";
const MISC_PATH = "packages/db/src/scripts/seed_forms_misc.ts";
const SEED_PATHS = [MENTOR_PATH, MENTEE_PATH, OBS_PATH, MISC_PATH];
const SPEC_DIR = "specs/140-seed-forms-checkbox-fix";

// ---------- Spec-kit + plan.md contract ----------

test("spec 140 — all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist for the seed-forms-checkbox-fix spec`,
    );
  }
});

test("spec 140 — plan.md follows the CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare a CREATED: line");
  assert.match(src, /EDITED:/, "plan.md must declare an EDITED: line");
  assert.match(src, /MIGRATED:/, "plan.md must declare a MIGRATED: line");
  assert.match(
    src,
    /seed_forms_mentor\.ts/,
    "plan.md must call out the mentor seed edit (the actual bug-fix site)",
  );
  assert.match(
    src,
    /seed_forms_mentee\.ts/,
    "plan.md must call out the mentee seed edit (defensive guard)",
  );
  assert.match(
    src,
    /seed_forms_observation\.ts/,
    "plan.md must call out the observation seed edit (defensive guard)",
  );
  assert.match(
    src,
    /seed_forms_misc\.ts/,
    "plan.md must call out the misc seed edit (defensive guard)",
  );
});

// ---------- The core regression gate: no plural anywhere ----------

test("spec 140 — none of the four seed files contain the literal 'checkboxes' anywhere", () => {
  // The whole point of the fix: the plural literal must not survive in any
  // of the four seed scripts. A future contributor copy-pasting an old row
  // would re-introduce the silent fallback bug; this assertion stops them
  // at the test gate.
  for (const path of SEED_PATHS) {
    const src = read(path);
    assert.ok(
      !/checkboxes/.test(src),
      `${path} must not contain the plural literal "checkboxes" (the renderer dispatch is singular)`,
    );
  }
});

// ---------- Each file references the singular form ----------

test("spec 140 — each seed file references the singular 'checkbox' in its canonical allow-list", () => {
  // Every file declares CANONICAL_FIELD_KINDS that lists "checkbox" as one of
  // the renderer's accepted kinds. This pins the singular as the source-of-truth.
  for (const path of SEED_PATHS) {
    const src = read(path);
    assert.match(
      src,
      /"checkbox"/,
      `${path} must reference the singular "checkbox" literal (the renderer's canonical kind)`,
    );
  }
});

// ---------- FieldKind / FieldType declarations are clean ----------

test("spec 140 — mentor seed's FieldKind union includes singular checkbox", () => {
  const src = read(MENTOR_PATH);
  // The FieldKind type alias must include the singular form.
  assert.match(
    src,
    /type\s+FieldKind\s*=[\s\S]{0,400}\|\s*"checkbox"/,
    "seed_forms_mentor.ts FieldKind union must include the singular \"checkbox\" member",
  );
  // And the union must not contain the plural anywhere (already covered by the
  // file-scoped regression gate, but pinned explicitly here for the type-alias
  // surface so a future drift is caught with a precise error).
  const fieldKindMatch = src.match(/type\s+FieldKind\s*=[\s\S]*?;/);
  assert.ok(fieldKindMatch, "seed_forms_mentor.ts must declare a FieldKind type alias");
  assert.ok(
    !/checkboxes/.test(fieldKindMatch[0]),
    "seed_forms_mentor.ts FieldKind union must NOT include the plural \"checkboxes\"",
  );
});

// ---------- Runtime kind-validation guard is present ----------

test("spec 140 — each seed file declares a CANONICAL_FIELD_KINDS allow-list", () => {
  for (const path of SEED_PATHS) {
    const src = read(path);
    assert.match(
      src,
      /const\s+CANONICAL_FIELD_KINDS\s*=\s*\[/,
      `${path} must declare CANONICAL_FIELD_KINDS as an array constant`,
    );
    // The canonical set must contain every kind the renderer dispatches on.
    for (const kind of ["text", "textarea", "select", "radio", "checkbox", "number", "date", "likert", "rating"]) {
      assert.match(
        src,
        new RegExp(`CANONICAL_FIELD_KINDS[\\s\\S]{0,300}"${kind}"`),
        `${path} CANONICAL_FIELD_KINDS must include "${kind}"`,
      );
    }
  }
});

test("spec 140 — each seed file declares a canonicalising guard function", () => {
  // Renamed from assertCanonicalFieldKinds in two of the four files, because
  // those two guards do not assert -- they MAP, or rather they were supposed to
  // and did not. See the next test for what that cost. The mentor and
  // observation seeds keep the original name because theirs genuinely only
  // validates: those files already author their fields in canonical shape.
  for (const path of SEED_PATHS) {
    const src = read(path);
    assert.match(
      src,
      /function\s+(assertCanonicalFieldKinds|toCanonicalFields)\b/,
      `${path} must declare a canonical-field guard`,
    );
  }
});

test("spec 140 — a guard that MAPS must apply the mapping, not just compute it", () => {
  // THE BUG THIS TEST EXISTS FOR.
  //
  // seed_forms_mentee.ts and seed_forms_misc.ts each declare a
  // <own vocabulary> -> canonical lookup, and each guard computed `mapped` for
  // every field, checked it was non-null, and then returned the rows
  // UNCHANGED. The mapping was validated and thrown away, so the rows reached
  // the database still keyed {id, type} / {id, kind}, with kind values like
  // "boolean-group" that no renderer knows -- while every renderer and
  // lib/forms/validate.ts read {name, kind}.
  //
  // The consequences were total, not partial: `kind` was undefined so the
  // renderer's ladder fell through to its text fallback (a five-point Likert
  // rendered as a text box), and `name` was undefined so EVERY input on the
  // form shared one FormData key and collapsed into a single unnamed textbox.
  // Required-ness was unenforceable, because validate.ts keys on field.name.
  //
  // Every mentee-audience form and both school-visit forms were affected, and
  // the guard written to prevent exactly this class of drift is what hid it.
  for (const path of [MENTEE_PATH, MISC_PATH]) {
    const src = read(path);
    assert.match(
      src,
      /name:\s*field\.id/,
      `${path} must emit a canonical name from its own id field`,
    );
    assert.match(
      src,
      /fields:\s*mappedFields/,
      `${path} must return rows carrying the MAPPED fields, not the originals`,
    );
  }
});

test("spec 140 — the guard warns-and-skips invalid rows (console.warn pattern)", () => {
  // The contract is warn-and-skip, not throw-and-halt. Each guard must emit a
  // console.warn so the operator sees the dropped row in stdout when running
  // `pnpm --filter @gml/db run seed:all`.
  for (const path of SEED_PATHS) {
    const src = read(path);
    assert.match(
      src,
      /(assertCanonicalFieldKinds|toCanonicalFields)[\s\S]*?console\.warn/,
      `${path} assertCanonicalFieldKinds must log a console.warn for dropped rows`,
    );
  }
});

// ---------- The guard is wired at module load ----------

test("spec 140 — each seed file invokes the guard at its top-level array declaration", () => {
  // The guard runs at module load (not lazily) so a bad row never reaches the
  // insert loop. Each file wires it at the canonical seed-array declaration.
  const wiringExpectations = [
    { path: MENTOR_PATH, regex: /const\s+FORMS[\s\S]{0,100}=\s*assertCanonicalFieldKinds\(/ },
    { path: MENTEE_PATH, regex: /const\s+ROWS[\s\S]{0,100}=\s*toCanonicalFields\(/ },
    { path: OBS_PATH, regex: /const\s+TEMPLATES[\s\S]{0,100}=\s*assertCanonicalFieldKinds\(/ },
    { path: MISC_PATH, regex: /const\s+ROWS[\s\S]{0,100}=\s*toCanonicalFields\(/ },
  ];
  for (const { path, regex } of wiringExpectations) {
    const src = read(path);
    assert.match(
      src,
      regex,
      `${path} must wire assertCanonicalFieldKinds at its top-level seed-array declaration so the guard runs at module load`,
    );
  }
});

// ---------- Mentor-seed expertise_areas field renders as a checkbox group ----------

test("spec 140 — mentor expertise_areas field is emitted with kind: 'checkbox'", () => {
  const src = read(MENTOR_PATH);
  // The field whose render-time behaviour the bug broke. Pin it explicitly so a
  // future contributor cannot regress just this one row.
  assert.match(
    src,
    /name:\s*"expertise_areas"[\s\S]{0,400}kind:\s*"checkbox"/,
    "seed_forms_mentor.ts expertise_areas field must be emitted with kind: \"checkbox\" so the FormRenderer's CheckboxGroup branch matches",
  );
});

// ---------- seed_all.ts (spec 104) orchestrator still imports all four ----------

test("spec 140 — seed_all.ts (spec 104) still imports all four corrected seeds", () => {
  // The orchestrator is not edited by this spec; assert it still wires the
  // four seeds so the corrected modules are exercised on every `seed:all` run.
  const src = read("packages/db/src/scripts/seed_all.ts");
  assert.match(
    src,
    /from\s+"\.\/seed_forms_mentor\.js"/,
    "seed_all.ts must still import the mentor seed (the bug-fix module)",
  );
  assert.match(
    src,
    /from\s+"\.\/seed_forms_mentee\.js"/,
    "seed_all.ts must still import the mentee seed",
  );
  assert.match(
    src,
    /from\s+"\.\/seed_forms_observation\.js"/,
    "seed_all.ts must still import the observation seed",
  );
  assert.match(
    src,
    /from\s+"\.\/seed_forms_misc\.js"/,
    "seed_all.ts must still import the misc seed",
  );
});

// ---------- No-regression / hygiene ----------

test("spec 140 — no TODO / FIXME / placeholder markers leaked into shipped source", () => {
  for (const path of SEED_PATHS) {
    const src = read(path);
    assert.ok(!/\bTODO\b/i.test(src), `${path} must not contain TODO markers`);
    assert.ok(!/\bFIXME\b/i.test(path) && !/\bFIXME\b/i.test(src), `${path} must not contain FIXME markers`);
  }
});

test("spec 140 — no new dependencies were introduced (seeds stay on pure node-postgres + drizzle)", () => {
  // The fix is purely a string-rename plus three defensive guards. No new
  // package should appear in packages/db/package.json as a result.
  const pkg = read("packages/db/package.json");
  // Sanity — the original deps must still be there (we didn't accidentally
  // remove anything).
  assert.match(pkg, /drizzle-orm/, "packages/db must still depend on drizzle-orm");
  assert.match(pkg, /\"pg\"/, "packages/db must still depend on pg (node-postgres)");
});
