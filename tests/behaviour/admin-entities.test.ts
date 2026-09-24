// The no-code admin tables, EXECUTED -- no database needed.
//
// Every test below imports the real registry and the real Drizzle table
// objects, and runs the real zod schemas over the values an administrator's
// browser (or a CSV file) would send. Nothing here reads source text.
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
//
// Four tables the product READS on every render had no WRITE path at all:
//
//   observation_cycles  the whole Observation module hangs off it; the only
//                       INSERT in the repository was the demo seed, and the
//                       documented purge deletes those rows at hand-over
//   rtt_modules         /rtt/subject/[id] "Modules (0) -- No modules yet." forever
//   rtt_readings        "Required readings (0)" forever
//   rtt_lessons         nothing read or wrote it at all
//
// The generic grid at /admin/data/<slug> and the CSV import behind it only
// reach tables that are registered in ADMIN_ENTITIES, so "registered with a
// form that produces an insertable row" IS the write path. That is what these
// tests pin -- including the generic version of it, which is how the missing
// `schools.code` field was found: /admin/data/schools could not create a
// school, because the form never asked for a NOT NULL column.

import { test } from "node:test";
import assert from "node:assert/strict";
import { getTableColumns, getTableName } from "drizzle-orm";
import type { AnyPgTable } from "drizzle-orm/pg-core";
import { ADMIN_ENTITIES } from "../../apps/web/src/admin/registry.ts";
import { unwrapShape } from "../../apps/web/src/admin/zod-shape.ts";
import { exportColumnKeys } from "../../apps/web/src/admin/export-columns.ts";
import { parseSubmission } from "./_admin-submit.ts";

type Col = { name: string; notNull: boolean; hasDefault: boolean };

function columnsOf(table: AnyPgTable): Record<string, Col> {
  return getTableColumns(table) as unknown as Record<string, Col>;
}

function parse(slug: string, values: Record<string, string>) {
  return parseSubmission(slug, values);
}

function failedOn(result: ReturnType<typeof parse>): string[] {
  return result.success ? [] : result.error.issues.map((i) => String(i.path[0]));
}

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";

// ── The generic contract every registered entity must meet ──────────────────

