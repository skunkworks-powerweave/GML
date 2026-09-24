// Opening an inbox item marks it read and goes to what it is about; the
// inbox's counts are counts. Executed through the real /inbox page and the
// real /api/notifications/[id]/open route handler.
//
// ── F21 (inbox) ──────────────────────────────────────────────────────────────
//
// The only control was "Mark all read". Opening an item did not mark it read,
// and an item with no entity link was a plain div that could not be opened or
// marked at all. The "N unread · M total" line was computed over the page's
// LIMIT 50 slice, while the bell counts every row, so the two disagreed as soon
// as there were more than fifty.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { buildWorld, closeAppPool, describe, outcome, signIn, type World } from "./_mentorship.js";
import { render, decodeEntities } from "./_ui.js";
import { needsDatabase } from "./_harness.js";

const skip = needsDatabase();
after(closeAppPool);

async function withWorld(body: (w: World) => Promise<void>) {
  const w = await buildWorld("inbox");
  try {
    await body(w);
  } finally {
    signIn(null);
    await w.cleanup();
  }
}

const note = async (w: World, userId: string, opts: { entityType?: string | null; entityId?: string | null; subject?: string } = {}) =>
  (
    await w.q<{ id: string }>(
      `INSERT INTO notifications (user_id, kind, subject, entity_type, entity_id) VALUES ($1, 'meeting.scheduled', $2, $3, $4) RETURNING id`,
      [userId, opts.subject ?? `Meeting ${w.T}`, opts.entityType ?? null, opts.entityId ?? null],
    )
  )[0]!.id;

async function inboxHtml() {
  const { default: InboxPage } = await import("../../apps/web/src/app/(authenticated)/inbox/page.tsx");
  const r = await outcome(() => InboxPage({ searchParams: Promise.resolve({}) }));
  assert.equal(r.kind, "value", describe(r));
  return decodeEntities(await render((r as { value: unknown }).value));
}

async function open(id: string) {
  const { GET } = await import("../../apps/web/src/app/api/notifications/[id]/open/route.ts");
  return GET(new Request(`http://app.test/api/notifications/${id}/open`), { params: Promise.resolve({ id }) });
}

const readAt = async (w: World, id: string) =>
  (await w.q<{ read_at: Date | null }>(`SELECT read_at FROM notifications WHERE id = $1`, [id]))[0]!.read_at;

test("every inbox item opens through the route that marks it read", { skip }, async () => {
  await withWorld(async (w) => {
    const withEntity = await note(w, w.teacherA.id, { entityType: "mentor_pairing", entityId: w.pairingA });
    const bare = await note(w, w.teacherA.id, { subject: `Help request ${w.T}` });
    signIn(w.teacherA);
    const html = await inboxHtml();
    for (const id of [withEntity, bare]) {
      assert.match(html, new RegExp(`href="/api/notifications/${id}/open"`), `item ${id} must be openable`);
    }
  });
});

test("opening an item marks it read and lands on its pairing", { skip }, async () => {
  await withWorld(async (w) => {
    const id = await note(w, w.teacherA.id, { entityType: "mentor_pairing", entityId: w.pairingA });
    signIn(w.teacherA);
    const res = await open(id);
    assert.equal(res.status, 303);
    assert.ok(new URL(res.headers.get("location")!).pathname === `/mentorship/${w.pairingA}`, res.headers.get("location")!);
    assert.ok(await readAt(w, id), "read_at is set");
  });
});

test("an item with nowhere to go is marked read and returns to the inbox", { skip }, async () => {
  await withWorld(async (w) => {
    const id = await note(w, w.teacherA.id);
    signIn(w.teacherA);
    const res = await open(id);
    assert.equal(new URL(res.headers.get("location")!).pathname, "/inbox");
    assert.ok(await readAt(w, id));
  });
});

test("someone else's item, or a malformed id, is neither opened nor marked", { skip }, async () => {
  await withWorld(async (w) => {
    const theirs = await note(w, w.teacherB.id, { entityType: "mentor_pairing", entityId: w.pairingB });
    signIn(w.teacherA);
    const res = await open(theirs);
    assert.equal(new URL(res.headers.get("location")!).pathname, "/inbox");
    assert.equal(await readAt(w, theirs), null);
    const bad = await open("not-a-uuid");
    assert.equal(new URL(bad.headers.get("location")!).pathname, "/inbox");
  });
});

test("the unread and total counts count every row, not the fifty shown", { skip }, async () => {
  await withWorld(async (w) => {
    for (let i = 0; i < 55; i++) await note(w, w.teacherA.id);
    signIn(w.teacherA);
    const html = (await inboxHtml()).replace(/<!-- -->/g, "");
    assert.match(html, /55 unread · 55 total/);
  });
});
