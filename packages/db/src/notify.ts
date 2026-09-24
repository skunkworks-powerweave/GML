// Writing in-app notifications: the one helper every producer uses.
//
// Until 2026-09 the only code that wrote a notification was the helpdesk
// ticket route, so the bell and the inbox were empty for every teacher, mentor
// and observer: cycles were assigned, videos transcoded and meetings logged
// without a word to anyone, although the settings page offered eight kinds.
// Producers live in both apps (the web app for cycle and meeting events, the
// worker for transcodes), which is why this is in packages/db.
//
// Whether a kind is SHOWN is decided at read time (apps/web/src/lib/
// notification-kinds.ts), so an administrator switching a kind back on also
// brings back what was written while it was off. Writing is therefore
// unconditional here.

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { notifications } from "./schema";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = NodePgDatabase<any>;

export type NotificationInput = {
  userId: string;
  /** A key from NOTIFICATION_CATEGORIES (apps/web/src/lib/notification-kinds.ts). */
  kind: string;
  subject: string;
  body?: string | null;
  entityType?: string | null;
  entityId?: string | null;
};

/**
 * Insert notifications, one per distinct (user, kind, entity), and report how
 * many landed.
 *
 * Never throws: a notification is a side effect of something that already
 * succeeded (a cycle was created, a video is ready), and failing that action
 * because the bell could not be written would be the wrong way round. The
 * failure is logged instead.
 */
export async function notify(db: AnyDb, rows: NotificationInput[], opts: { excludeUserId?: string | null } = {}): Promise<number> {
  const seen = new Set<string>();
  const values = [];
  for (const r of rows) {
    if (!r.userId || r.userId === opts.excludeUserId) continue;
    const key = `${r.userId}|${r.kind}|${r.entityType ?? ""}|${r.entityId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    values.push({
      userId: r.userId,
      kind: r.kind.slice(0, 40),
      // notifications.subject is varchar(200); an overflow used to throw and
      // take the whole originating request down with it.
      subject: r.subject.slice(0, 200),
      body: r.body ?? null,
      entityType: r.entityType?.slice(0, 64) ?? null,
      entityId: r.entityId ?? null,
    });
  }
  if (values.length === 0) return 0;
  try {
    const inserted = await db.insert(notifications).values(values).returning({ id: notifications.id });
    return inserted.length;
  } catch (err) {
    console.error("[notify] failed to write notifications", { kinds: [...new Set(values.map((v) => v.kind))], err });
    return 0;
  }
}
