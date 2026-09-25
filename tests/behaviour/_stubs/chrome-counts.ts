// Stands in for apps/web/src/lib/chrome-counts.ts (see ../_ui.ts), which
// imports @gml/db and opens a pool at import time. The chrome components use
// only the pure formatters and the count merge; tests render without counts.

export type NavCounts = Record<string, number | undefined>;
export type QueueDepth = { active: number; waiting: number; failed: number };

export function applyNavCounts<T>(sections: T): T {
  return sections;
}

export function formatBellBadge(count: number): string | null {
  if (!count || count <= 0) return null;
  return count > 99 ? "99+" : String(count);
}

// A label whenever anything is queued, as the real one, so a test can render
// the topbar's queue pill. Its wording is the real formatter's business, not
// something the chrome tests read.
export function formatQueueLabel(counts?: QueueDepth): string | null {
  if (!counts || (counts.active === 0 && counts.waiting === 0 && counts.failed === 0)) return null;
  return `${counts.active} · ${counts.waiting} · ${counts.failed}`;
}

// The loaders the authenticated layout awaits. Empty, as the real ones are
// when their data source is down (they fail closed), so a test can render the
// layout itself without a count query in the way.
export async function loadNavCounts(): Promise<NavCounts> {
  return {};
}

export async function loadUnreadNotifications(): Promise<number> {
  return 0;
}

export async function loadQueueDepth(): Promise<QueueDepth> {
  return { active: 0, waiting: 0, failed: 0 };
}
