// Governance test for spec 164 — Migration Ledger Repair
// (Workflow Run 16 post-audit hardening sweep).
//
// The Run 16 sweep flagged a real-but-quiet drizzle-kit bookkeeping
// drift in packages/db/src/migrations/:
//
//   * _journal.json ended at idx: 20 (0020_password_reset_and_lockout).
//   * On disk, 0021_transcode_jobs_dropped_status.sql was authored by
//     spec 162 but the journal entry was missing.
//   * Snapshots for 0020 AND 0021 were both missing — the snapshot
//     chain ended at 0019_snapshot.json.
//
// Net effect: `pnpm --filter @gml/db generate` would re-emit ALL of
// the schema changes from 0020 + 0021 as a single fresh "0021_<random>.sql"
// on every invocation, masking real schema drift behind a perpetual
// false positive.
//
// This test pins the repair so future drift can't sneak in unnoticed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const META_DIR = "packages/db/src/migrations/meta";
const MIGRATIONS_DIR = "packages/db/src/migrations";
const JOURNAL_PATH = `${META_DIR}/_journal.json`;
const SNAP_0020_PATH = `${META_DIR}/0020_snapshot.json`;
const SNAP_0021_PATH = `${META_DIR}/0021_snapshot.json`;
const SPEC_DIR = "specs/164-migration-ledger-repair";

// ---------- Spec-kit + plan.md contract ----------

test("spec 164 — all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist for the migration-ledger-repair spec`,
    );
  }
});

test("spec 164 — plan.md follows the CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare a CREATED: line");
  assert.match(src, /EDITED:/, "plan.md must declare an EDITED: line");
  assert.match(src, /MIGRATED:/, "plan.md must declare a MIGRATED: line");
  // The journal and the two snapshots must be named in plan.md so a
  // reader auditing the contract knows which artefacts changed.
  for (const file of ["_journal.json", "0020_snapshot.json", "0021_snapshot.json"]) {
    assert.match(
      src,
      new RegExp(file.replace(/\./g, "\\.")),
      `plan.md must call out the ${file} touchpoint so the surface is discoverable`,
    );
  }
});

// ---------- (1) _journal.json — idx 21 entry ----------

test("spec 164 — _journal.json has an entry at idx 21 with tag matching /^0021_/", () => {
  const journal = JSON.parse(read(JOURNAL_PATH));
  assert.ok(Array.isArray(journal.entries), "_journal.json must have an entries array");
  const idx21 = journal.entries.find((e) => e.idx === 21);
  assert.ok(idx21, "_journal.json must have an entry at idx 21");
  assert.match(
    idx21.tag,
    /^0021_/,
    `_journal.json idx 21 tag must start with "0021_" — got "${idx21.tag}"`,
  );
  // Pin the specific tag for the spec 162 transcode-jobs migration so
  // a future contributor can't silently swap it for a different tag.
  assert.equal(
    idx21.tag,
    "0021_transcode_jobs_dropped_status",
    "_journal.json idx 21 tag must be exactly '0021_transcode_jobs_dropped_status' (spec 162's manual SQL filename without the .sql suffix)",
  );
});

test("spec 164 — _journal.json idx 21 entry has the canonical shape (version=7, breakpoints=true, integer when)", () => {
  const journal = JSON.parse(read(JOURNAL_PATH));
  const idx21 = journal.entries.find((e) => e.idx === 21);
  assert.ok(idx21, "_journal.json must have an entry at idx 21");
  assert.equal(idx21.version, "7", "idx 21 version must be '7' to match adjacent entries");
  assert.equal(idx21.breakpoints, true, "idx 21 breakpoints must be true — the SQL file uses --> statement-breakpoint markers");
  assert.equal(typeof idx21.when, "number", "idx 21 when must be an epoch-ms number (matches adjacent entries)");
  // idx 21 must come chronologically after idx 20 — the journal's
  // when ordering should match its idx ordering for readability.
  const idx20 = journal.entries.find((e) => e.idx === 20);
  assert.ok(idx20, "_journal.json must have an entry at idx 20 too (the spec 161 migration)");
  assert.ok(
    idx21.when > idx20.when,
    `_journal.json idx 21 when (${idx21.when}) must be greater than idx 20 when (${idx20.when}) so chronological order matches idx order`,
  );
});

