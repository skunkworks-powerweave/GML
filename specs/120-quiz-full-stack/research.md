# Research 120

## D-001 — Where to attach a quiz: subject vs rtt_subject

The JSX prototype declares quiz CTAs inside the RTT subject-detail page
(spec 119 Tier H wired Start → `/quizzes/mid-unit?subjectId=…`). At the
same time, the broader curriculum subjects family (spec 014) is the
natural anchor for end-of-unit assessments on the school side. We
considered a single polymorphic `target_id` + `target_type` column, but
two nullable FKs with a CHECK (exactly-one-of) gives Postgres a real FK
on each side and matches the pattern `formDrafts` already uses for
`template_id` vs `observation_cycle_id` (spec 020). Decision: ship both
nullable FKs + CHECK.

## D-002 — Why a server action instead of a REST PUT for admin save

Spec 073 (admin forms registry) ships a `PUT /api/admin/forms/[id]`
route because that was the Phase 8 pattern at the time. Phase 8 also
shipped Server Actions for the submit path (`/forms/[slug]` calls
`submitFormAction` directly). Per-spec-120 the admin save is also a
Server Action — colocated in `actions.ts` next to the page — because:

1. Authentication + role gating run inside `requireRole` exactly once,
   no need for the auth header round-trip.
2. The action returns a discriminated union (`SaveQuizResult`) that the
   client can switch on, without parsing JSON from `fetch` responses.
3. New since Phase 8: Server Actions support `useTransition` for free
   pending state — the editor button can read `isPending` without an
   extra state machine.

This is a deviation from spec 073, captured in the spec.md "Non-goals"
section.

## D-003 — Replace-all vs diff on save

The admin editor is a JSON textarea: there is no UI affordance to
"insert question between 2 and 3" or "remove question 4 only". The
mental model is "the JSON you see *is* the quiz." We honor that with a
replace-all transaction (delete + insert) inside `saveQuizSchema`. At
v1 scale (≤ 50 questions/quiz, ≤ 200 quizzes) the perf impact is
negligible. If a quiz ever grows large enough to matter, the call site
is already inside a `db.transaction` and a future diff path can land
without touching the public API.

## D-004 — Grading on the server, not the client

The JSX prototype computes `score` client-side because it had no
server. Moving grading to `submitQuizAttempt` means:

1. The client never sees `correctIndex` — answers ship up, score comes
   back. A future "anti-cheat" pass can add per-submission throttling
   here without touching the runner UI.
2. The submission row carries the canonical score + pass/fail. The
   result page reads it back; it doesn't recompute.
3. The audit log records what *the server decided*, not what the client
   claimed.

## D-005 — Why no /api/quizzes/[slug] route

Same reasoning as D-002 — Server Actions cover both submit and admin
save. The runner page (server component) owns the read; the
`<QuizRunner>` client component is a thin UI shell. No API surface to
maintain, no API contract to version. Audit hook fires inside the
action, exactly once per submit.

## D-006 — Pass threshold as smallint, not real

`pass_threshold` is whole-percent (0..100). Storing it as smallint with
a CHECK range keeps the value typed and makes the CHECK readable in
psql. Score is computed as `round((correct / total) * 100)` to match —
both sides of the comparison are integers, no floating-point surprises.
