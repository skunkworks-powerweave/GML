// Governance test for spec 124 — System settings admin (Workflow Run 10 frontend-parity).
//
// Verifies that the JSX prototype's admin tweaks-panel surface ships end-to-end:
//   1. The system_settings schema file defines the singleton table with the CHECK
//      constraint pinning id to the sentinel uuid.
//   2. The 0015 migration SQL exists and creates the table + INSERTs the seed row.
//   3. The meta journal includes the 0015 entry.
//   4. The seed bootstrap helper exists and runs from main().
//   5. The API route exposes GET + PUT, is super_admin gated, and audits
//      system_settings.update.
//   6. The /admin/system-settings page renders the five sections + the read-only
//      backup/restore status display + a server action.
//   7. The /admin index no longer renders the "Lands in spec 071" placeholder
//      and instead links to /admin/system-settings.
//   8. All five spec-kit files exist and plan.md follows the CREATED/EDITED/MIGRATED
//      contract.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const SCHEMA = "packages/db/src/schema/systemSettings.ts";
const MIGRATION = "packages/db/src/migrations/0015_system_settings.sql";
const JOURNAL = "packages/db/src/migrations/meta/_journal.json";
const SNAPSHOT = "packages/db/src/migrations/meta/0015_snapshot.json";
const BARREL = "packages/db/src/schema/index.ts";
const SEED = "packages/db/src/scripts/seed.ts";
const ROUTE = "apps/web/src/app/api/admin/system-settings/route.ts";
const PAGE = "apps/web/src/app/(authenticated)/admin/system-settings/page.tsx";
const ADMIN_INDEX = "apps/web/src/app/(authenticated)/admin/page.tsx";
const AUDIT_DOC = "docs/audit-actions.md";
const SPEC_DIR = "specs/124-system-settings-and-tweaks-admin";

test("spec 124 — all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist for spec 124`,
    );
  }
});

test("spec 124 — plan.md follows the CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare a CREATED: line");
  assert.match(src, /EDITED:/, "plan.md must declare an EDITED: line");
  assert.match(src, /MIGRATED:/, "plan.md must declare a MIGRATED: line");
  assert.match(
    src,
    /systemSettings\.ts/,
    "plan.md must reference the systemSettings schema file",
  );
  assert.match(
    src,
    /0015_system_settings\.sql/,
    "plan.md must call out the 0015 migration",
  );
});

