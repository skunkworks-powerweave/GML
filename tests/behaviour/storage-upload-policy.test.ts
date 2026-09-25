// The Storage INSERT policy admits only an object the server reserved.
//
// ── THE DEFECT (F109) ────────────────────────────────────────────────────────
//
// The only INSERT policy on storage.objects checked the bucket and that the
// key began with the caller's own uuid. Nothing tied the object to a
// reservation -- the `files` row beginUpload writes with status 'uploading'.
// So any signed-in teacher, mentor or observer token could POST as many
// objects as it liked under its own prefix, any name, each up to the bucket's
// 2 GiB cap, ignoring the programme's videoMaxUploadMb (500 MB by default) and
// the files registry. Nothing reconciles an object with no files row, and
// backup.sh copies every one of them into the DR bucket and never deletes it.
// Verified against the local stack: a teacher token POSTing an unreserved key
// under its own prefix got 200.
//
// ── HOW STORAGE CHECKS AN UPLOAD, AND SO HOW THIS TEST DOES ─────────────────
//
// storage-api (v1.72, read from the supabase_storage container) authorises
// every upload request -- the TUS create and each PATCH, and a plain POST --
// with Uploader.canUpload(): inside a transaction that it always rolls back,
// it sets `role` = authenticated and `request.jwt.claim.sub` /
// `request.jwt.claims` from the caller's token, then runs
//     INSERT INTO storage.objects (name, owner, owner_id, bucket_id, metadata, version, ...)
// with metadata = {mimetype, contentLength}, contentLength being the TUS
// Upload-Length (or the request's Content-Length). The row it finally keeps is
// written later as the superuser. So the INSERT policy is evaluated exactly
// once per request, as `authenticated`, against that row -- which is what this
// test does, with the real _post SQL, inside a transaction that is rolled back.
//
// A plain Postgres (CI) has no storage or auth schema, so the test builds the
// few pieces of them the policy touches, copied from the local Supabase stack:
// storage.buckets / storage.objects (RLS on, the grants Supabase gives
// `authenticated`), storage.foldername() and auth.uid(). On a Supabase
// database the real ones are used.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { needsDatabase, withClient } from "./_harness.js";

const POST_DIR = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "packages/db/src/migrations/_post");

/** Every ledgered _post file that shapes storage.objects' policies, in the order migrate.ts applies them. */
const storagePolicySql = () =>
  readdirSync(POST_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(POST_DIR, f), "utf8"))
    .filter((sql) => /ON storage\.objects/.test(sql));

/**
 * The parts of Supabase's storage and auth schemas the upload policy uses,
 * each created only if it is missing. Other suites commit a bare `auth` schema
 * of their own (tests/behaviour/_fake_gotrue.ts, for auth.sessions) and may do
 * so while this runs, so the schemas are created under a savepoint that
 * tolerates losing that race.
 */
const STAND_IN_SCHEMAS = ["CREATE SCHEMA IF NOT EXISTS storage", "CREATE SCHEMA IF NOT EXISTS auth"];
const STAND_IN = `
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    IF to_regprocedure('auth.uid()') IS NULL THEN
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$
        SELECT coalesce(
          nullif(current_setting('request.jwt.claim.sub', true), ''),
          (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
        )::uuid
      $f$;
    END IF;
  END $$;
  CREATE TABLE IF NOT EXISTS storage.buckets (
    id text PRIMARY KEY, name text NOT NULL UNIQUE, owner uuid, public boolean DEFAULT false,
    file_size_limit bigint, allowed_mime_types text[], created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
  );
  CREATE TABLE storage.objects (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bucket_id text REFERENCES storage.buckets(id), name text, owner uuid, owner_id text,
    metadata jsonb, user_metadata jsonb, version text,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
    UNIQUE (bucket_id, name)
  );
  ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
  CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE plpgsql IMMUTABLE AS $f$
  DECLARE _parts text[];
  BEGIN
    SELECT string_to_array(name, '/') INTO _parts;
    RETURN _parts[1 : array_length(_parts, 1) - 1];
  END $f$;
  GRANT USAGE ON SCHEMA storage, auth TO anon, authenticated;
  GRANT ALL ON storage.objects TO anon, authenticated;
`;

const MB = 1024 * 1024;

/**
 * Storage's permission check for one upload, as `uid`: the INSERT canUpload()
 * runs, under a savepoint so a refusal does not end the transaction.
 * Resolves to "admitted", or "refused" for an RLS violation.
 */
