// A staff account's WhatsApp number can be set, so "Share via WhatsApp" for a
// rotated gate password can ever offer anyone.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────
//
// /admin/gates offers the new password to users with phone IS NOT NULL, and
// nothing -- no screen, action, import or entity -- wrote users.phone (the
// WhatsApp webhook's own comment says it "cannot be populated through the
// product at all"). So the page always said "No staff with a phone number on
// file" and the share endpoint was unreachable in practice.
//
// Executed: the real /admin/users server action, as a super_admin, against
// Postgres. (No Supabase call is involved in setting a phone.)

import { test } from "node:test";
import assert from "node:assert/strict";
import "./_ui.js";
import { needsDatabase, withClient, tag } from "./_harness.js";
import { actAs, fixture, form } from "./_admin-fixture.js";

const skip = needsDatabase();
const actions = () => import("../../apps/web/src/app/(authenticated)/admin/users/actions.ts");

test("an administrator can record a staff member's WhatsApp number, normalised", { skip }, async () => {
  const { setPhoneAction } = await actions();
  await withClient(async (c) => {
    const t = tag("user-phone");
    const f = fixture(c, t);
    try {
      const observer = await f.user("observer", "observer");
      actAs(await f.user("super_admin", "sadmin"), "super_admin");

      const ok = await setPhoneAction(undefined, form({ userId: observer, phone: "98765 43210" }));
      assert.ok(ok.ok, JSON.stringify(ok));
      const { rows: [u] } = await c.query(`SELECT phone FROM users WHERE id = $1`, [observer]);
      assert.equal(u.phone, "+919876543210", "a 10-digit Indian mobile is stored in E.164");

      const bad = await setPhoneAction(undefined, form({ userId: observer, phone: "call me" }));
      assert.ok(bad.error, "a value that is not a phone number is refused");

      const cleared = await setPhoneAction(undefined, form({ userId: observer, phone: "" }));
      assert.ok(cleared.ok);
      const { rows: [v] } = await c.query(`SELECT phone FROM users WHERE id = $1`, [observer]);
      assert.equal(v.phone, null, "an emptied box clears the number");
    } finally {
      await f.cleanup();
    }
  });
});

test("a programme_admin cannot change an administrator's number", { skip }, async () => {
  const { setPhoneAction } = await actions();
  await withClient(async (c) => {
    const t = tag("user-phone-perm");
    const f = fixture(c, t);
    try {
      const sadmin = await f.user("super_admin", "sadmin");
      actAs(await f.user("programme_admin", "padmin"), "programme_admin");
      const r = await setPhoneAction(undefined, form({ userId: sadmin, phone: "+44 7700 900123" }));
      assert.ok(r.error);
      const { rows: [u] } = await c.query(`SELECT phone FROM users WHERE id = $1`, [sadmin]);
      assert.equal(u.phone, null);
    } finally {
      await f.cleanup();
    }
  });
});
