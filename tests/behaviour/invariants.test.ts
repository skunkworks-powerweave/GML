// Substrate moats and pure logic, executed.
//
// SM-1 (audit_log is append-only) has been claimed in 68 source comments and
// asserted by grepping for the word REVOKE. This file issues an UPDATE and a
// DELETE against a real table and requires the database to refuse them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hasRole, hasAnyRole, isRoleName, ROLES } from "@gml/shared/auth/roles";
import {
  extractSegments,
  rewritePlaylist,
  segmentTtlSeconds,
} from "@gml/shared/storage/playlist";
import { uploadKey, ownerFromUploadKey, isBucketName } from "@gml/shared/storage/buckets";
import { needsDatabase, withClient, withRlsProbeLock, tag } from "./_harness.js";

const skip = needsDatabase();

// ── SM-1: audit_log is append-only, AT THE DATABASE ──────────────────────────

test("SM-1: an audit row cannot be updated", { skip }, async () => {
  await withClient(async (c) => {
    const action = tag("sm1-update");
    const { rows } = await c.query(
      `INSERT INTO audit_log (action, entity_type) VALUES ($1, 'test') RETURNING id`,
      [action],
    );
    const id = rows[0].id;
    try {
      await assert.rejects(
        () => c.query(`UPDATE audit_log SET action = 'tampered' WHERE id = $1`, [id]),
        /append-only|SM-1|permission denied/i,
        "the database must refuse an UPDATE — a forensic log that can be edited is not one",
      );
    } finally {
      // The DELETE below is itself blocked, which is the next test. Leave the
      // row: a handful of test rows in an append-only table is the correct
      // outcome, and deleting them would require defeating the control.
    }
  });
});

test("SM-1: an audit row cannot be deleted", { skip }, async () => {
  await withClient(async (c) => {
    const action = tag("sm1-delete");
    const { rows } = await c.query(
      `INSERT INTO audit_log (action, entity_type) VALUES ($1, 'test') RETURNING id`,
      [action],
    );
    await assert.rejects(
      () => c.query(`DELETE FROM audit_log WHERE id = $1`, [rows[0].id]),
      /append-only|SM-1|permission denied/i,
      "an append-only log that can be emptied hands you a way to erase your own tracks",
    );
  });
});

test("SM-1: the audit log cannot be emptied with TRUNCATE, even by the app's own role", { skip }, async () => {
  // The app, the worker and migrate all connect as the role that OWNS
  // audit_log (on Supabase, `postgres`; here, whoever DATABASE_URL names), and
  // _post/001 only revoked TRUNCATE from PUBLIC and other roles -- never from
  // the owner. The row triggers above do not fire on TRUNCATE, so one
  // `TRUNCATE audit_log` erased the whole trail. Run in a transaction that is
  // always rolled back, so a failure here cannot empty the log it tests.
  await withClient(async (c) => {
    const { rows } = await c.query(
      `SELECT pg_get_userbyid(relowner) = current_user AS owner FROM pg_class WHERE oid = 'audit_log'::regclass`,
    );
    assert.equal(rows[0].owner, true, "precondition: this connects as the table owner, as the app does");
    await c.query("BEGIN");
    try {
      await c.query(`INSERT INTO audit_log (action, entity_type) VALUES ($1, 'test')`, [tag("sm1-truncate")]);
      await assert.rejects(
        () => c.query("TRUNCATE audit_log"),
        /append-only|SM-1/i,
        "the database must refuse a TRUNCATE -- one statement from an app bug or a stray psql " +
          "session would otherwise erase the entire forensic record",
      );
    } finally {
      await c.query("ROLLBACK");
    }
  });
});