async function canUpload(
  c: Client,
  uid: string,
  name: string,
  metadata: Record<string, unknown>,
): Promise<"admitted" | "refused"> {
  await c.query("SAVEPOINT upload");
  try {
    await c.query(
      `SELECT set_config('role', 'authenticated', true),
              set_config('request.jwt.claim.role', 'authenticated', true),
              set_config('request.jwt.claim.sub', $1, true),
              set_config('request.jwt.claims', $2, true)`,
      [uid, JSON.stringify({ sub: uid, role: "authenticated" })],
    );
    await c.query(
      `INSERT INTO storage.objects (bucket_id, name, owner, owner_id, metadata, version)
       VALUES ('videos-original', $1, $2::uuid, $2::text, $3, $4)`,
      [name, uid, JSON.stringify(metadata), randomUUID()],
    );
    await c.query("ROLLBACK TO SAVEPOINT upload");
    return "admitted";
  } catch (err) {
    await c.query("ROLLBACK TO SAVEPOINT upload");
    if ((err as { code?: string }).code === "42501") return "refused";
    throw err;
  }
}

test(
  "Storage admits an upload only to a key its uploader reserved, at no more than the reserved size",
  { skip: needsDatabase() },
  async () => {
    await withClient(async (c) => {
      await c.query("BEGIN");
      try {
        const real = (await c.query(`SELECT to_regclass('storage.objects') IS NOT NULL AS real`)).rows[0].real;
        if (!real) {
          for (const sql of STAND_IN_SCHEMAS) {
            await c.query("SAVEPOINT schema");
            try {
              await c.query(sql);
              await c.query("RELEASE SAVEPOINT schema");
            } catch (err) {
              // Another suite created it between the check and the insert.
              await c.query("ROLLBACK TO SAVEPOINT schema");
              if (!["23505", "42P06"].includes(String((err as { code?: unknown }).code))) throw err;
            }
          }
          await c.query(STAND_IN);
        }
        for (const sql of storagePolicySql()) await c.query(sql);

        const teacher = randomUUID();
        const other = randomUUID();
        for (const [id, label] of [[teacher, "teacher"], [other, "other"]]) {
          await c.query(`INSERT INTO users (id, email, name, role) VALUES ($1, $2, $3, 'teacher')`, [
            id,
            `${label}.${id}@example.test`,
            `${label} ${id}`,
          ]);
        }
        const reserve = async (owner: string, status: string, sizeBytes: number) => {
          const key = `${owner}/${randomUUID()}.mp4`;
          await c.query(
            `INSERT INTO files (bucket, object_key, mime_type, kind, status, size_bytes, owner_user_id)
             VALUES ('videos-original', $1, 'video/mp4', 'video_original', $2, $3, $4)`,
            [key, status, sizeBytes, owner],
          );
          return key;
        };
        const reserved = await reserve(teacher, "uploading", 300 * MB);
        const reconciledAway = await reserve(teacher, "failed", 300 * MB);
        const finished = await reserve(teacher, "stored", 300 * MB);
        const othersReservation = await reserve(other, "uploading", 300 * MB);
        const meta = (bytes: number) => ({ mimetype: "video/mp4", contentLength: bytes });

        // What the product does: tus declares the file's size, which is what
        // beginUpload reserved.
        assert.equal(
          await canUpload(c, teacher, reserved, meta(300 * MB)),
          "admitted",
          "the reserved key, at the reserved size, is the normal direct upload and must be admitted",
        );
        assert.equal(
          await canUpload(c, teacher, reconciledAway, meta(300 * MB)),
          "admitted",
          "a reservation the reconciler marked failed must still take its bytes: completeUpload " +
            "revives exactly that case when a slow upload lands after the abandonment window",
        );

        assert.equal(
          await canUpload(c, teacher, `${teacher}/${randomUUID()}.mp4`, meta(MB)),
          "refused",
          "an object under the caller's own prefix with NO reservation must be refused -- otherwise any " +
            "token can fill the bucket with untracked files that nothing reconciles or deletes",
        );
        assert.equal(
          await canUpload(c, teacher, reserved, meta(2048 * MB)),
          "refused",
          "an upload declaring more bytes than were reserved must be refused -- the reservation is " +
            "where videoMaxUploadMb was enforced, and the bucket cap alone is 2 GiB",
        );
        assert.equal(
          await canUpload(c, teacher, reserved, { mimetype: "video/mp4" }),
          "refused",
          "an upload that declares no size cannot be held to the reservation, so it is refused",
        );
        assert.equal(
          await canUpload(c, teacher, finished, meta(300 * MB)),
          "refused",
          "a reservation whose upload already completed takes no second object",
        );
        assert.equal(
          await canUpload(c, teacher, othersReservation, meta(300 * MB)),
          "refused",
          "another user's reservation is not the caller's to fill",
        );
      } finally {
        await c.query("ROLLBACK");
      }
    });
  },
);
