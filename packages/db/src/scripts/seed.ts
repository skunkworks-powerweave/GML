// Spec 086 — Ladakh v2 seed data.
// Spec 103 — extended with super_admin bootstrap (Workflow Run 6 Tier B1).
// Spec 143 — bootstrapSystemSettings helper removed; migration 0015 owns the
//            singleton INSERT idempotently and was racing the seed-time UPSERT
//            on concurrent first-deploy runs. The migration alone is now the
//            single source of truth for the well-known row. See
//            specs/143-schema-cleanup-fk-check-singleton/research.md.
// Idempotent: skips inserts if rows already exist for any seed key.

import "dotenv/config";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq, sql } from "drizzle-orm";
import * as schema from "../schema/index.js";

const DRY_RUN = process.env.SEED_DRY_RUN === "true";

export async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL not set");
    process.exit(1);
  }
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool);

  // Spec 103 — super_admin bootstrap (runs first, idempotent, independent of district seed).
  // README-IT previously instructed operators to manually run an UPDATE on `users.role`
  // after first login because no seeded super_admin existed. This block creates that user
  // from environment variables so a fresh deployment has a working super_admin out-of-box.
  await bootstrapSuperAdmin(db);
  await bootstrapSectionGates(db);

  // Spec 143 — system_settings singleton bootstrap moved entirely into migration 0015
  // (which already used INSERT … ON CONFLICT DO NOTHING). The previous seed-side helper
  // raced the migration on simultaneous first-deploy runs; deleting it eliminates the
  // race while keeping the bootstrap idempotent — `pnpm db:migrate` always inserts the
  // sentinel row before the app starts. The audit-recovery hook for an accidentally
  // truncated table is now `pnpm db:migrate` (re-applies 0015's INSERT) rather than
  // `pnpm db:seed`.

  console.log("[seed] checking existing rows…");
  // db.execute() with node-postgres returns a pg QueryResult { rows, rowCount }, not an array.
  // Destructuring directly off the QueryResult fails TS2488 (no Symbol.iterator), so we
  // pull the first row out of .rows explicitly.
  const districtsCountResult = await db.execute(sql`SELECT COUNT(*)::int AS c FROM districts`);
  const districtsCount = districtsCountResult.rows[0] as { c: number } | undefined;
  if ((districtsCount?.c ?? 0) > 0) {
    console.log("[seed] districts already exist — skipping seed (idempotent)");
    await pool.end();
    return;
  }

  if (DRY_RUN) {
    console.log("[seed] DRY_RUN — would insert seed data; exiting");
    await pool.end();
    return;
  }

  console.log("[seed] inserting Ladakh districts, zones, schools, teachers, mentors, pairings, cycles, phases, subjects…");

  // Districts
  const [leh] = await db
    .insert(schema.districts)
    .values({ name: "Leh", code: "LEH" })
    .returning({ id: schema.districts.id });
  const [kargil] = await db
    .insert(schema.districts)
    .values({ name: "Kargil", code: "KGL" })
    .returning({ id: schema.districts.id });

  // Zones (5 Leh + 6 Kargil)
  const zoneInsert = await db
    .insert(schema.zones)
    .values([
      { districtId: leh.id, name: "Leh Town" },
      { districtId: leh.id, name: "Khaltsi" },
      { districtId: leh.id, name: "Nubra" },
      { districtId: leh.id, name: "Nyoma" },
      { districtId: leh.id, name: "Durbuk" },
      { districtId: kargil.id, name: "Kargil" },
      { districtId: kargil.id, name: "Sankoo" },
      { districtId: kargil.id, name: "Shargole" },
      { districtId: kargil.id, name: "Shikar Chiktan" },
      { districtId: kargil.id, name: "Zangskar" },
      { districtId: kargil.id, name: "Drass" },
    ])
    .returning({ id: schema.zones.id, name: schema.zones.name });

  const zoneByName = Object.fromEntries(zoneInsert.map((z) => [z.name, z.id]));

  // Schools (10 sample)
  const schoolsInsert = await db
    .insert(schema.schools)
    .values([
      { zoneId: zoneByName["Shikar Chiktan"], code: "GPS-CHU", name: "GPS Shikar Chiktan", contactPhone: "+91 1985 200001" },
      { zoneId: zoneByName["Khaltsi"], code: "GMS-KHA", name: "GMS Khaltsi", contactPhone: "+91 1982 200002" },
      { zoneId: zoneByName["Nubra"], code: "GHS-DSK", name: "GHS Diskit", contactPhone: "+91 1980 200003" },
      { zoneId: zoneByName["Drass"], code: "GMS-DRS", name: "GMS Drass", contactPhone: "+91 1985 200004" },
      { zoneId: zoneByName["Zangskar"], code: "GHS-PDM", name: "GHS Padum", contactPhone: "+91 1983 200005" },
      { zoneId: zoneByName["Kargil"], code: "GHS-KGL", name: "GHS Kargil", contactPhone: "+91 1985 200006" },
      { zoneId: zoneByName["Nyoma"], code: "GMS-NYM", name: "GMS Nyoma", contactPhone: "+91 1982 200007" },
      { zoneId: zoneByName["Leh Town"], code: "GHS-LEH", name: "GHS Leh", contactPhone: "+91 1982 200008" },
      { zoneId: zoneByName["Sankoo"], code: "GPS-SNK", name: "GPS Sankoo", contactPhone: "+91 1985 200009" },
      { zoneId: zoneByName["Shargole"], code: "GMS-SRG", name: "GMS Shargole", contactPhone: "+91 1985 200010" },
    ])
    .returning({ id: schema.schools.id, code: schema.schools.code });

  const schoolByCode = Object.fromEntries(schoolsInsert.map((s) => [s.code, s.id]));

  // Teachers (10) with hindi_name + current_phase
  const teachersData = [
    { schoolCode: "GMS-KHA", fullName: "Tsering Dolma", hindiName: "ཚེ་རིང་སྒྲོལ་མ", phone: "+91 9419100001", subjectSpecialism: "English", joinedPhase: "Phase 2" },
    { schoolCode: "GHS-DSK", fullName: "Sonam Wangchuk", hindiName: "བསོད་ནམས་དབང་ཕྱུག", phone: "+91 9419100002", subjectSpecialism: "Science", joinedPhase: "Phase 2" },
    { schoolCode: "GPS-CHU", fullName: "Yangchen Dolkar", hindiName: "དབྱངས་ཅན་སྒྲོལ་དཀར", phone: "+91 9419100003", subjectSpecialism: "English", joinedPhase: "Phase 2" },
    { schoolCode: "GHS-DSK", fullName: "Stanzin Norbu", hindiName: "བསྟན་འཛིན་ནོར་བུ", phone: "+91 9419100004", subjectSpecialism: "Math", joinedPhase: "Phase 1" },
    { schoolCode: "GMS-DRS", fullName: "Fatima Bano", hindiName: "फ़ातिमा बानो", phone: "+91 9419100005", subjectSpecialism: "English", joinedPhase: "Phase 2" },
    { schoolCode: "GHS-PDM", fullName: "Khatija Begum", hindiName: "ख़तीजा बेगम", phone: "+91 9419100006", subjectSpecialism: "Hindi", joinedPhase: "Phase 2" },
    { schoolCode: "GHS-KGL", fullName: "Mohd. Sadiq", hindiName: "मोहम्मद सादिक़", phone: "+91 9419100007", subjectSpecialism: "Urdu", joinedPhase: "Phase 1" },
    { schoolCode: "GMS-NYM", fullName: "Padma Lhamo", hindiName: "པད་མ་ལྷ་མོ", phone: "+91 9419100008", subjectSpecialism: "Math", joinedPhase: "Phase 2" },
    { schoolCode: "GHS-LEH", fullName: "Rinchen Angmo", hindiName: "རིན་ཆེན་ཨང་མོ", phone: "+91 9419100009", subjectSpecialism: "EVS", joinedPhase: "Phase 3" },
    { schoolCode: "GMS-SRG", fullName: "Iqbal Khan", hindiName: "इक़बाल ख़ान", phone: "+91 9419100010", subjectSpecialism: "Science", joinedPhase: "Phase 2" },
  ];

  const teachersInsert = await db
    .insert(schema.teachers)
    .values(
      teachersData.map((t) => ({
        schoolId: schoolByCode[t.schoolCode],
        fullName: t.fullName,
        hindiName: t.hindiName,
        phone: t.phone,
        subjectSpecialism: t.subjectSpecialism,
        joinedPhase: t.joinedPhase,
      })),
    )
    .returning({ id: schema.teachers.id, fullName: schema.teachers.fullName });

  // Mentors
  const mentorsInsert = await db
    .insert(schema.mentors)
    .values([
      { name: "Dr. Anjali Bhatt", hindiName: "डॉ. अंजली भट्ट", baseLocation: "Leh", expertiseAreas: ["English", "Reading"], bio: "20 years in language pedagogy across Himalayan regions." },
      { name: "Prof. Iqbal Hussain", hindiName: "प्रो. इक़बाल हुसैन", baseLocation: "Kargil", expertiseAreas: ["Math", "Science"], bio: "Former NCERT advisor; specialises in CPA method." },
    ])
    .returning({ id: schema.mentors.id, name: schema.mentors.name });

  // Curriculum subjects
  const curricularInsert = await db
    .insert(schema.subjects)
    .values([
      { name: "English", code: "ENG", color: "#D97757", gradesMin: 1, gradesMax: 12, displayOrder: 1 },
      { name: "Math", code: "MAT", color: "#2A6FDB", gradesMin: 1, gradesMax: 12, displayOrder: 2 },
      { name: "EVS", code: "EVS", color: "#1F8A5B", gradesMin: 1, gradesMax: 5, displayOrder: 3 },
      { name: "Hindi", code: "HIN", color: "#7A5AE0", gradesMin: 1, gradesMax: 12, displayOrder: 4 },
      { name: "Urdu", code: "URD", color: "#7A5AE0", gradesMin: 1, gradesMax: 12, displayOrder: 5 },
      { name: "Science", code: "SCI", color: "#1F8A5B", gradesMin: 6, gradesMax: 12, displayOrder: 6 },
      { name: "Social Studies", code: "SS", color: "#D97757", gradesMin: 6, gradesMax: 12, displayOrder: 7 },
      { name: "Art", code: "ART", color: "#D97757", gradesMin: 1, gradesMax: 8, displayOrder: 8 },
      { name: "Ladakhi Studies", code: "LDK", color: "#7A5AE0", gradesMin: 1, gradesMax: 12, displayOrder: 9 },
    ])
    .returning({ id: schema.subjects.id, code: schema.subjects.code });
  const subjectByCode = Object.fromEntries(curricularInsert.map((s) => [s.code, s.id]));

  // RTT phases + terms + RTT subjects (training units)
  const phaseInsert = await db
    .insert(schema.phases)
    .values([
      { label: "Phase 1", sequence: 1, startDate: new Date("2025-04-01"), endDate: new Date("2025-09-30") },
      { label: "Phase 2", sequence: 2, startDate: new Date("2025-10-01"), endDate: new Date("2026-03-31") },
      { label: "Phase 3", sequence: 3, startDate: new Date("2026-04-01"), endDate: new Date("2026-09-30") },
    ])
    .returning({ id: schema.phases.id, label: schema.phases.label });
  const phaseByLabel = Object.fromEntries(phaseInsert.map((p) => [p.label, p.id]));

  const termsInsert = await db
    .insert(schema.terms)
    .values([
      { phaseId: phaseByLabel["Phase 1"], name: "Term 1", sequence: 1 },
      { phaseId: phaseByLabel["Phase 1"], name: "Term 2", sequence: 2 },
      { phaseId: phaseByLabel["Phase 2"], name: "Term 1", sequence: 1 },
      { phaseId: phaseByLabel["Phase 2"], name: "Term 2", sequence: 2 },
      { phaseId: phaseByLabel["Phase 3"], name: "Term 1", sequence: 1 },
    ])
    .returning({ id: schema.terms.id, phaseId: schema.terms.phaseId, name: schema.terms.name });

  const p2t2 = termsInsert.find((t) => t.phaseId === phaseByLabel["Phase 2"] && t.name === "Term 2")!.id;
  await db.insert(schema.rttSubjects).values([
    { termId: p2t2, name: "Reading comprehension", code: "RTT-EN-RC", active: true },
    { termId: p2t2, name: "CPA in mathematics", code: "RTT-MA-CPA", active: true },
    { termId: p2t2, name: "Activity-based EVS", code: "RTT-EV-ABE", active: true },
  ]);

  // Mentor pairings (10 — fan out across the 10 teachers)
  const pairingsValues = teachersInsert.map((t, i) => ({
    mentorId: i % 2 === 0 ? mentorsInsert[0].id : mentorsInsert[1].id,
    teacherId: t.id,
    status: i < 7 ? ("active" as const) : i < 9 ? ("review" as const) : ("complete" as const),
    currentQuarter: ((i % 4) + 1),
    meetingsCount: 3 + (i % 5),
    lastMeetingAt: new Date(Date.now() - i * 86400000 * 7),
    conceptNote: i === 0 ? "Focus on phonics and reading aloud routines." : null,
  }));
  // The insert must still run; only the unused binding is dropped. The
  // .returning() clause is kept so the statement shape (and its cost) is
  // unchanged if a caller later needs the ids back.
  await db
    .insert(schema.mentorPairings)
    .values(pairingsValues)
    .returning({ id: schema.mentorPairings.id, teacherId: schema.mentorPairings.teacherId });

  // Observation cycles (8 baseline+developmental+evaluative mix)
  const cycleKinds = ["baseline", "developmental", "evaluative"] as const;
  const cycleStatuses = ["nominated", "pre_submitted", "observed", "post_submitted", "complete"] as const;
  const cyclesValues = teachersInsert.slice(0, 8).map((t, i) => ({
    code: `OBS-2026-${String(i + 1).padStart(3, "0")}`,
    teacherId: t.id,
    kind: cycleKinds[i % 3],
    status: cycleStatuses[i % 5],
    subjectId: i % 2 === 0 ? subjectByCode["ENG"] : subjectByCode["MAT"],
    topic: i % 2 === 0 ? "Reading comprehension — Grade 5" : "Fractions — CPA Grade 4",
    videoMin: 30 + (i * 3),
    scheduledAt: new Date(Date.now() - (8 - i) * 86400000),
  }));
  await db.insert(schema.observationCycles).values(cyclesValues);

  console.log("[seed] DONE: 2 districts, 11 zones, 10 schools, 10 teachers, 2 mentors, 10 pairings, 8 cycles, 9 curriculum subjects, 3 phases, 5 terms, 3 RTT subjects.");
  await pool.end();
}