test("SM-1: docs/substrate-moats.md names every trigger that defends audit_log, and what the owner can still do", { skip }, async () => {
  // The moat doc is the inventory a reviewer reads for SM-1's controls. When
  // _post/007 added the TRUNCATE trigger it was updated nowhere but README-IT,
  // so the doc still listed only the UPDATE and DELETE row triggers, implied
  // the owner's TRUNCATE was covered by the REVOKEs (it never was), and said
  // nothing of the owner's DISABLE TRIGGER (W3-80). Read from the catalogue,
  // so a trigger added later has to be written down too.
  await withClient(async (c) => {
    const { rows } = await c.query(`
      SELECT t.tgname,
             array_remove(ARRAY[
               CASE WHEN t.tgtype & 4  > 0 THEN 'INSERT' END,
               CASE WHEN t.tgtype & 8  > 0 THEN 'DELETE' END,
               CASE WHEN t.tgtype & 16 > 0 THEN 'UPDATE' END,
               CASE WHEN t.tgtype & 32 > 0 THEN 'TRUNCATE' END], NULL) AS events,
             pg_get_userbyid(k.relowner) = current_user AS owner
        FROM pg_trigger t JOIN pg_class k ON k.oid = t.tgrelid
       WHERE t.tgrelid = 'audit_log'::regclass AND NOT t.tgisinternal
       ORDER BY t.tgname`);
    assert.ok(rows.length >= 3, "precondition: audit_log carries its append-only triggers");
    const doc = readFileSync(new URL("../../docs/substrate-moats.md", import.meta.url), "utf8");
    const start = doc.indexOf("## SM-1");
    assert.ok(start >= 0, "docs/substrate-moats.md has an SM-1 section");
    const sm1 = doc.slice(start, doc.indexOf("\n## ", start + 1));
    for (const r of rows as Array<{ tgname: string; events: string[] }>) {
      assert.ok(sm1.includes(r.tgname), `SM-1 in docs/substrate-moats.md does not name the trigger ${r.tgname}`);
      for (const e of r.events) {
        assert.match(sm1, new RegExp(`BEFORE ${e}\\b`), `SM-1 does not say ${r.tgname} refuses ${e}`);
      }
    }
    // The app connects as the owner here as in production, and an owner can
    // switch the triggers off. Until it runs as a role that does not own the
    // table, the doc must not present the triggers as the last word.
    if (rows[0].owner) {
      assert.match(sm1, /DISABLE TRIGGER/, "SM-1 must say the table owner, which the app connects as, can still DISABLE TRIGGER");
    }
  });
});

test("SM-1: deleting a user does NOT destroy their audit trail", { skip }, async () => {
  await withClient(async (c) => {
    // The FK on audit_log.user_id was ON DELETE SET NULL, implemented as an
    // UPDATE — which the append-only trigger rejects. So any user who had ever
    // done anything became permanently undeletable, and the error talked about
    // an append-only table, which is not an obvious place to go looking.
    const { rows } = await c.query(`
      SELECT count(*)::int AS n FROM pg_constraint
       WHERE conrelid = 'audit_log'::regclass AND contype = 'f'
         AND confrelid = 'users'::regclass
    `);
    assert.equal(
      rows[0].n,
      0,
      "audit_log must carry NO foreign key to users. Every referential action is " +
        "wrong here: SET NULL mutates an immutable table AND destroys attribution, " +
        "CASCADE lets deleting a user empty the log, RESTRICT makes every acting " +
        "user undeletable forever.",
    );
  });
});

// ── The Data API stays shut ──────────────────────────────────────────────────

test("every public table has row-level security enabled", { skip }, async () => {
  // Shared: not while another file has a probe table without RLS in place.
  await withRlsProbeLock("shared", () => withClient(async (c) => {
    const { rows } = await c.query(`
      SELECT c.relname FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
       ORDER BY c.relname
    `);
    assert.deepEqual(
      rows.map((r) => r.relname),
      [],
      "a table without RLS is readable through PostgREST by anyone holding the " +
        "anon key, which ships in every browser bundle",
    );
  }));
});

// ── Role checks: exact membership, not rank ──────────────────────────────────

test("a role list is an allow-list, not a minimum-rank floor", () => {
  // This is the defect that made `requireRole(["teacher", ...])` admit every
  // authenticated user, and let an observer call signOffCycleAction -- the
  // terminal, locking transition on a cycle they were the observer for.
  assert.equal(hasRole("super_admin", "teacher"), false, "super_admin does not imply teacher");
  assert.equal(hasRole("mentor", "observer"), false, "mentor does not imply observer");
  assert.equal(hasRole("observer", "mentor"), false, "observer does not imply mentor");
  assert.equal(hasRole("teacher", "teacher"), true);

  assert.equal(
    hasAnyRole("super_admin", ["teacher"]),
    false,
    "a list containing 'teacher' must NOT admit everyone",
  );
  assert.equal(hasAnyRole("mentor", ["mentor", "programme_admin"]), true);
  assert.equal(hasAnyRole(undefined, ["teacher"]), false, "no role must never match");
});

