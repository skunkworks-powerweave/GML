// Where an inbox item goes when it is opened.
//
// Shared by /inbox, which links every item through
// /api/notifications/<id>/open, and by that route, which marks the item read
// and redirects here. Opening an item used to leave it unread, and an item
// with no entity was a plain block that could be neither opened nor marked.

/** Entity type -> the page for that entity (the id is appended). */
const ENTITY_HREF: Record<string, (id: string) => string> = {
  cycle: (id) => `/observation/${id}`,
  observation_cycle: (id) => `/observation/${id}`,
  video: (id) => `/videos/${id}`,
  video_submission: (id) => `/videos/${id}`,
  meeting: (id) => `/mentorship/${id}`,
  mentor_pairing: (id) => `/mentorship/${id}`,
  pairing: (id) => `/mentorship/${id}`,
  quiz: (id) => `/quizzes/${id}`,
  session: (id) => `/repo/session/${id}`,
};

export function hrefForEntity(entityType: string | null, entityId: string | null): string | null {
  if (!entityType || !entityId) return null;
  const fn = ENTITY_HREF[entityType];
  // entity_id is free text; it becomes one path segment and nothing more.
  return fn ? fn(encodeURIComponent(entityId)) : null;
}

/** The route every inbox item links through. */
export function openHref(notificationId: string): string {
  return `/api/notifications/${encodeURIComponent(notificationId)}/open`;
}
