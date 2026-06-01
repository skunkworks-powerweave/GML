# Research 069

## D-001 — `contextType="generic"` for the inline `<UploadProgress />` widget

`/uploads` is the personal landing for "I have a video"; binding to a specific observation cycle is a separate user intent handled at the cycle's evidence step (spec 059). Passing `generic` means the tusd post-finish hook (spec 038) writes `video_submissions.context_type='generic'`, `context_id=NULL` — which is exactly what the Drizzle schema's `context_type_check` allows and what the workflow downstream (spec 044 reviewer pickup) treats as "needs triage". No need to expose a cycle picker on this page.