// ── Section gate bootstrap ────────────────────────────────────────────────────
// The section_gates table was seeded by NOTHING. It was empty on every
// deployment, so there was no password to enter for /observation or
// /mentorship -- and because the gate decision was a forgeable `gml-gate-<slug>`
// cookie compared to the string "1", nobody noticed: you got in without one.
// Now that the decision reads section_gate_grants server-side (see
// apps/web/src/lib/gates.ts assertSectionGate), a gate with no row is a section
// nobody can reach. So it has to be seeded.
//
// Password source, in order:
//   1. GATE_PASSWORD_<SLUG> from the environment (e.g. GATE_PASSWORD_OBSERVATION)
//   2. a generated 16-char random password, PRINTED ONCE so the operator can
//      distribute it. It is not recoverable afterwards -- only the bcrypt hash
//      is stored -- which is the same contract as the super_admin bootstrap.
//
// Idempotent: a slug that already has a row is left alone, so re-running seed
// never rotates a live password out from under its users. Rotation is an
// explicit admin action (/admin/gates), not a side effect of deployment.
async function bootstrapSectionGates(db: ReturnType<typeof drizzle>): Promise<void> {
  // 'tkt' and 'ttt' are deliberately NOT seeded: they gate /rtt/tkt and
  // /rtt/ttt, and neither route exists in the app.
  const slugs = ["observation", "mentorship", "admin"] as const;

  for (const slug of slugs) {
    const existing = await db
      .select({ id: schema.sectionGates.id })
      .from(schema.sectionGates)
      .where(eq(schema.sectionGates.slug, slug))
      .limit(1);

    if (existing.length > 0) {
      console.log(`[seed] exists — skipping section gate '${slug}'`);
      continue;
    }

    const envKey = `GATE_PASSWORD_${slug.toUpperCase()}`;
    const fromEnv = process.env[envKey];
    const password = fromEnv ?? randomBytes(12).toString("base64url").slice(0, 16);

    await db.insert(schema.sectionGates).values({
      slug,
      passwordHash: await bcrypt.hash(password, 10),
      version: 1,
    });

    if (fromEnv) {
      console.log(`[seed] ✓ section gate '${slug}' created from ${envKey}`);
    } else {
      console.log(
        `[seed] ✓ section gate '${slug}' created — GENERATED PASSWORD: ${password}`,
      );
      console.log(
        `[seed]   ^ store this now; only the hash is kept. Set ${envKey} to choose your own.`,
      );
    }
  }
}

