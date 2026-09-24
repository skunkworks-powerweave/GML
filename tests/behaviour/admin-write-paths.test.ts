// The admin write paths, EXECUTED against a real Postgres.
//
// tests/behaviour/admin-entities.test.ts proves the forms produce rows with
// every NOT NULL column filled. This file proves the database agrees: each row
// is built exactly the way the grid's create action builds it -- the entity's
// real zod schema over string form values -- and inserted with Drizzle the way
// createRowAction inserts it, then read back through the query the reading
// page runs.
//
// It starts from an EMPTY schema (CI migrates from nothing and seeds nothing),
// which is the state a deployment is in after the documented demo purge: the
// point is that an administrator can get from there to a working observation
// cycle and a populated RTT subject page without writing SQL.
//
// Everything runs in one transaction that is rolled back, so it leaves nothing
// behind in any database it is pointed at.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  districts,
  zones,
  schools,
  teachers,
  users,
  observationCycles,
  phases,
  terms,
  rttSubjects,
  rttModules,
  rttLessons,
  rttReadings,
} from "@gml/db/schema";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { mustParse } from "./_admin-submit.ts";

const skip = needsDatabase();

test("from an empty programme, an admin can nominate an observation cycle the observer can see", { skip }, async () => {
  await withClient(async (c) => {
    const db = drizzle(c);
    const t = tag("obs");
    await c.query("BEGIN");
    try {
      const [district] = await db
        .insert(districts)
        .values({ name: `D ${t}`, code: t.slice(-12) })
        .returning({ id: districts.id });
      const [zone] = await db
        .insert(zones)
        .values(mustParse("zones", { name: `Zone ${t}`, districtId: district!.id }) as never)
        .returning({ id: zones.id });

      // The school goes through the grid's form: before `code` was added to it
      // this insert failed the NOT NULL constraint.
      const [school] = await db
        .insert(schools)
        .values(
          mustParse("schools", { name: `School ${t}`, code: t.slice(-12), zoneId: zone!.id }) as never,
        )
        .returning({ id: schools.id });
      const [teacher] = await db
        .insert(teachers)
        .values(mustParse("teachers", { fullName: `Teacher ${t}`, schoolId: school!.id }) as never)
        .returning({ id: teachers.id });

      // public.users.id comes from auth.users on Supabase; CI's plain Postgres
      // has no auth schema, so _post/003 skips that FK and a profile row can be
      // written directly.
      const observerId = randomUUID();
      await db.insert(users).values({ id: observerId, email: `${t}@example.test`, role: "observer" });

      const [cycle] = await db
        .insert(observationCycles)
        .values(
          mustParse("observation-cycles", {
            code: `OBS-${t}`,
            teacherId: teacher!.id,
            observerId,
            kind: "baseline",
            scheduledAt: "2026-10-14",
            topic: "Place value",
          }) as never,
        )
        .returning();

      assert.equal(cycle!.status, "nominated", "a new cycle must enter the workflow at its first stage");

      // lib/authz.ts::cycleVisibilityFilter for an observer, and the ordering
      // /observation uses.
      const visible = await db
        .select({ id: observationCycles.id, topic: observationCycles.topic })
        .from(observationCycles)
        .where(eq(observationCycles.observerId, observerId))
        .orderBy(desc(observationCycles.scheduledAt));
      assert.deepEqual(visible, [{ id: cycle!.id, topic: "Place value" }]);

      // UNIQUE code: a second nomination with the same code is refused by the
      // database, which the generic action surfaces as an error rather than a
      // silent duplicate.
      await c.query("SAVEPOINT dup");
      await assert.rejects(
        db.insert(observationCycles).values(
          mustParse("observation-cycles", {
            code: `OBS-${t}`,
            teacherId: teacher!.id,
            observerId,
            kind: "developmental",
            scheduledAt: "2026-11-01",
          }) as never,
        ),
        /duplicate key|unique/i,
      );
      await c.query("ROLLBACK TO SAVEPOINT dup");
    } finally {
      await c.query("ROLLBACK");
    }
  });
});

test("from an empty programme, an admin can author modules, lessons and readings the subject page renders", { skip }, async () => {
  await withClient(async (c) => {
    const db = drizzle(c);
    const t = tag("rtt");
    await c.query("BEGIN");
    try {
      const [phase] = await db
        .insert(phases)
        .values({ label: `P ${t}`.slice(0, 24), sequence: 99 })
        .returning({ id: phases.id });
      const [term] = await db
        .insert(terms)
        .values({ phaseId: phase!.id, name: `Term ${t}`, sequence: 1 })
        .returning({ id: terms.id });
      const [subject] = await db
        .insert(rttSubjects)
        .values(mustParse("rtt-subjects", { name: `Subject ${t}`, termId: term!.id }) as never)
        .returning({ id: rttSubjects.id });

      const [m2] = await db
        .insert(rttModules)
        .values(mustParse("rtt-modules", { rttSubjectId: subject!.id, sequence: "2", title: "Second" }) as never)
        .returning({ id: rttModules.id });
      const [m1] = await db
        .insert(rttModules)
        .values(mustParse("rtt-modules", { rttSubjectId: subject!.id, sequence: "1", title: "First" }) as never)
        .returning({ id: rttModules.id });
      await db
        .insert(rttLessons)
        .values([
          mustParse("rtt-lessons", { rttModuleId: m1!.id, sequence: "2", title: "Lesson B" }),
          mustParse("rtt-lessons", { rttModuleId: m1!.id, sequence: "1", title: "Lesson A", bodyMd: "Read aloud." }),
        ] as never);
      await db.insert(rttReadings).values(
        mustParse("rtt-readings", {
          rttSubjectId: subject!.id,
          sequence: "1",
          title: "Framework",
          externalUrl: "https://example.org/framework.pdf",
        }) as never,
      );

      // The three reads /rtt/subject/[id] performs.
      const modules = await db
        .select({ id: rttModules.id, title: rttModules.title })
        .from(rttModules)
        .where(eq(rttModules.rttSubjectId, subject!.id))
        .orderBy(rttModules.sequence);
      assert.deepEqual(modules.map((m) => m.title), ["First", "Second"]);

      const lessons = await db
        .select({ moduleId: rttLessons.rttModuleId, title: rttLessons.title })
        .from(rttLessons)
        .where(inArray(rttLessons.rttModuleId, [m1!.id, m2!.id]))
        .orderBy(rttLessons.rttModuleId, rttLessons.sequence);
      assert.deepEqual(
        lessons.filter((l) => l.moduleId === m1!.id).map((l) => l.title),
        ["Lesson A", "Lesson B"],
      );

      const readings = await db
        .select({ title: rttReadings.title, url: rttReadings.externalUrl, fileKey: rttReadings.fileKey })
        .from(rttReadings)
        .where(and(eq(rttReadings.rttSubjectId, subject!.id)))
        .orderBy(rttReadings.sequence);
      assert.deepEqual(readings, [
        { title: "Framework", url: "https://example.org/framework.pdf", fileKey: null },
      ]);
    } finally {
      await c.query("ROLLBACK");
    }
  });
});
