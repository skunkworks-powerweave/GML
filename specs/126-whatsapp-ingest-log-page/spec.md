# Spec 126 — WhatsApp ingest log page (Workflow Run 10 frontend parity)

## Why

`LMS GML Frontend/videos.jsx` line 33 renders a "WhatsApp ingest log"
button in the video-library header. The live Next.js port at
`apps/web/src/app/(authenticated)/videos/page.tsx` (spec 044) routed
that button to `/admin/audit?action=whatsapp.` — but the audit-log
viewer has no `LIKE` filter, so the resulting URL matches **zero**
rows. From the operator's perspective the affordance is broken: they
click "WhatsApp ingest log" and the audit log shows nothing, even
though `recordAudit({ action: "whatsapp.message.received" })` is
firing on every webhook hit.

Spec 126 closes the gap by shipping a dedicated `/admin/whatsapp-log`
surface that:

1. Joins `video_submissions` (filtered to `source = 'whatsapp'`) with
   the matching `audit_log` rows (`action LIKE 'whatsapp.%'`) so a
   single row tells the full story: caption → context resolution →
   submission row → transcode status.
2. Filters on parsing result (`matched` vs `unmatched`, derived from
   `video_submissions.context_type` ≠ `'generic'`) and on creation
   date range.
3. Per row, a **Resend transcode** server action re-enqueues the
   BullMQ `transcode` job for submissions stuck in `failed` /
   `received` / `queued` / `transcoding` states.
4. Wires the videos-library button at videos.jsx:33 to the new page
   — visible only to `super_admin` + `programme_admin` (programme
   oversight roles per the brief).

## What we ship

### 1. `apps/web/src/app/(authenticated)/admin/whatsapp-log/page.tsx`

Server component, `requireRole(["programme_admin","super_admin"])`,
`export const dynamic = "force-dynamic"`. Layout follows the
spec-115 `/admin/gates` surface and the spec-116 `/admin/audit`
viewer:

- Header: title "WhatsApp ingest log" + one-paragraph blurb
  explaining the operator contract (caption codes, parsing logic,
  context fallbacks).
- Filter form (`<form method="get">`): two controls — Parsing
  (`any` / `matched` / `unmatched`) and a date-range picker
  (`from` / `to` ISO date inputs).
- Table: timestamp, sender phone (extracted from `audit_log.metadata
  ->> 'from'` on the `whatsapp.message.received` audit row),
  caption (truncated 40 chars), parsed context
  (`observation_cycle` / `teach_back` / `mentor_meeting` /
  `generic`, color-coded), submission link
  (`/videos/<submission.id>` if `submission.status !== 'received'`,
  raw id chip otherwise), status chip, and a Resend column.
- Limit: most-recent 100 rows by `submission.createdAt DESC`.
- Empty state: "No WhatsApp ingest events match the current
  filter."

### 2. `apps/web/src/app/(authenticated)/admin/whatsapp-log/actions.ts`

`"use server"`. Single export: `resendTranscodeAction(formData)`.

- Role gate: `requireRole(["programme_admin","super_admin"])`.
- Reads `submissionId` from `formData`.
- Looks up the `video_submissions` row + its `files` row to recover
  `bucket` + `objectKey`.
- Re-enqueues via `transcodeQueue.add("transcode", { ... })` with the
  same payload shape the webhook uses (spec 105).
- Records `whatsapp.transcode.resent` audit with
  `metadata: { submissionId, previousStatus }`.
- Redirects back to `/admin/whatsapp-log` (revalidate the same
  path) so the page re-renders with the freshly-enqueued state.

### 3. Wire the videos-library button (`videos/page.tsx`)

Edit the existing JSX so that:

- The "WhatsApp ingest log" `<Link>` href flips from
  `/admin/audit?action=whatsapp.` to `/admin/whatsapp-log`.
- The button is wrapped in a session-role check so only
  `programme_admin` + `super_admin` see it. `teacher` / `observer`
  / `mentor` get no button at all (consistent with the
  programme-oversight semantics of /admin/* surfaces).

## Status mapping

```
video_submissions.status   parsing result      Resend allowed?
received                   {context} matched   yes (stuck after webhook)
queued                     {context} matched   yes
transcoding                {context} matched   yes
ready                      {context} matched   no  (already done)
failed                     {context} matched   yes
review_pending             {context} matched   no  (operator action)
reviewed                   {context} matched   no
```

For `context_type = 'generic'` we still render the row (so ops can
see what teachers are actually sending), tagged as `unmatched`. The
Resend button is hidden on `ready` / `review_pending` / `reviewed`
rows because re-encoding a finalised video can't help.

## Acceptance criteria

- `/admin/whatsapp-log/page.tsx` exists, is a server component,
  calls `requireRole(["programme_admin","super_admin"])`, queries
  `video_submissions` with `eq(source, 'whatsapp')`, and renders the
  filter form + 100-row table.
- `/admin/whatsapp-log/actions.ts` exists, declares `"use server"`,
  exports `resendTranscodeAction`, calls
  `requireRole(["programme_admin","super_admin"])`, looks up the
  files row, re-enqueues via `transcodeQueue.add`, calls
  `recordAudit({ action: "whatsapp.transcode.resent", ... })`, and
  redirects back to `/admin/whatsapp-log`.
- `videos/page.tsx` "WhatsApp ingest log" `<Link>` points at
  `/admin/whatsapp-log` (not `/admin/audit`), and is gated behind
  `hasAnyRole(session.user.role, ["programme_admin","super_admin"])`
  so non-oversight users don't see a button that 403s for them.
- All five spec-kit files exist under
  `specs/126-whatsapp-ingest-log-page/`.
- `tests/governance/test_126_whatsapp_ingest_log_page.test.mjs`
  passes with at least six assertions covering the above.

## Non-goals

- No schema migration. All data we need lives in
  `video_submissions`, `files`, and `audit_log` already.
- No webhook changes. The existing `recordAudit` calls in
  `api/webhooks/whatsapp/route.ts` are already correctly named
  (`whatsapp.message.received`, `whatsapp.context.unmatched`,
  `transcode.enqueued`); spec 126 only reads them.
- No CSV export. The audit log surface already covers full-text
  CSV export via spec 116. If a future spec wants WhatsApp-only
  CSV that can re-use the same export pattern.
- No client component for the filter form — `<form method="get">`
  + plain `<select>` / `<input type=date>` keeps the page a pure
  server component, just like /admin/audit.
- No retry-with-different-context. The Resend button only re-runs
  the transcode pipeline; reassigning a submission to a different
  context entity is handled by the existing /admin/data/videos
  no-code editor (spec 012).
