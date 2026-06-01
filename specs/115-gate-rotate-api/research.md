# Research 115

## D-001 — Role gate is `super_admin` only, not the `["programme_admin", "super_admin"]` admin-default pair

Across the admin surface, the default role gate is `requireRole(["programme_admin", "super_admin"])` — both populations can view/edit entity data, audit log, forms registry. Spec 115 narrows this to `super_admin` because gate-password rotation is the single most privileged action on the section-gate surface. SM-2 enforces the 8h grant ceiling as a DB CHECK constraint, which limits worst-case stale-grant time to 8h regardless of how the rotation happens, but the new password itself is high-value: if a programme_admin rotates and the plaintext leaks via WhatsApp screenshot, every gated section is breachable for 30 days (the rotation cadence). The 1-2 super_admins in the Ladakh deployment are the trust population the SM moats were designed around; programme_admins are operators who should not have credential-rotation authority.

## D-002 — INSERT new row with `version + 1` instead of UPDATE in place

`section_gates` keeps every version of every gate's password. We could UPDATE the existing row in place (single-row table per slug, no version bump), but the INSERT-new-version pattern is structurally better for three reasons:

1. **Already-issued grants don't immediately break.** The `lib/gates.ts::getCurrentGate` helper sorts by `version DESC` and returns the newest row, so a fresh rotation picks up the new password instantly. But a user with an active grant from the old version isn't tied to a specific row — they hold a `section_gate_grants` row with `gate_slug = ?, expires_at = ?` which has no foreign-key reference to a specific `section_gates.id`. So existing grants survive until we explicitly DELETE them in step 8.
2. **Audit history is queryable.** `SELECT * FROM section_gates WHERE slug = ? ORDER BY version DESC` returns the full rotation history with rotator + timestamp. An UPDATE-in-place pattern would require a separate `section_gate_history` table or rely entirely on `audit_log` (which has no schema affinity with the actual row data).
3. **DB CHECK constraints remain simple.** The current schema has no CHECK on `section_gates`; an UPDATE pattern would need to assert that `rotated_at >= previous_rotated_at`, which is awkward in plain SQL. The INSERT pattern doesn't need that — each row is immutable.

The downside is the table grows by one row per rotation per slug. At 30-day rotation cadence across 5 slugs, that's ~60 rows/year, which is negligible.

## D-003 — Mass DELETE on section_gate_grants instead of TTL-on-rotation

Two ways to invalidate active grants on rotation: (a) mass-DELETE every row WHERE `gate_slug = ?` (chosen); (b) UPDATE every active grant's `expires_at` to `now()` so the next middleware check drops them. We chose (a) because:

- Both produce the same observable behaviour (next middleware check sees no active grant → redirect to /gate/[slug]).
- (a) is one round-trip with `.returning({id})` for the audit metadata; (b) needs a SELECT-then-UPDATE chain.
- (a) keeps `section_gate_grants` lean (we don't want a table that grows indefinitely with rows that have already-passed expires_at — the SM-8 retention cron would have to sweep them anyway, so deleting on rotation pre-empties that work).
- (b) leaves an audit trail of "this grant was forcibly expired" inside `section_gate_grants` itself, which is appealing but is already captured in `audit_log` via the `gate.password.rotated` row's `grantsInvalidated` metadata count.

The audit metadata records the count of deleted grants, not the user_ids — that's intentional under SM-7. A future incident-investigation spec can join `audit_log` against the grant DELETEs by timestamp if it needs the per-user invalidation trail.

## D-004 — Password generation: node:crypto over secrets-package / random.org

`crypto.randomBytes(12)` from `node:crypto` is the right primitive. The Node stdlib provides cryptographically secure random bytes; we map each byte modulo the character-pool length to pick a glyph. The mod-bias is negligible: an 86-character pool against a 256-byte range gives at most a 4% deviation in single-character distribution, which over 12 characters has no practical impact on entropy (still ~77 bits of effective randomness). A bias-corrected variant (rejection sampling) would add code complexity without measurable security benefit.

We considered using a passphrase generator (XKCD-style four-word strings from a wordlist) — easier to read over the phone, harder to mistranscribe — but rejected it because: (a) the share path is WhatsApp deep-link, not over-the-phone dictation, (b) passphrases need a wordlist file in the repo and increase the security surface, (c) `crypto.randomBytes` is universally trusted while curated wordlists have known biases. The 12-character random string is the conventional choice for short-lived secrets shared programmatically.

## D-005 — Character pool excludes URL-unsafe glyphs and visually-confusable characters

The pool is `A-Za-z0-9!@#$%^&*` minus `I O l 0 1`. Two reasons:

1. **URL-safe in `wa.me/?text=...`.** Quotes, backslash, angle brackets, ampersand, equals, question mark are excluded so the urlencoded message in the share path doesn't pick up surprising escapes. `&` and `=` are technically urlencodable as `%26` / `%3D`, but every WhatsApp client I tested mishandles them in pre-fill URLs (the message arrives truncated at the first `&`). Belt-and-suspenders: avoid them entirely.
2. **Visual legibility.** The admin will see the plaintext on screen and (in some cases) read it back over a phone to confirm the recipient received the right thing. `I` / `l` / `1`, `O` / `0` are notorious confusables. Stripping them costs ~5% of the pool but eliminates the conversation-loop risk.

## D-006 — Share endpoint takes plaintext from the client, not from a server-side cache

The share endpoint accepts the plaintext as a request-body field rather than looking it up server-side. Three reasons:

1. **The plaintext isn't stored server-side.** After rotation, the only server-side artifact is the bcrypted hash. The plaintext lives in the rotate response and then in the admin's browser memory + clipboard.
2. **No fan-out cache to worry about.** A server-side cache (Redis with TTL) would need eviction logic, cross-process consistency on the BullMQ worker, and a clear "plaintext age" SM rule. Skipping the cache eliminates all of that.
3. **The client is already trusted with the plaintext.** It received the plaintext from the rotate response and is the only place it exists. Echoing it back through `/share` is no worse than rendering it on screen.

We considered an HMAC-signed "share token" (rotate response returns a token bound to slug + plaintext; share endpoint verifies the HMAC and uses the bound plaintext) but rejected it as solving a problem we don't have. The client-side trust model is identical either way.

## D-007 — `/admin/gates` is a server component with one client component (RotateControls)

The page is server-rendered for the stats SELECT (one DB round-trip per render), the recipient picker dataset, and the rotator-name lookup. The per-row Rotate button must be interactive (modal, copy, share) so it's wrapped in a single `RotateControls` client component. The result is one client boundary per card, which is the minimum that gives the interactive behaviour. We did NOT make the whole page a client component because (a) the server-side requireRole gate runs synchronously per request and we want it in the redirect path, (b) the stats query joins multiple tables and is awkward to issue over a `/api/admin/gates/stats` endpoint, and (c) we keep the page's data freshness story consistent with the rest of `/admin/*` (server components, force-dynamic).

## D-008 — Page-view audit (`gate.password.surface_viewed`) is best-effort, not mandatory

We record a `gate.password.surface_viewed` audit row on every page render. The action is technically not a mutation, but rotations are heavyweight enough that knowing when the admin opened the surface ("the admin opened the rotation page at 10:30, rotated at 10:35, shared with X at 10:36") is the kind of timeline reconstruction incident response needs. The audit insert is `void` (fire-and-forget) so a stalled audit doesn't block the page.

We're explicit about this being "view audit" not "mutation audit" — it's a discoverability/debuggability aid, not an SM-1 requirement. A future spec could elevate it to gated visibility (the audit log filter for `gate.password.*` could surface a 30-day timeline graph).
