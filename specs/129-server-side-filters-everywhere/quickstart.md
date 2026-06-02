# Quickstart 129 — Server-side filters everywhere

Manual smoke (5 minutes once `pnpm dev` is up + the seed has run):

1. **Observation list** — visit `/observation`. The new filter
   bar shows two chip groups: status (six tabs) and kind (four
   tabs). Click "Complete" — URL updates to
   `/observation?status=complete`. Reload — the same filter
   sticks (URL is the source of truth). Click "Baseline" too —
   URL goes to `/observation?status=complete&kind=baseline`.
   Open the Network tab — exactly one Postgres round-trip
   returns the narrowed slice.

2. **Schools** — visit `/repo/schools?district=kgl`. The page
   shows only Kargil-district schools and the total in the
   header reflects the total schools, not the filter slice
   (the chips count is what shows the active filter total).

3. **Subjects** — visit `/repo/subjects`. Pick "Grade 5" from
   the new select and Apply. URL becomes `/repo/subjects?grade=5`.
   Only subjects whose `grades_min ≤ 5 ≤ grades_max` survive
   the WHERE — Art (1-10), English (1-10), Math (1-10) appear;
   if a subject had `grades_min=6` it would be hidden.

4. **Outlines** — visit `/repo/outlines?grade=3&status=complete`.
   The table is now scoped to grade-3 complete outlines.

5. **Sessions** — visit `/repo/sessions?status=planned&from=2026-06-01&to=2026-06-30`.
   Only planned sessions scheduled in June 2026 survive. The
   `count` chips at the top show the total per status, not the
   filter slice — so "All" still says "the total sessions".

6. **Teachers** — visit `/repo/teachers`. Pick a school from
   the new "School" select + Apply. URL becomes
   `/repo/teachers?school=<uuid>`. The roster narrows to that
   school's teachers.

7. **Videos** — visit `/videos`. Pick "WhatsApp" from the new
   source select and Apply. URL becomes `/videos?source=whatsapp`.
   Only WhatsApp-ingested submissions show. Now click the
   "Ready to review" chip — URL is
   `/videos?status=ready&source=whatsapp` and both filters
   apply.

8. **Mentorship** — visit `/mentorship?status=review`. Only
   pairings currently in `review` status survive. The chip
   strip shows the per-status counts.

## Regression check

Visit `/repo/resources?kind=Policy` and `/admin/audit?action=view`
— neither page should have changed visually or in behavior.
They were already filtering on the server (spec 055 + spec 116).
This spec 129 only touched the pages that *weren't* server-side.
