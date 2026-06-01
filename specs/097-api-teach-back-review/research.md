# Research 097

## D-001 — Role list mirrors the queue read-gate

Spec 066's `READ_ROLES = new Set(["super_admin", "programme_admin", "mentor", "observer"])` is the canonical "who can see a teach-back" list. We reuse the same four roles here: anyone with read access to the queue can mark a row reviewed. Teachers and the unspecified default role are excluded — a teacher reviewing their own teach-back would defeat the purpose of expert review.

## D-002 — `.returning({id})` over `SELECT-then-UPDATE`

Two ways to detect a 404 path: (a) `SELECT` first and check existence, then `UPDATE`; (b) `UPDATE ... RETURNING id` and check the returned-row count. We chose (b) — single round-trip, atomic, and the WHERE clause's `context_type = 'teach_back'` predicate gives us the scoping safety check for free. The `SELECT-then-UPDATE` path also has a TOCTOU race where a concurrent delete between the two queries would produce a misleading 200; the `.returning` approach is race-free.

## D-003 — GET 405 stub vs implicit framework fallback

Next.js App Router auto-returns 405 for unhandled methods, so the explicit `GET()` export is technically redundant. We ship it anyway because (a) the spec brief calls for "GET returns 405" as an explicit test assertion, (b) the explicit handler lets us return a JSON body matching our error shape (`{error: "method_not_allowed"}`) instead of the framework's HTML default, and (c) a future Next upgrade changing the implicit fallback won't silently break our contract.
