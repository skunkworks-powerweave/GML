// A small mentorship programme, COMMITTED to the database, for tests that
// execute the real pages, route handlers and server actions of /forms,
// /mentorship, /inbox and /api/form-drafts.
//
// Those entry points use the app's own pooled `db` (packages/db/src/client.ts),
// not a client a test can wrap in a transaction, so the rows they read have to
// be committed. Every row carries a unique tag and cleanup() deletes exactly
// what build() created, in foreign-key order. audit_log rows the code under
// test writes are left behind: that table is append-only by trigger.
//
// Import this BEFORE any application module: it pulls in ./_ui.ts, which
// installs the @/ alias and the framework stubs (auth, next/headers,
// next/cache, server-only) those modules need.

import "./_ui.js";
import { createRequire } from "node:module";
import { Client } from "pg";
import { DATABASE_URL, tag } from "./_harness.js";

export type Person = { id: string; role: string; name: string };

export type FormRow = { id: string; slug: string; kind: string; audience: string; version: string };

export type World = {
  T: string;
  admin: Person;
  mentor: Person;
  teacherA: Person;
  teacherB: Person;
  mentorId: string;
  teacherAId: string;
  teacherBId: string;
  /** mentor <-> teacher A, and mentor <-> teacher B: one mentor, two mentees. */
  pairingA: string;
  pairingB: string;
  q: <R = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<R[]>;
  form: (
    kind: string,
    audience: "mentor" | "mentee",
    schema: unknown,
    opts?: { version?: string; active?: boolean },
  ) => Promise<FormRow>;
  grant: (userId: string, slug?: string) => Promise<void>;
  cleanup: () => Promise<void>;
};

export async function buildWorld(prefix: string): Promise<World> {
  const c = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5000 });
  await c.connect();
  const T = tag(prefix);
  const q = async <R,>(text: string, params: unknown[] = []) => (await c.query(text, params)).rows as R[];
  const one = async (text: string, params: unknown[]) => (await q<{ id: string }>(text, params))[0]!.id;

  const users: string[] = [];
  const forms: string[] = [];

  const district = await one(`INSERT INTO districts (name, code) VALUES ($1, $2) RETURNING id`, [`District ${T}`, T.slice(-12)]);
  const zone = await one(`INSERT INTO zones (district_id, name) VALUES ($1, $2) RETURNING id`, [district, `Zone ${T}`]);
  const school = await one(`INSERT INTO schools (zone_id, name, code) VALUES ($1, $2, $3) RETURNING id`, [zone, `School ${T}`, T.slice(-12)]);

  const person = async (label: string, role: string): Promise<Person> => {
    const name = `${label} ${T}`;
    const id = await one(
      `INSERT INTO users (id, email, name, role) VALUES (gen_random_uuid(), $1, $2, $3::role) RETURNING id`,
      [`${label.toLowerCase().replace(/\s+/g, "-")}.${T}@example.test`, name, role],
    );
    users.push(id);
    return { id, role, name };
  };
  const admin = await person("Admin", "programme_admin");
  const mentor = await person("Mentor", "mentor");
  const teacherA = await person("Teacher A", "teacher");
  const teacherB = await person("Teacher B", "teacher");

  const teacherRow = (u: Person, phone: string) =>
    one(`INSERT INTO teachers (user_id, school_id, full_name, phone) VALUES ($1, $2, $3, $4) RETURNING id`, [u.id, school, u.name, phone]);
  const teacherAId = await teacherRow(teacherA, "+91 9000000001");
  const teacherBId = await teacherRow(teacherB, "+91 9000000002");
  const mentorId = await one(
    `INSERT INTO mentors (user_id, name, base_location) VALUES ($1, $2, 'Leh') RETURNING id`,
    [mentor.id, mentor.name],
  );
  await q(`UPDATE users SET phone = $2 WHERE id = $1`, [mentor.id, "+91 9000000009"]).catch(() => undefined);
  const pairing = (teacherId: string) =>
    one(
      `INSERT INTO mentor_pairings (mentor_id, teacher_id, status, current_quarter) VALUES ($1, $2, 'active', 1) RETURNING id`,
      [mentorId, teacherId],
    );
  const pairingA = await pairing(teacherAId);
  const pairingB = await pairing(teacherBId);

  const form: World["form"] = async (kind, audience, schema, opts = {}) => {
    const version = opts.version ?? `${T}-${forms.length + 1}`;
    const id = await one(
      `INSERT INTO feedback_forms (kind, audience, schema, version, active) VALUES ($1::feedback_kind, $2::feedback_audience, $3::jsonb, $4, $5) RETURNING id`,
      [kind, audience, JSON.stringify(schema), version, opts.active ?? true],
    );
    forms.push(id);
    return { id, slug: `${kind}-${audience}-${version}`, kind, audience, version };
  };

  const grant: World["grant"] = async (userId, slug = "mentorship") => {
    await q(
      `INSERT INTO section_gate_grants (user_id, gate_slug, granted_at, expires_at)
       VALUES ($1, $2::section_gate_slug, now(), now() + interval '8 hours')`,
      [userId, slug],
    );
  };

  const cleanup = async () => {
    const steps: Array<[string, unknown[]]> = [
      [`DELETE FROM notifications WHERE user_id = ANY($1::uuid[])`, [users]],
      [`DELETE FROM form_drafts WHERE user_id = ANY($1::uuid[])`, [users]],
      [`DELETE FROM feedback_responses WHERE form_id = ANY($1::uuid[]) OR respondent_user_id = ANY($2::uuid[])
          OR pairing_id IN (SELECT id FROM mentor_pairings WHERE mentor_id = $3)`, [forms, users, mentorId]],
      [`DELETE FROM feedback_forms WHERE id = ANY($1::uuid[])`, [forms]],
      [`DELETE FROM section_gate_grants WHERE user_id = ANY($1::uuid[])`, [users]],
      [`DELETE FROM mentor_meetings WHERE pairing_id IN (SELECT id FROM mentor_pairings WHERE mentor_id = $1)`, [mentorId]],
      [`DELETE FROM mentor_pairings WHERE mentor_id = $1`, [mentorId]],
      [`DELETE FROM mentors WHERE id = $1`, [mentorId]],
      [`DELETE FROM teachers WHERE id = ANY($1::uuid[])`, [[teacherAId, teacherBId]]],
      [`DELETE FROM schools WHERE id = $1`, [school]],
      [`DELETE FROM zones WHERE id = $1`, [zone]],
      [`DELETE FROM districts WHERE id = $1`, [district]],
      [`DELETE FROM users WHERE id = ANY($1::uuid[])`, [users]],
    ];
    try {
      for (const [text, params] of steps) await c.query(text, params);
    } finally {
      await c.end().catch(() => undefined);
    }
  };

  return { T, admin, mentor, teacherA, teacherB, mentorId, teacherAId, teacherBId, pairingA, pairingB, q, form, grant, cleanup };
}

