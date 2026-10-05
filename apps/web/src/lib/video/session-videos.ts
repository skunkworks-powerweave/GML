import "server-only";

// The videos attached to classroom sessions, for the session and class pages.
//
// Who may see them is decided BEFORE this is called: the page has already
// opened the session or class as the viewer (a teacher: her own; an
// administrator: any), and lib/authz.ts sessionVideoAccess is the same rule
// for one session. These functions read what the caller names and nothing else.

import { and, desc, eq, inArray, type SQL } from "drizzle-orm";
import { db } from "@gml/db";
import { sessions, subjects, users, videoSubmissions } from "@gml/db/schema";

export type SessionVideo = {
  id: string;
  status: string;
  durationSec: number | null;
  createdAt: Date;
  uploadedBy: string | null;
  sessionId: string;
  sessionDate: string;
  subject: string | null;
  topic: string | null;
};

/** More than a page would sensibly list; the library at /videos has the rest. */
const LIMIT = 50;

function read(where: SQL | undefined): Promise<SessionVideo[]> {
  return db
    .select({
      id: videoSubmissions.id,
      status: videoSubmissions.status,
      durationSec: videoSubmissions.durationSec,
      createdAt: videoSubmissions.createdAt,
      uploadedBy: users.name,
      sessionId: sessions.id,
      sessionDate: sessions.scheduledDate,
      subject: subjects.name,
      topic: sessions.topic,
    })
    .from(videoSubmissions)
    .innerJoin(sessions, eq(sessions.id, videoSubmissions.contextId))
    .leftJoin(subjects, eq(subjects.id, sessions.subjectId))
    .leftJoin(users, eq(users.id, videoSubmissions.submittedByUserId))
    .where(and(eq(videoSubmissions.contextType, "classroom_session"), where))
    .orderBy(desc(videoSubmissions.createdAt))
    .limit(LIMIT);
}

/** The videos of these sessions, most recent first. */
export async function videosOfSessions(sessionIds: string[]): Promise<SessionVideo[]> {
  return sessionIds.length ? read(inArray(sessions.id, sessionIds)) : [];
}

/**
 * The videos of the sessions of one class, most recent first. `sessionScope` is
 * the viewer's session predicate (lib/teaching/visibility.ts sessionsWhere):
 * a teacher's own sessions, or undefined for an administrator.
 */
export function videosOfClass(classId: string, sessionScope: SQL | undefined): Promise<SessionVideo[]> {
  return read(and(eq(sessions.classId, classId), sessionScope));
}
