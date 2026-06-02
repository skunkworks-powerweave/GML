# Quickstart 130
Sign in, then visit one of these to see the context / prefill threaded:

- `/forms/observation-pre-1?cycleId=<observation_cycles.id>&observerId=<users.id>` — the runner reads cycleId + observerId out of the query string, sanitizes them, plants hidden `__ctx_cycleId` / `__ctx_observerId` inputs in the form, and on submit folds them into both `feedback_responses.responses.__context` and the `form.submit` audit metadata.
- `/forms/progress-mentor-1?pairingId=<mentor_pairings.id>&quarter=2` — same flow, with `quarter` validated to be an integer in `[1,4]`.
- `/forms/baseline-mentor-1?pairingId=<mentor_pairings.id>&prefill_mentor_name=Tsering` — opens the form with the `mentor_name` field pre-populated. Try `?prefill_unknown_field=…` to confirm unknown field names are silently dropped (the renderer never surfaces them).

Confirm the audit log row carries the context: `select metadata from audit_log where action='form.submit' order by created_at desc limit 1` — should show `cycleId` / `quarter` / `observerId` / `kind` keys alongside the existing `formId` / `kind` / `audience` / `version` keys.