// ---------- (2) + (3) Snapshots are present and valid JSON ----------

test("spec 164 — meta/0020_snapshot.json exists and is valid JSON", () => {
  assert.ok(existsSync(resolve(root, SNAP_0020_PATH)), `${SNAP_0020_PATH} must exist`);
  const snap = JSON.parse(read(SNAP_0020_PATH));
  assert.equal(snap.version, "7", "0020 snapshot version must be '7' (matches the drizzle-kit dialect version)");
  assert.equal(snap.dialect, "postgresql", "0020 snapshot dialect must be 'postgresql'");
  assert.ok(snap.id, "0020 snapshot must have a top-level id (uuid) for the snapshot-chain link");
  assert.ok(snap.prevId, "0020 snapshot must have a prevId pointing at 0019_snapshot.json's id");
  // The 0020 snapshot must reflect the spec-161 password_reset_tokens
  // table addition. If that table is missing, the snapshot is wrong.
  assert.ok(snap.tables, "0020 snapshot must have a tables object");
  assert.ok(
    snap.tables["public.password_reset_tokens"],
    "0020 snapshot must include the password_reset_tokens table (added by 0020_password_reset_and_lockout.sql)",
  );
});

test("spec 164 — meta/0021_snapshot.json exists and is valid JSON", () => {
  assert.ok(existsSync(resolve(root, SNAP_0021_PATH)), `${SNAP_0021_PATH} must exist`);
  const snap = JSON.parse(read(SNAP_0021_PATH));
  assert.equal(snap.version, "7", "0021 snapshot version must be '7'");
  assert.equal(snap.dialect, "postgresql", "0021 snapshot dialect must be 'postgresql'");
  assert.ok(snap.id, "0021 snapshot must have a top-level id");
  assert.ok(snap.prevId, "0021 snapshot must have a prevId pointing at 0020_snapshot.json's id");
});

test("spec 164 — 0021_snapshot.json transcode_jobs_status_check includes 'dropped' (the spec-162 delta)", () => {
  // The ONLY schema delta between 0020 and 0021 is that
  // transcode_jobs_status_check gains 'dropped' as a valid status.
  // Pin the post-0021 form so a future contributor can't silently
  // drop it from the snapshot (which would re-introduce drift).
  const snap = JSON.parse(read(SNAP_0021_PATH));
  const transcodeJobs = snap.tables["public.transcode_jobs"];
  assert.ok(transcodeJobs, "0021 snapshot must include the transcode_jobs table");
  const statusCheck = transcodeJobs.checkConstraints?.transcode_jobs_status_check;
  assert.ok(statusCheck, "0021 snapshot must declare the transcode_jobs_status_check constraint");
  assert.match(
    statusCheck.value,
    /'dropped'/,
    "0021 snapshot transcode_jobs_status_check must include 'dropped' as a valid status (the spec-162 delta)",
  );
});

test("spec 164 — 0020_snapshot.json transcode_jobs_status_check does NOT include 'dropped' (pre-0021 state)", () => {
  // The 0020 snapshot captures the state AFTER spec 161 but BEFORE
  // spec 162. So 'dropped' must NOT be in the status enum yet —
  // otherwise the 0020 → 0021 diff is empty and the snapshot chain
  // becomes a no-op (drizzle-kit will refuse to operate).
  const snap = JSON.parse(read(SNAP_0020_PATH));
  const transcodeJobs = snap.tables["public.transcode_jobs"];
  assert.ok(transcodeJobs, "0020 snapshot must include the transcode_jobs table");
  const statusCheck = transcodeJobs.checkConstraints?.transcode_jobs_status_check;
  assert.ok(statusCheck, "0020 snapshot must declare the transcode_jobs_status_check constraint");
  assert.ok(
    !/'dropped'/.test(statusCheck.value),
    "0020 snapshot transcode_jobs_status_check must NOT include 'dropped' (pre-spec-162 state)",
  );
});