// ── Spec 103 — Super admin bootstrap ──────────────────────────────────────────
// Idempotent: env-gated + onConflictDoNothing on the unique email constraint.
// - Skips silently when SUPER_ADMIN_EMAIL or SUPER_ADMIN_INITIAL_PASSWORD is not set
//   (e.g. CI test runs, ephemeral dev DBs).
// - Skips silently when a user with that email already exists, regardless of role.
// - On success, prints "✓ super_admin user created: <email>" so the operator can
//   correlate the deployment log line with the SQL row they'll see in audit_log.
async function bootstrapSuperAdmin(db: ReturnType<typeof drizzle>): Promise<void> {
  const email = process.env.SUPER_ADMIN_EMAIL;
  const password = process.env.SUPER_ADMIN_INITIAL_PASSWORD;

  if (!email || !password) {
    console.log("[seed] super_admin bootstrap skipped — SUPER_ADMIN_EMAIL not set");
    return;
  }

  // Existence check (SELECT-then-INSERT) — a friendlier log line than catching
  // onConflict silently, and lets us short-circuit the bcrypt cost when not needed.
  const existing = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);

  if (existing.length > 0) {
    console.log(`[seed] exists — skipping super_admin bootstrap for ${email}`);
    return;
  }

  // Spec 167 — cost 10 mirrors `BCRYPT_COST` in
  // apps/web/src/lib/password.ts (single source of truth for the bcrypt cost
  // across the LMS). seed.ts can't import from apps/web (the seed runs from
  // packages/db and reaches across the workspace boundary would be a
  // dependency-direction inversion), so the value is duplicated here with
  // this paired comment as the contract. The spec-167 governance test pins
  // both literals — a future cost bump that misses one side fails the test.
  const passwordHash = await bcrypt.hash(password, 10);

  await db
    .insert(schema.users)
    .values({
      email,
      passwordHash,
      role: "super_admin",
      defaultLocale: "en",
      name: "Super Admin",
      active: true,
    })
    .onConflictDoNothing({ target: schema.users.email });

  console.log(`[seed] ✓ super_admin user created: ${email}`);
}

// Spec 143 — bootstrapSystemSettings() was removed here. The single source of truth
// for the well-known singleton row is now migration 0015_system_settings.sql, whose
// `INSERT … ON CONFLICT DO NOTHING` runs once during `pnpm db:migrate` and is
// idempotent on re-runs. If a dev truncates the table they re-run migrate, not seed.

// Auto-run only when invoked directly (e.g. `tsx seed.ts`), not when imported
// by the seed_all.ts orchestrator (spec 104).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error("[seed] failed:", err);
    process.exit(1);
  });
}