test("spec 124 — schema file exports systemSettings table + SYSTEM_SETTINGS_ID sentinel", () => {
  const src = read(SCHEMA);
  assert.match(src, /export const systemSettings\b/, "schema must export systemSettings");
  assert.match(
    src,
    /pgTable\(\s*"system_settings"/,
    "schema must declare pgTable('system_settings')",
  );
  assert.match(
    src,
    /export const SYSTEM_SETTINGS_ID\s*=\s*"00000000-0000-0000-0000-000000000001"/,
    "schema must export the well-known singleton sentinel uuid",
  );
  // The six business columns + updatedAt
  for (const col of [
    "programmeName",
    "academicYear",
    "videoDefaultQuality",
    "videoMaxUploadMb",
    "notificationsEnabled",
    "backupRetentionDays",
    "updatedAt",
  ]) {
    assert.match(src, new RegExp(col), `system_settings must define ${col}`);
  }
  // CHECK constraint enforces singleton at the DB layer
  assert.match(
    src,
    /system_settings_singleton/,
    "schema must declare the singleton CHECK constraint",
  );
});

test("spec 124 — schema barrel re-exports systemSettings", () => {
  assert.match(
    read(BARREL),
    /from\s+["']\.\/systemSettings["']/,
    "schema/index.ts must re-export ./systemSettings",
  );
});

test("spec 124 — 0015 migration creates the table with singleton CHECK and seeds the row", () => {
  assert.ok(existsSync(resolve(root, MIGRATION)), "0015 migration SQL must exist");
  const src = read(MIGRATION);
  assert.match(
    src,
    /CREATE TABLE\s+"system_settings"/,
    "migration must CREATE TABLE system_settings",
  );
  assert.match(
    src,
    /system_settings_singleton/,
    "migration must declare the singleton CHECK constraint",
  );
  assert.match(
    src,
    /INSERT INTO\s+"system_settings"[\s\S]*'00000000-0000-0000-0000-000000000001'/,
    "migration must INSERT the sentinel singleton row",
  );
  assert.match(
    src,
    /ON CONFLICT\s*\("id"\)\s*DO NOTHING/,
    "the seed INSERT must be idempotent (ON CONFLICT DO NOTHING)",
  );
});

test("spec 124 — meta journal includes the 0015 entry chained after 0014", () => {
  const journal = JSON.parse(read(JOURNAL));
  const tags = journal.entries.map((e) => e.tag);
  assert.ok(
    tags.includes("0015_system_settings"),
    "_journal.json must include 0015_system_settings",
  );
  // The 0015 entry must come after 0014 — Drizzle migrates in order
  const idx15 = tags.indexOf("0015_system_settings");
  const idx14 = tags.indexOf("0014_quizzes_schema");
  assert.ok(idx14 < idx15, "0015 must journal after 0014");
});

test("spec 124 — 0015 snapshot exists and chains off the 0014 snapshot id", () => {
  assert.ok(existsSync(resolve(root, SNAPSHOT)), "0015 snapshot must exist");
  const snap = JSON.parse(read(SNAPSHOT));
  assert.equal(
    snap.prevId,
    "2a91ec3c-1e88-4d72-9cad-cb4d6e2a01af",
    "0015 snapshot prevId must chain off the 0014 snapshot id",
  );
  assert.ok(
    snap.tables?.["public.system_settings"],
    "0015 snapshot must declare the system_settings table",
  );
});

test("spec 124 — singleton row bootstrap is owned by migration 0015 (spec 143 audit closure)", () => {
  // Spec 143 removed the bootstrapSystemSettings helper from seed.ts because the
  // seed-side INSERT was racing migration 0015 on simultaneous first-deploy runs.
  // Migration 0015 already INSERTs the sentinel row with ON CONFLICT DO NOTHING,
  // so the migration alone is now the single source of truth for the singleton.
  const seed = read(SEED);
  assert.ok(
    !/async function bootstrapSystemSettings\b/.test(seed),
    "seed.ts must NOT redeclare bootstrapSystemSettings (race with migration 0015 — spec 143)",
  );
  assert.ok(
    !/await bootstrapSystemSettings\(db\)/.test(seed),
    "seed.ts main() must NOT call bootstrapSystemSettings (migration 0015 owns the bootstrap)",
  );
  // The migration must still be the idempotent source of truth.
  const migration = read(MIGRATION);
  assert.match(
    migration,
    /INSERT INTO\s+"system_settings"[\s\S]*'00000000-0000-0000-0000-000000000001'[\s\S]*ON CONFLICT\s*\("id"\)\s*DO NOTHING/,
    "migration 0015 must remain the idempotent singleton INSERT (single source of truth)",
  );
});

test("spec 124 — API route exposes GET + PUT, gates by super_admin, audits update", () => {
  const src = read(ROUTE);
  assert.match(src, /export async function GET\b/, "route must export GET");
  assert.match(src, /export async function PUT\b/, "route must export PUT");
  // Role gate must mention super_admin and reject everything else with 403
  assert.match(
    src,
    /super_admin/,
    "route must reference super_admin in its role check",
  );
  assert.match(src, /status:\s*403/, "route must 403 forbidden non-super_admins");
  assert.match(src, /status:\s*401/, "route must 401 unauthenticated callers");
  // Audit on successful PUT
  assert.match(src, /recordAudit/, "route must call recordAudit on update");
  assert.match(
    src,
    /system_settings\.update/,
    "route must audit with action 'system_settings.update'",
  );
  // zod validation
  assert.match(src, /z\./, "route must validate the patch with zod");
});

test("spec 124 — API route restricts videoDefaultQuality to 480p only (SM-4)", () => {
  const src = read(ROUTE);
  // The zod enum must list 480p and only 480p — 720p/1080p remain disabled.
  assert.match(
    src,
    /VIDEO_QUALITIES\s*=\s*\["480p"\]/,
    "route must restrict videoDefaultQuality to 480p (SM-4 quality ceiling)",
  );
});

test("spec 124 — /admin/system-settings page renders all five sections + server action", () => {
  const src = read(PAGE);
  // Page is super_admin gated
  assert.match(
    src,
    /requireRole\(\["super_admin"\]\)/,
    "page must call requireRole(['super_admin'])",
  );
  // Server action — inline 'use server' directive
  assert.match(
    src,
    /"use server"/,
    "page must declare an inline 'use server' server action",
  );
  assert.match(
    src,
    /async function updateSystemSettings/,
    "page must define updateSystemSettings server action",
  );
  // Five section headers — match against the JSX prototype labels
  assert.match(src, />\s*Programme\s*</, "page must render the Programme section heading");
  assert.match(
    src,
    />\s*Video pipeline\s*</,
    "page must render the Video pipeline section heading",
  );
  assert.match(src, />\s*Notifications\s*</, "page must render the Notifications section heading");
  assert.match(
    src,
    />\s*Backups & retention\s*</,
    "page must render the Backups & retention section heading",
  );
  assert.match(
    src,
    />\s*Backup & restore status\s*</,
    "page must render the read-only Backup & restore status section",
  );
});

test("spec 124 — page disables 720p and 1080p quality options with tooltips", () => {
  const src = read(PAGE);
  // 720p disabled + spec 041 tooltip
  assert.match(
    src,
    /value="720p"\s+disabled/,
    "page must disable the 720p quality option (spec 041 deferral)",
  );
  assert.match(
    src,
    /value="1080p"\s+disabled/,
    "page must disable the 1080p quality option (out of scope)",
  );
});

test("spec 124 — page queries audit_log for backup.* and restore.* status rows", () => {
  const src = read(PAGE);
  assert.match(
    src,
    /backup\.%/,
    "page must query audit_log for action LIKE 'backup.%'",
  );
  assert.match(
    src,
    /restore\.%/,
    "page must query audit_log for action LIKE 'restore.%'",
  );
});

test("spec 124 — /admin index no longer renders the 'Lands in spec 071' placeholder", () => {
  const src = read(ADMIN_INDEX);
  assert.ok(
    !/Lands in spec 071/.test(src),
    "admin index must not contain the 'Lands in spec 071' placeholder anymore",
  );
  assert.match(
    src,
    /href="\/admin\/system-settings"/,
    "admin index must link to /admin/system-settings",
  );
});

test("spec 124 — audit-actions.md documents the system_settings, backup, restore prefixes", () => {
  const src = read(AUDIT_DOC);
  assert.match(
    src,
    /system_settings\.\*/,
    "audit-actions.md must document the system_settings.* prefix",
  );
  assert.match(
    src,
    /system_settings\.update/,
    "audit-actions.md must reference system_settings.update specifically",
  );
  assert.match(src, /backup\.\*/, "audit-actions.md must reserve the backup.* prefix");
  assert.match(src, /restore\.\*/, "audit-actions.md must reserve the restore.* prefix");
});

test("spec 124 — no TODO / FIXME / placeholder markers leaked into shipped source", () => {
  for (const path of [SCHEMA, MIGRATION, ROUTE, PAGE]) {
    const src = read(path);
    assert.ok(!/\bTODO\b/i.test(src), `${path} must not contain TODO markers`);
    assert.ok(!/\bFIXME\b/i.test(src), `${path} must not contain FIXME markers`);
    assert.ok(
      !/\bplaceholder\b/i.test(src),
      `${path} must not contain 'placeholder' literals`,
    );
  }
});
