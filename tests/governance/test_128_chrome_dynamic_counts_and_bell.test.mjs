// Governance test for spec 128 — chrome dynamic counts and bell.
//
// Closes the three "fake data" points in the JSX prototype:
//   1. NAV_BY_ROLE seed counts → real per-role queries.
//   2. Topbar bell button → Link to /inbox with live unread chip.
//   3. Topbar queue indicator chip → live BullMQ depth.
//
// Files under audit:
//   - apps/web/src/lib/chrome-counts.ts            (CREATED)
//   - apps/web/src/app/(authenticated)/layout.tsx  (EDITED)
//   - apps/web/src/components/shells/DesktopShell.tsx (EDITED)
//   - apps/web/src/components/shells/MobileShell.tsx  (EDITED)
//   - apps/web/src/components/nav/Sidebar.tsx      (EDITED)
//   - apps/web/src/components/nav/BottomTabs.tsx   (EDITED)
//   - apps/web/src/components/nav/Topbar.tsx       (EDITED)
//   - apps/web/src/app/api/notifications/unread-count/route.ts (CREATED)
// Plus five spec-kit files under specs/128-chrome-dynamic-counts-and-bell/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const SPEC_DIR = "specs/128-chrome-dynamic-counts-and-bell";
const COUNTS = "apps/web/src/lib/chrome-counts.ts";
const LAYOUT = "apps/web/src/app/(authenticated)/layout.tsx";
const DESKTOP_SHELL = "apps/web/src/components/shells/DesktopShell.tsx";
const MOBILE_SHELL = "apps/web/src/components/shells/MobileShell.tsx";
const SIDEBAR = "apps/web/src/components/nav/Sidebar.tsx";
const BOTTOMTABS = "apps/web/src/components/nav/BottomTabs.tsx";
const TOPBAR = "apps/web/src/components/nav/Topbar.tsx";
const UNREAD_ROUTE = "apps/web/src/app/api/notifications/unread-count/route.ts";

test("spec 128 — all five spec-kit files are present", () => {
  for (const name of ["spec.md", "plan.md", "research.md", "quickstart.md", "tasks.md"]) {
    assert.ok(
      existsSync(resolve(root, SPEC_DIR, name)),
      `${SPEC_DIR}/${name} must exist for the chrome dynamic counts spec`,
    );
  }
});

test("spec 128 — plan.md follows the CREATED/EDITED/MIGRATED contract", () => {
  const src = read(`${SPEC_DIR}/plan.md`);
  assert.match(src, /CREATED:/, "plan.md must declare a CREATED: line");
  assert.match(src, /EDITED:/, "plan.md must declare an EDITED: line");
  assert.match(src, /MIGRATED:/, "plan.md must declare a MIGRATED: line");
  assert.match(
    src,
    /lib\/chrome-counts\.ts/,
    "plan.md must call out the new chrome-counts lib in CREATED",
  );
  assert.match(
    src,
    /api\/notifications\/unread-count\/route\.ts/,
    "plan.md must call out the new unread-count API route in CREATED",
  );
  assert.match(
    src,
    /\(authenticated\)\/layout\.tsx/,
    "plan.md must call out the authenticated layout edit in EDITED",
  );
});

test("spec 128 — chrome-counts.ts exists and is server-only", () => {
  assert.ok(existsSync(resolve(root, COUNTS)), `${COUNTS} must exist`);
  const src = read(COUNTS);
  assert.match(
    src,
    /import\s+"server-only"/,
    "chrome-counts.ts must import 'server-only' to keep the loaders off the client bundle",
  );
});

test("spec 128 — chrome-counts.ts wraps each loader in React.cache", () => {
  const src = read(COUNTS);
  // The cache import — drives request-scoped memoisation per arglist.
  assert.match(
    src,
    /import\s+\{\s*cache\s*\}\s+from\s+"react"/,
    "chrome-counts.ts must import cache from 'react' for request-scoped memoisation",
  );
  // Each named export must wrap its body in cache(...).
  for (const name of ["loadNavCounts", "loadUnreadNotifications", "loadQueueDepth"]) {
    const re = new RegExp(`export const ${name}\\s*=\\s*cache\\(`);
    assert.match(src, re, `${name} must be defined via cache(...) so descendants reuse the same Promise`);
  }
});

