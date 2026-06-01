# Research 117

## D-001 — Why `transitionCycleStatus(cycleId, from, to)` over SELECT-then-UPDATE

Two ways to enforce a status precondition: (a) `SELECT status` + check + `UPDATE`, or (b) `UPDATE ... WHERE id=? AND status=? RETURNING ...` and check the row count. We chose (b) — single round-trip, atomic, race-free. With (a), a concurrent click in another tab between the SELECT and the UPDATE produces a misleading 200 plus an incorrect transition. The `.returning({code})` shape gives us the cycle code for free, so the audit metadata can record human-readable IDs without a separate SELECT.

## D-002 — Why reuse `observation_cycles.remark` for the mentor note

Two options for the "Add note" CTA: (a) a new `observation_notes` table with FK + timestamp + author; (b) reuse the existing `observation_cycles.remark` text column. Option (a) is the correct long-term shape but requires a migration. Schema is locked for this run, so we route around it — v1 stores a single mentor note per cycle in `remark`, with audit-log `observation.note.added` capturing each edit (length + actor) so a future migration can replay/backfill if multi-note threads are introduced. The deviation is flagged under `designDeviations`.

## D-003 — Why the audit row is the v1 sign-off record

The prototype's `SignBlock` component (observation-detail.jsx line 364) renders two signature attestations — teacher + mentor — with separate states. Doing this faithfully needs an `observation_signoffs` table with role + signed_at + ip. We park the table behind a future migration and let the audit row at `action='observation.signed_off'` carry `metadata.signedByUserId` + `metadata.signedAt` — append-only by SM-1, immutable, sufficient for v1's "who signed when" question. The dedicated table can be added later without changing the action contract.

## D-004 — Role list per CTA

- **Pre / Post form**: teacher submits primarily, but `observer | mentor | programme_admin | super_admin` can submit on behalf (e.g. transcribing a paper draft). All five roles allowed.
- **Observer form**: observer is the source of truth — teachers should NOT rate themselves. Allowed: `observer | mentor | programme_admin | super_admin`.
- **Sign-off**: high-trust gate. Mentors and above only. Observers excluded — the prototype's sidebar always shows the mentor sign-off block (line 268), not the observer's.
- **Add note**: mentor's free-form remark. `observer | mentor | programme_admin | super_admin`. Teachers don't author mentor notes.

## D-005 — Why `.onConflictDoNothing()` on form INSERT

The `observation_forms` table has `uniqueIndex("observation_forms_cycle_kind_uq").on(cycleId, kind)`. A double-submit (status already transitioned but user double-clicked the button before the redirect fired) would otherwise return a 500 (unique violation). With `.onConflictDoNothing()`, the second insert is a silent no-op and the redirect lands the user on the refreshed page — they see the cycle's new status and don't perceive any error. The transition itself is also idempotent because `transitionCycleStatus` only matches the from-state.

## D-006 — Why no FormRenderer integration in this spec

The prototype's pre/post/observer forms have rich rubric pickers (line 156, 232). Wiring the spec-074 `FormRenderer` requires routing every submit through the universal `submitFormAction` and pivoting to a `?cycleId=…` URL pattern. That's a bigger refactor than the 6-CTA brief allows, and it conflates observation forms (which use `observation_forms` table) with feedback forms (which use `feedback_responses`). v1 ships native `<textarea>` for the body field — enough to demonstrate the status funnel and the audit trail. A follow-up spec can swap in `<FormRenderer>` per cycle phase once the schema unification is settled.

## D-007 — `<UploadProgress>` props alignment

The spec-045 `UploadProgress` component already declares `contextType: "observation_cycle" | "teach_back" | ...` and forwards both `contextType` + `contextId` as tus metadata. The server-side tusd post-finish hook (spec 038) reads those metadata keys and writes `video_submissions.context_type` + `.context_id`. No new code needed in this spec — we just mount the component with the right props. The "wire context to upload" CTA from the brief is a one-line prop pass.
