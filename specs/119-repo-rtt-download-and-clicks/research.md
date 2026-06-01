# Research 119

Three small design choices, each documented inline in the affected
files. (1) Resume CTA falls back to the modules-card anchor when the
subject has zero modules instead of becoming inert — the affordance
is preserved end-to-end. (2) Session rows link to /repo/session/<id>
even though rtt_sessions and sessions are distinct tables; the link
will 404 today, which is the same explicit choice the orchestrator
brief made for the quiz link, and a future spec will reconcile the
two-tables question. (3) The Assessment quiz hrefs use slugs
"mid-unit" and "endline" rather than a `subjects.slug` column we do
not yet have — Run 10's quiz-full-stack spec will define the canonical
URL shape and can re-touch this file.
