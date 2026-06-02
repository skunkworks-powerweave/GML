// Governance test for spec 143 — Schema cleanup
// (Workflow Run 13 audit-closure CRITICAL+HIGH).
//
// Closes three audit findings in one migration (0016_schema_cleanup):
//
//   (1) observation_evidence.video_submission_id was missing its FK to
//       video_submissions(id). The TS schema declared the column but no
//       migration ever wrote ALTER TABLE … ADD CONSTRAINT, so silent
//       orphans were possible. Fix: add the FK with ON DELETE SET NULL
//       to mirror the cycle.observer_id pattern (caption stays, video
//       reference clears).
//   (2) transcode_jobs.profile CHECK allowed both '480p' and '720p' but
//       720p was dropped in spec 041 (SM-4 / Tier-0 only). Fix: drop the
//       permissive CHECK and re-add it with IN ('480p') only.
//   (3) system_settings singleton was bootstrapped twice — by migration
//       0015 AND by seed.ts::bootstrapSystemSettings. On simultaneous
//       deploys this raced. Fix: remove the seed-side helper; migration
//       0015's INSERT … ON CONFLICT DO NOTHING is now the single source
//       of truth.
//
// Files under audit:
//
//   1. packages/db/src/migrations/0016_schema_cleanup.sql (CREATED)
//   2. packages/db/src/migrations/meta/0016_snapshot.json (CREATED)
//   3. packages/db/src/migrations/meta/_journal.json (EDITED — idx 16)
//   4. packages/db/src/migrations/meta/0017_snapshot.json (EDITED — prevId chain)
//   5. packages/db/src/schema/observation.ts (EDITED — FK declared at TS layer)
//   6. packages/db/src/schema/videos.ts (EDITED — CHECK tightened)
//   7. packages/db/src/scripts/seed.ts (EDITED — bootstrap removed)
//
// Plus the five spec-kit files under
// specs/143-schema-cleanup-fk-check-singleton/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const MIGRATION = "packages/db/src/migrations/0016_schema_cleanup.sql";
const SNAPSHOT_16 = "packages/db/src/migrations/meta/0016_snapshot.json";
const SNAPSHOT_15 = "packages/db/src/migrations/meta/0015_snapshot.json";
const SNAPSHOT_17 = "packages/db/src/migrations/meta/0017_snapshot.json";
const JOURNAL = "packages/db/src/migrations/meta/_journal.json";
const OBSERVATION_TS = "packages/db/src/schema/observation.ts";
const VIDEOS_TS = "packages/db/src/schema/videos.ts";
const SEED_TS = "packages/db/src/scripts/seed.ts";
const SPEC_DIR = "specs/143-schema-cleanup-fk-check-singleton";

// ── Spec-kit + plan.md contract ────────────────────────────────────────────────

test("spec 143 — all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist for the schema-cleanup spec`,
    );
  }
});

test("spec 143 — plan.md follows the CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare a CREATED: line");
  assert.match(src, /EDITED:/, "plan.md must declare an EDITED: line");
  assert.match(src, /MIGRATED:/, "plan.md must declare a MIGRATED: line");
  assert.match(
    src,
    /0016_schema_cleanup\.sql/,
    "plan.md must call out the 0016 migration file",
  );
  assert.match(
    src,
    /observation\.ts/,
    "plan.md must call out the observation.ts schema edit",
  );
  assert.match(
    src,
    /videos\.ts/,
    "plan.md must call out the videos.ts schema edit",
  );
  assert.match(
    src,
    /seed\.ts/,
    "plan.md must call out the seed.ts removal of bootstrapSystemSettings",
  );
});

// ── Migration 0016_schema_cleanup.sql contract ────────────────────────────────

test("spec 143 — 0016_schema_cleanup.sql exists and lives in the migrations directory", () => {
  assert.ok(
    existsSync(resolve(root, MIGRATION)),
    "packages/db/src/migrations/0016_schema_cleanup.sql must exist",
  );
});

test("spec 143 — 0016 migration adds the missing observation_evidence → video_submissions FK", () => {
  const src = read(MIGRATION);
  // The ALTER TABLE … ADD CONSTRAINT statement must reference both tables,
  // both columns, and ON DELETE SET NULL.
  assert.match(
    src,
    /ALTER TABLE\s+"observation_evidence"\s*[\s\S]*?ADD CONSTRAINT/,
    "migration must ALTER observation_evidence ADD CONSTRAINT",
  );
  assert.match(
    src,
    /FOREIGN KEY\s*\(\s*"video_submission_id"\s*\)\s*REFERENCES\s+"public"\."video_submissions"\s*\(\s*"id"\s*\)/,
    "FK must reference public.video_submissions(id) by name",
  );
  assert.match(
    src,
    /ON DELETE\s+set null/i,
    "FK must declare ON DELETE SET NULL — caption survives a video purge (mirrors observer_id)",
  );
  // Drizzle-kit's natural naming convention so future generate runs see no diff.
  assert.match(
    src,
    /observation_evidence_video_submission_id_video_submissions_id_fk/,
    "FK constraint name must match drizzle-kit's auto-generated convention",
  );
});

