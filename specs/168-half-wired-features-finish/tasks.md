# Tasks 168

- [x] T1 → write the governance test (red) covering:
  - `apps/web/src/lib/system-settings.ts` exists and exports
    `getSystemSettings` wrapped in `cache(...)` with a SELECT on
    `SYSTEM_SETTINGS_ID`.
  - `apps/web/src/lib/audit.ts` exports `recordAuditDedup` with the
    dedupKey + ttlSeconds signature; references the `metadata ->>'__dedupKey'`
    accessor.
  - `apps/web/src/components/video/UploadModal.tsx` accepts a
    `videoDefaultQuality` prop and renders a
    `data-testid="upload-quality-explainer"` element.
  - `apps/web/src/lib/chrome-counts.ts` filters
    `loadUnreadNotifications` via `inArray(notifications.kind, …)`
    against `system_settings.notificationsEnabled`.
  - `apps/web/src/app/(authenticated)/admin/page.tsx` reads
    programmeName + academicYear from `getSystemSettings()` and
    renders a `data-testid="admin-programme-name"`.
  - `apps/web/src/app/login/forgot/page.tsx` is a server component
    (no `"use client"`), reads `process.env.SMTP_HOST`, and renders
    the `data-testid="forgot-password-smtp-unavailable"` banner.
  - `apps/web/src/app/login/forgot/ForgotPasswordForm.tsx` exists,
    declares `"use client"`, and exports `ForgotPasswordForm`.
  - `apps/web/src/app/(authenticated)/admin/transcode-jobs/page.tsx`
    declares a `redisUnavailable` flag and renders the
    `data-testid="dlq-redis-down-banner"`.
  - `apps/web/src/app/(authenticated)/repo/students/page.tsx`
    declares `q?: string`, calls `ilike(learners.name, …)`, and
    calls `recordAuditDedup` with `action: "learners.search"`.
  - `tests/governance/test_158_repo_search_bars.test.mjs` is updated
    to allow `ilike(learners.name, …)` when `recordAuditDedup` is
    also called.
  - All five spec-kit files exist under
    `specs/168-half-wired-features-finish/`.
  Run suite → red.
- [x] T2 → create `apps/web/src/lib/system-settings.ts` with the
  React.cache'd `getSystemSettings` loader. Inline Spec 168 comment
  explaining the cache key + fail-shape.
  Run scoped governance test → loader assertions green.
- [x] T3 → extend `apps/web/src/lib/audit.ts` with the
  `recordAuditDedup` helper. SELECT then conditional INSERT;
  metadata `__dedupKey` reserved field; non-atomic on purpose.
  Run scoped governance test → audit-dedup assertions green.
- [x] T4 → edit `UploadModal.tsx`: accept `videoDefaultQuality` prop
  and surface it in the browser-upload explainer card with
  `data-testid="upload-quality-explainer"`. Update the videos page
  to pass `sysSettings?.videoDefaultQuality ?? "480p"`.
  Run scoped governance test → upload-modal assertion green.
- [x] T5 → edit `chrome-counts.ts`: filter loadUnreadNotifications
  by `system_settings.notificationsEnabled` with the empty-array /
  null-array edge cases. Inline Spec 168 comment.
  Run scoped governance test → notifications-filter assertion green.
- [x] T6 → edit `admin/page.tsx`: surface programmeName +
  academicYear in the header with data-testid anchors. Fall back to
  the schema defaults when the row is missing.
  Run scoped governance test → admin-home assertion green.
- [x] T7 → rewrite `login/forgot/page.tsx` as a server component
  that reads SMTP_HOST. Create `ForgotPasswordForm.tsx` for the
  client island.
  Run scoped governance test → forgot-password assertions green.
- [x] T8 → edit `admin/transcode-jobs/page.tsx`: explicit
  `redisUnavailable` flag drives a saffron-soft banner ABOVE the
  depth strip + table with `role="alert"`.
  Run scoped governance test → transcode-jobs banner assertion green.
- [x] T9 → edit `repo/students/page.tsx`: add `?q=` ILIKE on
  learners.name + recordAuditDedup with the documented dedupKey
  shape. Update the buildHref pagination helper to preserve the
  `q` parameter.
  Run scoped governance test → repo-students assertions green.
- [x] T10 → loosen the `/repo/students` assertion in
  `tests/governance/test_158_repo_search_bars.test.mjs` — the page
  may carry the ilike ONLY when recordAuditDedup is also called.
  Run spec 158 governance test → still green.
- [x] T11 → author all five spec-kit files under
  `specs/168-half-wired-features-finish/`.
- [x] T12 → run the full governance suite. Confirm no regression
  in the 1423-test baseline.
- [ ] T13 (future, out of scope) → port the dedup helper to other
  SM-9 surfaces (every learners.* page that writes an audit row on
  every render). Currently only /repo/students is on the audit-
  flood hotpath because of its name-search; if a future spec adds
  similar narrow search bars to /repo/teachers (which also writes
  teachers.bulk_view) the dedup helper is the right shape.
- [ ] T14 (future, out of scope) → live SMTP probe for the
  forgot-password banner. The current check is "SMTP_HOST is
  non-empty"; a connect-and-tls probe would be more accurate but
  would also turn the public login route into a per-render network-
  call surface, opening a DoS vector against the SMTP relay.
  Revisit if the deployment grows enough that "SMTP set but
  unreachable" becomes a real operator complaint.
- [ ] T15 (future, out of scope) → atomic INSERT ... WHERE NOT
  EXISTS for recordAuditDedup. Currently SELECT-then-INSERT with a
  small race window; an atomic CTE-with-modification would close
  the window at the cost of raw SQL (Drizzle's INSERT builder
  doesn't natively support WHERE NOT EXISTS). Revisit if the audit
  log shows enough dedup-race duplicates to warrant the cost.
