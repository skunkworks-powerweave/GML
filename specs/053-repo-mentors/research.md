# Research 053
- Mentee counts use a single `groupBy(mentor_id)` over `mentor_pairings WHERE status='active'` to avoid N+1 — the `mentor_pairings_status_idx` index from spec 020 already covers this scan path.
- Synthesised detail page mirrors the teacher-detail pattern (KV header + status-grouped pairings) rather than inventing a new shape; status colours intentionally match the Tier-0 `/mentorship` list page for cross-surface consistency.