/** Run the code under test as this person (null = signed out). */
export function signIn(p: Person | null): void {
  (globalThis as Record<string, unknown>).__gmlTestSession = p
    ? { user: { id: p.id, role: p.role, email: null, name: p.name, image: null } }
    : null;
}

export type Outcome =
  | { kind: "value"; value: unknown }
  | { kind: "redirect"; to: string }
  | { kind: "notFound" }
  | { kind: "error"; error: unknown };

/**
 * What a page or server action did: returned, redirected, or 404'd.
 *
 * redirect() and notFound() THROW in Next; the digest says which. Anything
 * else (a Postgres 22P02, say) is reported as an error rather than rethrown,
 * so a test can assert it did NOT happen with a readable message.
 */
export async function outcome(fn: () => unknown): Promise<Outcome> {
  try {
    return { kind: "value", value: await fn() };
  } catch (err) {
    const digest = (err as { digest?: unknown })?.digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT;")) {
      return { kind: "redirect", to: digest.split(";")[2]! };
    }
    if (typeof digest === "string" && digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;404")) {
      return { kind: "notFound" };
    }
    return { kind: "error", error: err };
  }
}

/** A readable one-liner for an assertion message. */
export function describe(r: Outcome): string {
  if (r.kind === "redirect") return `redirect -> ${r.to}`;
  if (r.kind === "error") return `threw ${String((r.error as Error)?.stack ?? r.error)}`;
  return r.kind;
}

/** Build the FormData a server-action <form> would post. */
export function formData(fields: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    for (const one of Array.isArray(v) ? v : [v]) fd.append(k, one);
  }
  return fd;
}

/**
 * End the app's own pool once a file is done, or node keeps the process alive
 * for the pool's 30 s idle timeout. Waits a beat for fire-and-forget audit
 * writes (`void recordAudit(...)`) to land first.
 */
export async function closeAppPool(): Promise<void> {
  await new Promise((r) => setTimeout(r, 200));
  // Through require from apps/web, as the app's own modules load it: tsx loads
  // apps/web as CommonJS, and an ESM import() here would be a second module
  // instance holding a second (unused) pool.
  const { getPool } = createRequire(new URL("../../apps/web/package.json", import.meta.url))("@gml/db") as {
    getPool: () => { end: () => Promise<void> };
  };
  await getPool().end().catch(() => undefined);
}