test("spec 128 — chrome-counts.ts queries the right tables", () => {
  // loadNavCounts' queries moved to lib/nav-counts.ts, which takes the db as a
  // parameter so tests/behaviour/nav-counts.test.ts can execute them (the
  // observation badge counted the whole programme for teachers and mentors,
  // and nothing could run this module to notice). chrome-counts.ts delegates
  // to it, so the tables are pinned across the pair.
  const src = read(COUNTS) + read("apps/web/src/lib/nav-counts.ts");
  assert.match(read(COUNTS), /navCounts\(db, userId, role\)/, "loadNavCounts must delegate to lib/nav-counts.ts");
  // The mentor branch resolves the mentors row by userId so the pairings
  // count is keyed on the correct mentor.id.
  assert.match(
    src,
    /from\(mentors\)/,
    "loadNavCounts must resolve the mentors row by user.id before counting pairings",
  );
  assert.match(
    src,
    /from\(mentorPairings\)/,
    "loadNavCounts must count rows from mentor_pairings",
  );
  // The cycles count uses the in-flight tuple.
  assert.match(
    src,
    /pre_submitted/,
    "loadNavCounts must include 'pre_submitted' in the active-cycle status tuple",
  );
  assert.match(
    src,
    /post_submitted/,
    "loadNavCounts must include 'post_submitted' in the active-cycle status tuple",
  );
  // Reviews and uploads target video_submissions.
  assert.match(
    src,
    /from\(videoSubmissions\)/,
    "loadNavCounts must count rows from video_submissions",
  );
  // Drafts target form_drafts.
  assert.match(
    src,
    /from\(formDrafts\)/,
    "loadNavCounts must count form_drafts for any role that has a 'pendingForms' badge",
  );
  // Notifications loader hits notifications table.
  assert.match(
    src,
    /from\(notifications\)/,
    "loadUnreadNotifications must select from the notifications table",
  );
  assert.match(
    src,
    /isNull\(notifications\.readAt\)/,
    "loadUnreadNotifications must filter readAt IS NULL — the load-bearing 'unread' predicate",
  );
});

test("spec 128 — chrome-counts.ts reads queue depth from Postgres via @/lib/queue", () => {
  // INVERTED. This required `import { transcodeQueue } from "@gml/worker/queues"`
  // and a `transcodeQueue.getJobCounts("waiting", "active", "failed")` call.
  //
  // What that assertion really pinned was the topbar chip showing three real
  // numbers instead of the JSX prototype's hardcoded ones, and that is intact.
  // What went is the transport: `getJobCounts` was a Redis round-trip issued
  // from the layout on EVERY authenticated render, over the same ioredis client
  // configured with `maxRetriesPerRequest: null` and no `commandTimeout` -- so
  // with Redis down, the call did not fail, it hung, and it hung inside the
  // chrome of every page. The depth is now one GROUP BY against the `jobs`
  // table on the pool the request already holds.
  //
  // The three state names survive as the chip's vocabulary, but they are now a
  // MAPPING rather than a query argument, because the underlying statuses are
  // Postgres's, not BullMQ's: queued -> waiting, running -> active, and
  // dead -> failed. That last one is the one worth reading carefully. BullMQ's
  // 'failed' meant "the last attempt threw", including attempts that will be
  // retried; 'dead' means "the attempt budget is spent and a human is needed".
  // The chip is a call to action, so the narrower meaning is the right one.
  const src = read(COUNTS);
  assert.match(
    src,
    /import\s*\{\s*transcodeQueueDepth\s*\}\s*from\s*"@\/lib\/queue"/,
    "loadQueueDepth must import transcodeQueueDepth from @/lib/queue",
  );
  assert.match(
    src,
    /await\s+transcodeQueueDepth\(\)/,
    "loadQueueDepth must call transcodeQueueDepth()",
  );
  assert.match(
    src,
    /waiting:\s*counts\.queued/,
    "the chip's 'waiting' must map to the queued status",
  );
  assert.match(
    src,
    /active:\s*counts\.running/,
    "the chip's 'active' must map to the running status",
  );
  assert.match(
    src,
    /failed:\s*counts\.dead/,
    "the chip's 'failed' must map to `dead`, not to every errored attempt -- a job " +
      "with retries left is not something an operator needs to be told about",
  );
  // No BullMQ vocabulary may survive in executable code.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.ok(
    !/getJobCounts|@gml\/worker/.test(code),
    "chrome-counts.ts must not reach into the worker package or call getJobCounts",
  );
});