test("spec 143 — 0016 migration drops the permissive transcode_jobs CHECK and re-adds the 480p-only one", () => {
  const src = read(MIGRATION);
  assert.match(
    src,
    /ALTER TABLE\s+"transcode_jobs"\s+DROP CONSTRAINT\s+"transcode_jobs_profile_check"/,
    "migration must DROP the existing transcode_jobs_profile_check (the permissive '480p','720p' one)",
  );
  // Re-add with the tightened CHECK.
  assert.match(
    src,
    /ADD CONSTRAINT\s+"transcode_jobs_profile_check"[\s\S]*?CHECK[\s\S]*?"profile"\s+IN\s*\(\s*'480p'\s*\)/,
    "migration must ADD the tightened CHECK constraint with profile IN ('480p') only",
  );
  // And critically, the re-added CHECK must NOT mention 720p.
  // We scope the no-720p assertion to the ADD CONSTRAINT block specifically
  // (the header comment is allowed to mention 720p as the audit context).
  const addBlock = src.match(/ADD CONSTRAINT\s+"transcode_jobs_profile_check"[\s\S]*?;/);
  assert.ok(addBlock, "migration must declare an ADD CONSTRAINT for transcode_jobs_profile_check");
  assert.ok(
    !/720p/.test(addBlock[0]),
    "the re-added CHECK must NOT contain '720p' (spec 041 dropped it as SM-4 Tier-0 only)",
  );
});

// ── 0016 snapshot contract ────────────────────────────────────────────────────

test("spec 143 — 0016 snapshot exists, chains off 0015's id, and declares the new FK + tightened CHECK", () => {
  assert.ok(existsSync(resolve(root, SNAPSHOT_16)), "0016 snapshot must exist");
  const snap16 = JSON.parse(read(SNAPSHOT_16));
  const snap15 = JSON.parse(read(SNAPSHOT_15));
  assert.equal(
    snap16.prevId,
    snap15.id,
    "0016 snapshot prevId must chain off 0015's id (verified against the on-disk 0015 snapshot)",
  );
  assert.notEqual(
    snap16.id,
    snap15.id,
    "0016 snapshot must have its own unique id (not reuse 0015's)",
  );
  // The FK must be declared under observation_evidence.foreignKeys.
  const ev = snap16.tables["public.observation_evidence"];
  assert.ok(ev, "0016 snapshot must declare observation_evidence");
  assert.ok(
    ev.foreignKeys?.observation_evidence_video_submission_id_video_submissions_id_fk,
    "0016 snapshot's observation_evidence must declare the video_submission_id FK",
  );
  assert.equal(
    ev.foreignKeys.observation_evidence_video_submission_id_video_submissions_id_fk.onDelete,
    "set null",
    "the FK must declare onDelete=set null in the snapshot",
  );
  // The tightened CHECK must be reflected.
  const jobs = snap16.tables["public.transcode_jobs"];
  assert.ok(jobs, "0016 snapshot must declare transcode_jobs");
  const checkValue =
    jobs.checkConstraints?.transcode_jobs_profile_check?.value ?? "";
  assert.match(
    checkValue,
    /'480p'/,
    "0016 snapshot's transcode_jobs_profile_check must include '480p'",
  );
  assert.ok(
    !/720p/.test(checkValue),
    "0016 snapshot's transcode_jobs_profile_check must NOT include '720p'",
  );
});

// ── Journal + 0017 prevId chain ────────────────────────────────────────────────

test("spec 143 — _journal.json includes the 0016 entry between 15 and 17 with sequential idx", () => {
  const journal = JSON.parse(read(JOURNAL));
  const tags = journal.entries.map((e) => e.tag);
  assert.ok(
    tags.includes("0016_schema_cleanup"),
    "_journal.json must include 0016_schema_cleanup",
  );
  // Sequence check — 16 must sit between 15 and 17.
  const idx15 = tags.indexOf("0015_system_settings");
  const idx16 = tags.indexOf("0016_schema_cleanup");
  const idx17 = tags.indexOf("0017_whatsapp_dedup");
  assert.ok(idx15 < idx16, "0016 must journal after 0015");
  assert.ok(idx16 < idx17, "0016 must journal before 0017 (spec 144 sequenced ahead)");
  // The idx field must be the literal integer 16.
  const entry16 = journal.entries.find((e) => e.tag === "0016_schema_cleanup");
  assert.equal(entry16.idx, 16, "0016 entry must carry idx=16 in the journal");
});

test("spec 143 — 0017 snapshot was re-chained to point its prevId at 0016 (not 0015)", () => {
  const snap16 = JSON.parse(read(SNAPSHOT_16));
  const snap17 = JSON.parse(read(SNAPSHOT_17));
  assert.equal(
    snap17.prevId,
    snap16.id,
    "0017 snapshot's prevId must chain off 0016's id so the ledger is 0015 → 0016 → 0017",
  );
  // 0017 (post-0016) must carry forward the FK + tightened CHECK so the
  // snapshot is internally consistent with the post-0016 schema state.
  const ev = snap17.tables["public.observation_evidence"];
  assert.ok(
    ev?.foreignKeys?.observation_evidence_video_submission_id_video_submissions_id_fk,
    "0017 snapshot must continue to declare the observation_evidence FK introduced in 0016",
  );
  const checkValue =
    snap17.tables["public.transcode_jobs"]?.checkConstraints
      ?.transcode_jobs_profile_check?.value ?? "";
  assert.ok(
    /'480p'/.test(checkValue) && !/720p/.test(checkValue),
    "0017 snapshot's transcode_jobs CHECK must reflect the post-0016 tightening (480p only)",
  );
});