test("every registered entity's form can produce an INSERTABLE row", () => {
  // A NOT NULL column with no default that the form never asks for makes the
  // create button a guaranteed `null value violates not-null constraint`, and
  // CSV import fails every row the same way. This is the generic statement of
  // "the table has a write path".
  const problems: string[] = [];
  for (const [slug, entity] of Object.entries(ADMIN_ENTITIES)) {
    for (const [key, col] of Object.entries(columnsOf(entity.table))) {
      if (col.notNull && !col.hasDefault && !entity.formFields.includes(key)) {
        problems.push(`${slug}: NOT NULL column ${col.name} is not in formFields`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test("every form field is a real column, and the schema and the field list agree", () => {
  const problems: string[] = [];
  for (const [slug, entity] of Object.entries(ADMIN_ENTITIES)) {
    const cols = columnsOf(entity.table);
    const shape = unwrapShape(entity.formSchema);
    for (const f of entity.formFields) {
      if (!(f in cols)) problems.push(`${slug}: formField ${f} is not a column`);
      if (!(f in shape)) problems.push(`${slug}: formField ${f} has no zod rule`);
    }
    for (const k of Object.keys(shape)) {
      if (!entity.formFields.includes(k)) problems.push(`${slug}: zod key ${k} is not rendered`);
    }
    for (const c of entity.displayColumns) {
      if (!(c.key in cols)) problems.push(`${slug}: display column ${c.key} is not a column`);
    }
  }
  assert.deepEqual(problems, []);
});

test("the CSV export carries each row's id, so a child CSV can reference its parent", () => {
  // classes.csv needs schoolId, sessions.csv needs classId, learners.csv needs
  // classId -- all UUIDs, and csv.ts does not resolve codes to ids. The only
  // place an administrator can get those UUIDs from is the parent's export,
  // and the export used displayColumns alone, which no entity lists `id` in.
  // So the documented load order (import parent, export it, paste the id
  // column into the child) could not be carried out.
  const problems: string[] = [];
  let withId = 0;
  for (const [slug, entity] of Object.entries(ADMIN_ENTITIES)) {
    const keys = exportColumnKeys(entity);
    // A join table keyed on its two FKs (resource-subjects) has no id to give.
    if ("id" in columnsOf(entity.table)) {
      withId += 1;
      if (keys[0] !== "id") problems.push(`${slug}: export starts with ${keys[0]}, not id`);
    }
    if (new Set(keys).size !== keys.length) problems.push(`${slug}: duplicate export column`);
    for (const c of entity.displayColumns) {
      if (!keys.includes(c.key)) problems.push(`${slug}: export lost display column ${c.key}`);
    }
  }
  assert.deepEqual(problems, []);
  assert.ok(withId >= 15, "the id check must actually have run against the parent tables");
});

test("a school can be created from the grid (the form asks for its code)", () => {
  // schools.code is NOT NULL UNIQUE. The form did not include it, so after the
  // documented demo purge nobody could create the first school -- and every
  // class, teacher and learner hangs off a school.
  const ok = parse("schools", { name: "Govt. High School Leh", code: "GHS-LEH", zoneId: UUID_A });
  assert.ok(ok.success, JSON.stringify(ok.success ? null : ok.error.issues));
  assert.deepEqual(failedOn(parse("schools", { name: "No code", zoneId: UUID_A })), ["code"]);
  assert.deepEqual(
    failedOn(parse("schools", { name: "Too long", code: "X".repeat(17), zoneId: UUID_A })),
    ["code"],
    "schools.code is varchar(16); longer must be a field error, not a Postgres error",
  );
});

// ── Defect B#1: observation cycles ───────────────────────────────────────────

test("observation cycles are registered against the observation_cycles table", () => {
  const e = ADMIN_ENTITIES["observation-cycles"];
  assert.ok(e, "no admin entity for observation cycles -- nothing in the product can create one");
  assert.equal(getTableName(e.table), "observation_cycles");
  assert.deepEqual(e.readRoles.sort(), ["programme_admin", "super_admin"]);
  assert.deepEqual((e.mutateRoles ?? []).sort(), ["programme_admin", "super_admin"]);
});

test("an administrator's nomination parses into an insertable cycle", () => {
  const r = parse("observation-cycles", {
    code: "OBS-2026-101",
    teacherId: UUID_A,
    observerId: UUID_B,
    kind: "baseline",
    scheduledAt: "2026-10-14",
    subjectId: UUID_C,
    topic: "Fractions on a number line",
  });
  assert.ok(r.success, JSON.stringify(r.success ? null : r.error.issues));
  const row = r.data as Record<string, unknown>;
  assert.equal(row.kind, "baseline");
  assert.ok(row.scheduledAt instanceof Date, "scheduledAt must reach Drizzle as a Date");
  assert.equal(row.topic, "Fractions on a number line");
});

test("a nomination without an observer, kind, code, teacher or date is refused", () => {
  // observerId: nullable in the DB, but authz scopes an observer to
  // observer_id = me, so a cycle with no observer is invisible to every
  // observer and its observer stage can never be reached.
  // kind: NOT NULL, no default. code: NOT NULL UNIQUE varchar(48).
  // scheduledAt: /observation orders by scheduled_at DESC (NULLS FIRST), so an
  // undated cycle would pin itself to the top of every list.
  const r = parse("observation-cycles", { topic: "only a topic" });
  assert.deepEqual(
    failedOn(r).sort(),
    ["code", "kind", "observerId", "scheduledAt", "teacherId"],
  );
  assert.deepEqual(
    failedOn(
      parse("observation-cycles", {
        code: "X".repeat(49),
        teacherId: UUID_A,
        observerId: UUID_B,
        kind: "baseline",
        scheduledAt: "2026-10-14",
      }),
    ),
    ["code"],
  );
  assert.deepEqual(
    failedOn(
      parse("observation-cycles", {
        code: "OBS-1",
        teacherId: UUID_A,
        observerId: UUID_B,
        kind: "summative",
        scheduledAt: "2026-10-14",
      }),
    ),
    ["kind"],
  );
});

test("the grid cannot move a cycle's workflow stage", () => {
  // status is advanced ONLY by observation/[cycleId]/actions.ts, whose guarded
  // transition checks the current stage and writes the stage's form in the
  // same transaction. A `status` field here would let an edit jump a cycle to
  // "complete" with no forms behind it -- and a zod `.default("nominated")`
  // would silently reset a live cycle every time someone fixed a typo in its
  // topic.
  const e = ADMIN_ENTITIES["observation-cycles"]!;
  assert.ok(!e.formFields.includes("status"));
  assert.ok(!("status" in unwrapShape(e.formSchema)));
});

// ── Defects B#2 / B#6: RTT modules, readings, lessons ───────────────────────

test("rtt modules, readings and lessons each have an admin table", () => {
  for (const [slug, table] of [
    ["rtt-modules", "rtt_modules"],
    ["rtt-readings", "rtt_readings"],
    ["rtt-lessons", "rtt_lessons"],
  ] as const) {
    const e = ADMIN_ENTITIES[slug];
    assert.ok(e, `${slug} is not registered -- ${table} has no write path anywhere in the product`);
    assert.equal(getTableName(e.table), table);
    assert.ok(
      (e.mutateRoles ?? e.readRoles).every((r) => r === "programme_admin" || r === "super_admin"),
      `${slug}: only administrators may author course content`,
    );
  }
});

test("a module row, as the grid or a CSV submits it, parses", () => {
  const r = parse("rtt-modules", {
    rttSubjectId: UUID_A,
    sequence: "1",
    title: "Reading aloud in the early grades",
    description: "Why and how",
  });
  assert.ok(r.success, JSON.stringify(r.success ? null : r.error.issues));
  assert.equal((r.data as { sequence: unknown }).sequence, 1);
  assert.deepEqual(failedOn(parse("rtt-modules", { title: "No subject" })).sort(), [
    "rttSubjectId",
    "sequence",
  ]);
});

test("a lesson row parses, and hangs off a module", () => {
  const r = parse("rtt-lessons", { rttModuleId: UUID_A, sequence: "2", title: "Modelling", bodyMd: "Read the text aloud first." });
  assert.ok(r.success, JSON.stringify(r.success ? null : r.error.issues));
  assert.deepEqual(failedOn(parse("rtt-lessons", { title: "Orphan" })).sort(), ["rttModuleId", "sequence"]);
  // video_id "lands with spec 036" and has no FK today: a free-text uuid box
  // would store ids that point at nothing.
  assert.ok(!ADMIN_ENTITIES["rtt-lessons"]!.formFields.includes("videoId"));
});

test("a reading is an external link -- the form cannot author a 404 button", () => {
  const e = ADMIN_ENTITIES["rtt-readings"]!;
  // file_key is a MinIO object key and MinIO is out of the stack: nothing can
  // serve it. The page's fileKey branch routed an rtt_readings id to a viewer
  // that looks the id up in `resources`, i.e. a guaranteed 404.
  assert.ok(!e.formFields.includes("fileKey"));

  const ok = parse("rtt-readings", {
    rttSubjectId: UUID_A,
    sequence: "1",
    title: "NCERT reading framework",
    externalUrl: "https://ncert.nic.in/pdf/framework.pdf",
  });
  assert.ok(ok.success, JSON.stringify(ok.success ? null : ok.error.issues));

  const noLink = parse("rtt-readings", { rttSubjectId: UUID_A, sequence: "1", title: "No link" });
  assert.deepEqual(failedOn(noLink), ["externalUrl"], "a reading with no link renders nothing to open");

  // The value is rendered as an <a href>; a javascript: URL would run in the
  // session of every teacher who clicks "Open".
  const script = parse("rtt-readings", {
    rttSubjectId: UUID_A,
    sequence: "1",
    title: "Hostile",
    externalUrl: "javascript:alert(document.cookie)",
  });
  assert.deepEqual(failedOn(script), ["externalUrl"]);
});