// ---------- (4) Journal entries match SQL files (bijective) ----------

test("spec 164 — every .sql file in migrations has a corresponding journal entry (count match)", () => {
  const journal = JSON.parse(read(JOURNAL_PATH));
  const sqlFiles = readdirSync(resolve(root, MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql") && /^\d{4}_/.test(f));
  assert.equal(
    journal.entries.length,
    sqlFiles.length,
    `_journal.json must have one entry per .sql file in ${MIGRATIONS_DIR} — found ${journal.entries.length} entries vs ${sqlFiles.length} .sql files (sql files: ${sqlFiles.join(", ")})`,
  );
  // Every journal tag must have a matching <tag>.sql on disk.
  for (const entry of journal.entries) {
    assert.ok(
      sqlFiles.includes(`${entry.tag}.sql`),
      `_journal.json entry "${entry.tag}" must have a matching ${entry.tag}.sql on disk in ${MIGRATIONS_DIR}`,
    );
  }
});

test("spec 164 — every journal entry's tag starts with its zero-padded idx", () => {
  // Pin so the disk-file-to-journal mapping stays bijective. A future
  // contributor who tries to swap two tag prefixes (e.g. claiming idx
  // 21 belongs to a tag prefixed 0022_) would break drizzle-kit's
  // index-based file lookup.
  const journal = JSON.parse(read(JOURNAL_PATH));
  for (const entry of journal.entries) {
    const expectedPrefix = String(entry.idx).padStart(4, "0") + "_";
    assert.ok(
      entry.tag.startsWith(expectedPrefix),
      `_journal.json entry idx ${entry.idx} tag "${entry.tag}" must start with "${expectedPrefix}"`,
    );
  }
});

// ---------- (5) 0021_*.sql references transcode_jobs ----------

test("spec 164 — 0021_transcode_jobs_dropped_status.sql contains CREATE/ALTER referencing transcode_jobs", () => {
  const sqlPath = `${MIGRATIONS_DIR}/0021_transcode_jobs_dropped_status.sql`;
  assert.ok(existsSync(resolve(root, sqlPath)), `${sqlPath} must exist on disk (the spec-162 manual SQL)`);
  const src = read(sqlPath);
  // The migration's whole job is to widen the transcode_jobs status
  // check. Pin that it references the table name (so a future
  // contributor can't accidentally swap the target).
  assert.match(
    src,
    /transcode_jobs/,
    "0021_transcode_jobs_dropped_status.sql must reference the transcode_jobs table",
  );
  // Pin that it actually does an ALTER (the constraint widening).
  assert.match(
    src,
    /ALTER\s+TABLE\s+"transcode_jobs"/i,
    "0021_transcode_jobs_dropped_status.sql must contain `ALTER TABLE \"transcode_jobs\"` (the constraint-widening DDL)",
  );
  // Pin the 'dropped' literal — without it, the spec-162 contract is
  // broken (the admin DLQ view loses its dedicated status verb).
  assert.match(
    src,
    /'dropped'/,
    "0021_transcode_jobs_dropped_status.sql must declare 'dropped' as a valid status (the load-bearing spec-162 delta)",
  );
});

// ---------- (6) No-regression hygiene ----------

test("spec 164 — no auto-generated 0021_<random>.sql leaked into the migrations folder", () => {
  // The Run-16 repair process produced a transient
  // `0021_gigantic_praxagora.sql` file (or similar — drizzle-kit
  // names regenerated migrations with a random adjective + noun).
  // That file MUST be deleted because the manual
  // `0021_transcode_jobs_dropped_status.sql` already captures the
  // delta with proper inline documentation.
  const sqlFiles = readdirSync(resolve(root, MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"));
  const idx21Files = sqlFiles.filter((f) => /^0021_/.test(f));
  assert.deepEqual(
    idx21Files,
    ["0021_transcode_jobs_dropped_status.sql"],
    `migrations/ must contain exactly one 0021_*.sql file (the manual spec-162 SQL) — found: ${idx21Files.join(", ")}`,
  );
});