test("isRoleName rejects anything not in the enum", () => {
  for (const r of ROLES) assert.equal(isRoleName(r), true);
  for (const bad of ["admin", "Teacher", "", null, undefined, 7, {}]) {
    assert.equal(isRoleName(bad), false, `${JSON.stringify(bad)} must not be a role`);
  }
});

// ── Playlist rewriting: the reason no video ever played ──────────────────────

test("bare segment names are rewritten to absolute URLs", () => {
  const playlist = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-TARGETDURATION:6",
    "#EXTINF:6.000000,",
    "seg_00000.ts",
    "#EXTINF:6.000000,",
    "seg_00001.ts",
    "#EXT-X-ENDLIST",
    "",
  ].join("\n");

  const segs = extractSegments(playlist);
  assert.deepEqual(
    segs.map((s) => s.name),
    ["seg_00000.ts", "seg_00001.ts"],
    "tag lines and blanks must not be mistaken for segments",
  );

  const out = rewritePlaylist(playlist, (n) => `https://cdn.example/${n}?token=abc`);
  assert.ok(out.includes("https://cdn.example/seg_00000.ts?token=abc"));
  assert.ok(
    !/^seg_00000\.ts$/m.test(out),
    "a bare name left in the playlist resolves against /api/media/ and 403s — " +
      "this is why no video in this product ever played",
  );
  assert.ok(out.includes("#EXT-X-ENDLIST"), "tags must survive untouched");
});

test("an already-absolute segment URL is left alone", () => {
  const playlist = "#EXTM3U\n#EXTINF:6,\nhttps://cdn.example/already?sig=1\n";
  let called = 0;
  const out = rewritePlaylist(playlist, () => {
    called += 1;
    return "https://cdn.example/WRONG";
  });
  assert.equal(called, 0, "signing an already-signed URL would corrupt it");
  assert.ok(out.includes("https://cdn.example/already?sig=1"));
});

test("a segment the signer could not sign leaves a gap, not a dead player", () => {
  const playlist = "#EXTM3U\n#EXTINF:6,\na.ts\n#EXTINF:6,\nb.ts\n";
  const out = rewritePlaylist(playlist, (n) => (n === "a.ts" ? "https://x/a" : null));
  assert.ok(out.includes("https://x/a"));
  assert.ok(/^b\.ts$/m.test(out), "the unsignable line is left as-is: one bad segment, not a dead video");
});

test("segment TTL scales with duration and stays bounded", () => {
  // A fixed TTL forces a choice between "a viewer who pauses returns to a dead
  // player" and "a URL copied out of devtools works for hours".
  assert.equal(segmentTtlSeconds(null), 1800, "unknown duration gets the 30-minute floor");
  assert.equal(segmentTtlSeconds(0), 1800);
  assert.equal(segmentTtlSeconds(30), 1800, "a short clip still gets the floor");
  assert.equal(segmentTtlSeconds(1200), 4500, "20 minutes -> duration*3 + 900");
  assert.equal(segmentTtlSeconds(100000), 21600, "capped at 6 hours");
  assert.ok(segmentTtlSeconds(-5) >= 1800, "a nonsense duration must not produce a tiny TTL");
});

// ── Upload keys are bound to their owner ─────────────────────────────────────

test("an upload key is prefixed with the uploader's uuid", () => {
  const uid = "11111111-2222-3333-4444-555555555555";
  const key = uploadKey(uid, "abc", "MP4");
  assert.ok(key.startsWith(`${uid}/`), "the RLS policy checks foldername[1] = auth.uid()");
  assert.equal(ownerFromUploadKey(key), uid);
  assert.ok(key.endsWith(".mp4"), "the extension is normalised");
});

test("a non-uuid prefix is not treated as an owner", () => {
  assert.equal(ownerFromUploadKey("whatsapp/abc.mp4"), null);
  assert.equal(ownerFromUploadKey("abc.mp4"), null);
  assert.equal(
    ownerFromUploadKey("../../etc/passwd"),
    null,
    "a traversal-shaped key must not resolve to an owner",
  );
});

test("bucket names are validated against the shared list", () => {
  assert.equal(isBucketName("videos-hls"), true);
  assert.equal(isBucketName("gml-media"), false, "the bucket tusd wrote to and nothing created");
  assert.equal(isBucketName("gml-resources"), false, "the bucket the PDF viewer read and nothing created");
});
