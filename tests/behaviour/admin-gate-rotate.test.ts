// Concurrent password rotations each get their own version, and the password
// shown for the newest one is the one that works.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// The rotate route computed nextVersion = max(version) + 1 OUTSIDE its
// transaction, and section_gates had no unique (slug, version). Two
// rotations of the same slug at once (two super admins, or two tabs) both
// inserted version N; getCurrentGate() orders by version DESC LIMIT 1, which
// is arbitrary between equal versions, so one of the two "shown once"
// passwords was dead -- and if that admin distributed it, the section was
// locked for everyone until someone rotated again.
//
// Executed: the real route handler, four times concurrently, as a super_admin,
// on the unused `tkt` slug, against Postgres; then the real getCurrentGate().

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import "./_ui.js";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { actAs, fixture } from "./_admin-fixture.js";

const skip = needsDatabase();
const bcrypt = createRequire(new URL("../../apps/web/package.json", import.meta.url))("bcryptjs") as {
  compare: (a: string, b: string) => Promise<boolean>;
};

test("four simultaneous rotations produce four versions, and the newest password works", { skip, timeout: 120_000 }, async () => {
  const { POST } = await import("../../apps/web/src/app/api/admin/gates/[slug]/rotate/route.ts");
  const { getCurrentGate } = await import("../../apps/web/src/lib/gates.ts");
  await withClient(async (c) => {
    const t = tag("rotate");
    const f = fixture(c, t);
    try {
      const admin = await f.user("super_admin", "sadmin");
      f.defer(`DELETE FROM section_gates WHERE rotated_by_user_id = $1`, [admin]);
      actAs(admin, "super_admin");
      const call = () =>
        POST(new Request("http://x/api/admin/gates/tkt/rotate", { method: "POST" }), {
          params: Promise.resolve({ slug: "tkt" }),
        }).then((r) => r.json() as Promise<{ ok?: boolean; plaintext?: string; version?: number }>);
      const results = await Promise.all([call(), call(), call(), call()]);
      const versions = results.map((r) => r.version);
      assert.equal(new Set(versions).size, 4, `duplicate versions: ${versions.join(",")}`);

      const newest = results.reduce((a, b) => ((a.version ?? 0) > (b.version ?? 0) ? a : b));
      const current = await getCurrentGate("tkt");
      assert.equal(current?.version, newest.version);
      assert.equal(await bcrypt.compare(newest.plaintext!, current!.passwordHash), true, "the newest shown password must open the gate");
    } finally {
      await f.cleanup();
    }
  });
});

test("the database refuses two rows with one slug and version", { skip }, async () => {
  await withClient(async (c) => {
    await c.query("BEGIN");
    try {
      await c.query(`INSERT INTO section_gates (slug, password_hash, version) VALUES ('ttt', 'x', 99001)`);
      await assert.rejects(
        c.query(`INSERT INTO section_gates (slug, password_hash, version) VALUES ('ttt', 'y', 99001)`),
        /duplicate key|unique/i,
      );
    } finally {
      await c.query("ROLLBACK");
    }
  });
});
