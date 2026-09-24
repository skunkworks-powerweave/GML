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

export function formatQueueLabel(): string | null {
  return null;
}