// ── TS-layer schema agreement ─────────────────────────────────────────────────

test("spec 143 — observation.ts declares the FK at the TS layer with onDelete: 'set null'", () => {
  const src = read(OBSERVATION_TS);
  // Must import videoSubmissions.
  assert.match(
    src,
    /import\s*\{\s*videoSubmissions\s*\}\s*from\s*["']\.\/videos["']/,
    "observation.ts must import videoSubmissions from ./videos",
  );
  // The videoSubmissionId column must declare the FK via .references(...).
  assert.match(
    src,
    /videoSubmissionId:\s*uuid\("video_submission_id"\)\.references\(\s*\(\s*\)\s*=>\s*videoSubmissions\.id\s*,\s*\{\s*onDelete:\s*["']set null["']\s*\}\s*\)/,
    "observation.ts must declare .references(() => videoSubmissions.id, { onDelete: 'set null' })",
  );
});

test("spec 143 — videos.ts declares the tightened CHECK at the TS layer (480p only, no 720p)", () => {
  const src = read(VIDEOS_TS);
  // The transcode_jobs_profile_check declaration must contain IN ('480p') only.
  // We grab the exact check() block via a non-greedy match against the
  // constraint name to scope the no-720p assertion. The block spans multiple
  // lines so we use [\s\S] (not . which is line-terminated by default).
  const block = src.match(
    /check\(\s*"transcode_jobs_profile_check"\s*,\s*sql`[\s\S]*?`\s*,?\s*\)/,
  );
  assert.ok(
    block,
    "videos.ts must declare a check() call for transcode_jobs_profile_check",
  );
  assert.match(
    block[0],
    /\$\{t\.profile\}\s+IN\s*\(\s*'480p'\s*\)/,
    "the CHECK must be `${t.profile} IN ('480p')` (480p only)",
  );
  assert.ok(
    !/'720p'/.test(block[0]),
    "the CHECK block must NOT mention '720p' (spec 041 dropped it)",
  );
});

// ── seed.ts — bootstrapSystemSettings was removed ──────────────────────────────

test("spec 143 — seed.ts no longer declares or invokes bootstrapSystemSettings (race eliminated)", () => {
  const src = read(SEED_TS);
  // The function definition must be gone — no `async function
  // bootstrapSystemSettings` source line. Comments may reference the name
  // to explain the removal; we strip comments before the assertion so a
  // documentation reference doesn't false-positive.
  const codeOnly = src
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  assert.ok(
    !/async\s+function\s+bootstrapSystemSettings\b/.test(codeOnly),
    "seed.ts must NOT redeclare bootstrapSystemSettings (migration 0015 owns the bootstrap — spec 143 audit closure)",
  );
  assert.ok(
    !/await\s+bootstrapSystemSettings\s*\(/.test(codeOnly),
    "seed.ts main() must NOT call bootstrapSystemSettings (race with migration 0015 — spec 143 audit closure)",
  );
  // Migration 0015 must still be the idempotent INSERT — that's the single
  // source of truth post-spec-143.
  const migration15 = read("packages/db/src/migrations/0015_system_settings.sql");
  assert.match(
    migration15,
    /INSERT INTO\s+"system_settings"[\s\S]*?'00000000-0000-0000-0000-000000000001'[\s\S]*?ON CONFLICT\s*\("id"\)\s*DO NOTHING/,
    "migration 0015 must remain the idempotent singleton INSERT (single source of truth post-spec-143)",
  );
});

// ── No regressions / hygiene ───────────────────────────────────────────────────

test("spec 143 — no TODO / FIXME / placeholder markers leaked into the migration or snapshot", () => {
  for (const path of [MIGRATION, SNAPSHOT_16]) {
    const src = read(path);
    assert.ok(!/\bTODO\b/i.test(src), `${path} must not contain TODO markers`);
    assert.ok(!/\bFIXME\b/i.test(path) && !/\bFIXME\b/i.test(src), `${path} must not contain FIXME markers`);
  }
});

test("spec 143 — the audit-closure migration is bundled (one file covers all three findings)", () => {
  // The "bundle three findings into one migration" rationale is encoded as a
  // literal comment in the SQL header so a future contributor can't quietly
  // split it back into 0016/0017/0018 noise.
  const src = read(MIGRATION);
  assert.match(
    src,
    /Spec 143/i,
    "migration must reference spec 143 in its header comment for ledger traceability",
  );
  assert.match(
    src,
    /audit.closure/i,
    "migration must reference 'audit closure' in its header so the intent is documented inline",
  );
});