test("spec 128 — chrome-counts.ts exports the helper formatters and types", () => {
  const src = read(COUNTS);
  assert.match(
    src,
    /export\s+(?:function|const)\s+formatBellBadge/,
    "chrome-counts.ts must export formatBellBadge",
  );
  assert.match(
    src,
    /export\s+(?:function|const)\s+formatQueueLabel/,
    "chrome-counts.ts must export formatQueueLabel",
  );
  assert.match(
    src,
    /export\s+(?:function|const)\s+applyNavCounts/,
    "chrome-counts.ts must export applyNavCounts so the sidebar can merge counts",
  );
  assert.match(src, /export type NavCounts/, "chrome-counts.ts must export the NavCounts type");
  assert.match(src, /export type QueueDepth/, "chrome-counts.ts must export the QueueDepth type");
  // 99+ ceiling — keep the bell badge readable past 99.
  assert.match(
    src,
    /"99\+"/,
    "formatBellBadge must clamp the display to '99+' past 99 so the chip stays one chip wide",
  );
});

test("spec 128 — chrome-counts.ts loaders fail closed on errors", () => {
  const src = read(COUNTS);
  // try/catch around every external call — the chrome must stay readable
  // when Postgres or Redis is unreachable.
  const tryCount = (src.match(/try\s*\{/g) ?? []).length;
  assert.ok(
    tryCount >= 3,
    `expected at least 3 try/catch blocks (one per loader); found ${tryCount}`,
  );
  assert.match(
    src,
    /console\.error\(/,
    "loaders must log failures via console.error so the platform team sees them",
  );
});

test("spec 128 — (authenticated)/layout.tsx loads all three counts in parallel", () => {
  const src = read(LAYOUT);
  assert.match(
    src,
    /from\s+"@\/lib\/chrome-counts"/,
    "layout must import the loaders from @/lib/chrome-counts",
  );
  assert.match(
    src,
    /loadNavCounts/,
    "layout must call loadNavCounts(user.id, user.role)",
  );
  assert.match(
    src,
    /loadUnreadNotifications/,
    "layout must call loadUnreadNotifications(user.id)",
  );
  assert.match(
    src,
    /loadQueueDepth/,
    "layout must call loadQueueDepth() for the topbar queue chip",
  );
  // Single Promise.all so we don't pay sequential round-trips.
  assert.match(
    src,
    /Promise\.all\(\s*\[\s*loadNavCounts/,
    "layout must batch all three loaders in Promise.all so the per-request fan-out is one network hop",
  );
});

test("spec 128 — DesktopShell forwards navCounts/unreadCount/queueDepth", () => {
  const src = read(DESKTOP_SHELL);
  // Props on the DesktopShellProps type.
  assert.match(src, /navCounts\?:\s*NavCounts/, "DesktopShell must accept navCounts prop");
  assert.match(src, /unreadCount\?:\s*number/, "DesktopShell must accept unreadCount prop");
  assert.match(src, /queueDepth\?:\s*QueueDepth/, "DesktopShell must accept queueDepth prop");
  // Sidebar receives counts.
  assert.match(
    src,
    /counts=\{navCounts\}/,
    "DesktopShell must forward navCounts to the Sidebar's counts prop",
  );
  // Topbar receives unread + queue.
  assert.match(
    src,
    /unreadCount=\{unreadCount\}/,
    "DesktopShell must forward unreadCount to the Topbar",
  );
  assert.match(
    src,
    /queueDepth=\{queueDepth\}/,
    "DesktopShell must forward queueDepth to the Topbar",
  );
});

test("spec 128 — MobileShell forwards navCounts and unreadCount", () => {
  const src = read(MOBILE_SHELL);
  assert.match(src, /navCounts\?:\s*NavCounts/, "MobileShell must accept navCounts prop");
  assert.match(src, /unreadCount\?:\s*number/, "MobileShell must accept unreadCount prop");
  assert.match(
    src,
    /counts=\{navCounts\}/,
    "MobileShell must forward navCounts to BottomTabs",
  );
  assert.match(
    src,
    /unreadCount=\{unreadCount\}/,
    "MobileShell must forward unreadCount to BottomTabs for the inbox dot",
  );
});

test("spec 128 — Sidebar accepts counts and runs them through applyNavCounts", () => {
  const src = read(SIDEBAR);
  assert.match(src, /counts\?:\s*NavCounts/, "Sidebar props must declare counts?: NavCounts");
  assert.match(
    src,
    /applyNavCounts\(/,
    "Sidebar must call applyNavCounts to merge live counts into NAV_BY_ROLE before render",
  );
  assert.match(
    src,
    /from\s+"@\/lib\/chrome-counts"/,
    "Sidebar must import applyNavCounts from @/lib/chrome-counts",
  );
});

test("spec 128 — BottomTabs accepts counts and unreadCount", () => {
  const src = read(BOTTOMTABS);
  assert.match(src, /counts\?:\s*NavCounts/, "BottomTabs props must declare counts?: NavCounts");
  assert.match(
    src,
    /unreadCount\?:\s*number/,
    "BottomTabs props must declare unreadCount?: number for the inbox-tab dot",
  );
  // The tab id → badge map drives which tabs render a chip.
  assert.match(src, /TAB_BADGE/, "BottomTabs must declare a TAB_BADGE id→resolver map");
});

test("spec 128 — Topbar bell is a Link to /inbox, not a button", () => {
  const src = read(TOPBAR);
  // The Link import — was missing before this spec.
  assert.match(
    src,
    /import\s+Link\s+from\s+"next\/link"/,
    "Topbar must import Link from next/link to make the bell a soft-navigation anchor",
  );
  // The bell must carry the data-testid for browser tests.
  assert.match(
    src,
    /data-testid="topbar-bell"/,
    "Topbar bell must declare data-testid='topbar-bell' for downstream tests",
  );
  // The bell's href is /inbox — clicking goes to the inbox feed.
  assert.match(
    src,
    /href="\/inbox"/,
    "Topbar bell must link to /inbox",
  );
  // The chip uses formatBellBadge.
  assert.match(
    src,
    /formatBellBadge/,
    "Topbar must call formatBellBadge to render the bell chip with the '99+' clamp",
  );
  // The chip has its own testid so it can be located independently.
  assert.match(
    src,
    /data-testid="topbar-bell-badge"/,
    "Topbar bell chip must declare data-testid='topbar-bell-badge'",
  );
});

test("spec 128 — Topbar renders the queue indicator chip", () => {
  const src = read(TOPBAR);
  assert.match(
    src,
    /data-testid="topbar-queue-indicator"/,
    "Topbar queue chip must declare data-testid='topbar-queue-indicator'",
  );
  assert.match(
    src,
    /formatQueueLabel/,
    "Topbar must call formatQueueLabel to render the queue chip text",
  );
  // Topbar must accept queueDepth + unreadCount via its props.
  assert.match(
    src,
    /queueDepth\?:\s*QueueDepth/,
    "Topbar props must declare queueDepth?: QueueDepth",
  );
  assert.match(
    src,
    /unreadCount\?:\s*number/,
    "Topbar props must declare unreadCount?: number",
  );
});

test("spec 128 — /api/notifications/unread-count route exists and gates on auth", () => {
  assert.ok(existsSync(resolve(root, UNREAD_ROUTE)), `${UNREAD_ROUTE} must exist`);
  const src = read(UNREAD_ROUTE);
  // GET handler — JSON polling endpoint.
  assert.match(src, /export\s+async\s+function\s+GET/, "route must export an async GET handler");
  // 401 on unauth.
  assert.match(
    src,
    /unauthenticated/,
    "GET handler must return 401 'unauthenticated' when no session",
  );
  // Auth resolved via @/auth, count via @/lib/chrome-counts.
  assert.match(src, /from\s+"@\/auth"/, "route must import auth() from @/auth");
  assert.match(
    src,
    /from\s+"@\/lib\/chrome-counts"/,
    "route must import loadUnreadNotifications from @/lib/chrome-counts to reuse the cached loader",
  );
  assert.match(
    src,
    /loadUnreadNotifications/,
    "route must call the React.cache'd loader so the count matches the layout's value within a request",
  );
  // 405 on other verbs.
  assert.match(
    src,
    /method_not_allowed/,
    "route must respond 405 method_not_allowed on POST/PUT/DELETE/PATCH",
  );
  // force-dynamic so the count never gets cached at the framework layer.
  assert.match(
    src,
    /export const dynamic\s*=\s*"force-dynamic"/,
    "route must opt out of caching — the count must reflect the latest DB state",
  );
});

test("spec 128 — no TODO / FIXME markers leaked into shipped source", () => {
  for (const path of [COUNTS, UNREAD_ROUTE, SIDEBAR, BOTTOMTABS, TOPBAR, DESKTOP_SHELL, MOBILE_SHELL]) {
    const src = read(path);
    assert.ok(!/\bTODO\b/.test(src), `${path} must not contain TODO markers`);
    assert.ok(!/\bFIXME\b/.test(src), `${path} must not contain FIXME markers`);
  }
});
