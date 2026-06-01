# Spec 115 — Section-gate password rotation API + admin UI

**Status:** complete · **Date:** 2026-06-02 · **Phase:** Workflow Run 9 (frontend-parity closure) · **Tier:** A (highest-impact workflow blocker).

## Why

The frontend-parity audit catalogued 89 gaps between the JSX prototype's interactive surface and the live backend. The single highest-impact gap was section-gate password rotation: the prototype admin.jsx::SectionGates (lines 285-325) renders a "Rotate" button per gate row, but no `/api/admin/gates/[slug]/rotate` endpoint existed in production. A `super_admin` who needed to invalidate a compromised gate password had only two options: SSH into Postgres and run an `UPDATE section_gates SET password_hash = ?, version = version + 1 WHERE slug = ?` by hand (out-of-band, no audit trail, no grant invalidation), or wait up to 8 hours for the SM-2 grant ceiling to flush stale grants naturally (which doesn't help if the leaked password is still valid against the existing hash). Neither option is acceptable for a credential-compromise drill that the SM-2 substrate moat is supposed to make routine.

Spec 115 closes the gap by shipping two API routes plus a dedicated admin page:

1. `POST /api/admin/gates/[slug]/rotate` — generates a cryptographically random 12-character password, bcrypts it at cost 10 (matching the existing `apps/web/src/lib/password.ts` verify path), inserts a new `section_gates` row with `version = max(version) + 1`, and DELETEs every active `section_gate_grants` row for the slug so every authorised user must re-unlock with the new password. Returns the plaintext ONCE in the response so the admin can capture it before the in-memory copy is gone.
2. `POST /api/admin/gates/[slug]/share` — companion endpoint that takes the recipient's user id plus the plaintext (echoed from the rotate response) and returns a `wa.me/<phone>?text=<urlencoded-msg>` deep link. We deliberately do NOT auto-send — the human in the loop is the SM-7 PII-handling guarantee, since the password appears in both parties' WhatsApp history once Send is hit, and the admin must re-confirm the recipient before the link opens.
3. `/admin/gates` — server-component dashboard that renders one card per gate slug with stats (last rotated, version, active grants, attempts/failures in last 30 days, last rotator), hands the per-row rotate/share UX to a single `RotateControls` client component, and replaces the placeholder "Section gates" tile on `/admin` that has been pointing at "lands in spec 021 / 035" since the Phase-2 rollout.

The whole surface is gated to `super_admin` ONLY. `programme_admin` can view `/admin/forms`, `/admin/audit`, and the entity-data grid, but the gate rotation is the single most privileged action on the section-gate surface (SM-2: gate grants ≤ 8h is enforced at the DB CHECK layer, so a rotation that runs without invalidating active grants leaves a worst-case 8-hour stale window during which the leaked password is still valid; we don't trust programme_admin with that responsibility).

## What

### Route 1: `POST /api/admin/gates/[slug]/rotate`

`apps/web/src/app/api/admin/gates/[slug]/rotate/route.ts` exports an async POST handler that:

1. Calls `auth()`. If no session, returns 401 `{error: "unauthenticated"}`.
2. Asserts `session.user.role === "super_admin"`. Otherwise returns 403 `{error: "forbidden"}`.
3. Reads the `slug` path param. If not in `["mentorship", "observation", "admin", "tkt", "ttt"]` (the `section_gate_slug` enum values), returns 400 `{error: "invalid_slug"}`.
4. Generates a fresh 12-character password via `crypto.randomBytes(12)` mapped onto a typeable-on-WhatsApp character pool: `A-Za-z0-9!@#$%^&*` minus visually-confusable glyphs (I, O, l, 0, 1). The pool is restricted because the share endpoint pastes the plaintext into a `wa.me/?text=...` URL and we don't want URL-escape surprises (no quotes, no backslash, no angle brackets).
5. bcrypts the plaintext at cost 10 (matches `apps/web/src/lib/password.ts` so the `/gate/[slug]` verify path uses the same compare codepath with no special-casing).
6. SELECTs `max(version)` from `section_gates WHERE slug = ?`, computes `nextVersion = (latest ?? 0) + 1`.
7. INSERTs a new `section_gates` row with `slug, passwordHash, version: nextVersion, rotatedAt: now(), rotatedByUserId: session.user.id`. The existing row(s) stay so already-issued grants don't immediately break on rotation (the `lib/gates.ts::getCurrentGate` helper orders by `version DESC` and returns the new row; old rows are dead but kept for historical audit).
8. DELETEs every `section_gate_grants` row where `gate_slug = ?`, capturing the deleted ids via `.returning({id})` for the audit metadata.
9. `void recordAudit({action: "gate.password.rotated", entityType: "section_gate", entityId: slug, metadata: {slug, version: nextVersion, by: session.user.id, grantsInvalidated: deleted.length}})`. Audit is best-effort (`void`) — failure does not block the response.
10. Returns 200 `{ok: true, plaintext, version: nextVersion}`. The plaintext is the only place it appears outside the bcrypted hash; the admin captures it from the modal once.

### Route 2: `POST /api/admin/gates/[slug]/share`

`apps/web/src/app/api/admin/gates/[slug]/share/route.ts` exports an async POST handler that:

1. Same auth + role + slug-validation pattern as `/rotate`.
2. Parses body via zod: `{recipientUserId: uuid, channel: "whatsapp", plaintext: string}`. Empty / unparseable bodies are tolerated → 400 `validation_failed` with the zod issue list.
3. SELECTs the recipient's `phone` from `users WHERE id = ?`. If the row is missing, returns 400 `{error: "recipient_not_found"}`. If `phone IS NULL` or empty after digit-stripping, returns 400 `{error: "recipient_no_phone"}`.
4. Normalises the phone by stripping every non-digit (WhatsApp's `wa.me` deep links require no `+`, no spaces, no dashes — pure digits in international format).
5. Composes the URL: `https://wa.me/<phone>?text=` + urlencoded `[GML LMS] New <slug> gate password: <plaintext> — rotate every 30 days.`
6. `void recordAudit({action: "gate.password.share_initiated", entityType: "section_gate", entityId: slug, metadata: {slug, recipientUserId, channel, by: session.user.id}})`. The plaintext password is NEVER written to audit_log — the audit row carries the intent, not the secret.
7. Returns 200 `{ok: true, url}`. The client then `window.open(url, "_blank", "noopener,noreferrer")` from the modal.

### Route 3: `/admin/gates` page

`apps/web/src/app/(authenticated)/admin/gates/page.tsx` is a server component that:

1. `await requireRole(["super_admin"])` — anything other than super_admin gets redirected to `/forbidden`.
2. Records a `gate.password.surface_viewed` audit row so the audit log shows when each rotation surface was opened (cheap, useful for incident investigation).
3. For each of the five gate slugs, SELECTs the latest version + rotation metadata, counts active grants (`expires_at > now()`), and counts 30-day attempts + failures from `audit_log` (actions: `gate.attempt.success`, `gate.attempt.fail`, plus the legacy `gate_pass` / `gate_fail` actions kept compatible with pre-spec-021 audit rows).
4. SELECTs the candidate share recipients: `users` who are `active = true`, have a non-null `phone`, and are in roles `mentor`, `programme_admin`, or `super_admin`. Capped at 50 for the dropdown.
5. SELECTs the rotator email for each gate's `rotated_by_user_id` using `inArray` (not raw SQL — defense against accidental injection through user-controlled rotator ids; the ids come from our own DB but the safer path is free).
6. Renders five cards in a 2-column grid (mobile collapses to 1 column). Each card shows the gate label, slug, description, stats, and a `<RotateControls>` block.

### Route 4: `RotateControls` client component

`apps/web/src/app/(authenticated)/admin/gates/rotate-controls.tsx` is a client component that:

1. Renders the "Rotate password" submit button as a native form.
2. On submit, fires `window.confirm("Rotate the <label> gate password? Every active grant will be invalidated and every user will need to re-unlock with the new password.")`. Matches the spec-114 ConfirmModal pattern.
3. POSTs to `/api/admin/gates/<slug>/rotate`, captures the response.
4. Renders the plaintext in an amber-bordered reveal block with three controls: a `<code>` element holding the plaintext, a "Copy" button that calls `navigator.clipboard.writeText`, and (if recipients are available) a recipient `<select>` plus a "Share via WhatsApp" button.
5. On Share click, fires a second confirm dialog, POSTs to `/share`, and `window.open()`s the returned URL in a new tab.

### Route 5: `/admin` link update

`apps/web/src/app/(authenticated)/admin/page.tsx` — the "Section gates" placeholder tile that has been pointing at "lands in spec 021 / 035" becomes a live `<Link href="/admin/gates">`.

## Functional Requirements

- **FR-001** — `apps/web/src/app/api/admin/gates/[slug]/rotate/route.ts` exists with `export const dynamic = "force-dynamic"`.
- **FR-002** — Rotate route exports an async POST handler accepting Next App-Router `Request` + `{params: Promise<{slug: string}>}`.
- **FR-003** — Rotate auth gate: `await auth()`, 401 on no session.
- **FR-004** — Rotate role gate: `super_admin` only. 403 otherwise. The source explicitly contains `"super_admin"` and explicitly does NOT contain `"programme_admin"` as an allowed role string.
- **FR-005** — Rotate slug validation: must be one of `["mentorship", "observation", "admin", "tkt", "ttt"]`. 400 otherwise.
- **FR-006** — Password generation: `node:crypto.randomBytes(12)` mapped onto a typeable-on-WhatsApp character pool (no `'`, `"`, `\`, `<`, `>`). Output length is 12 characters.
- **FR-007** — bcrypt hash at cost 10, via `bcryptjs` (already a workspace dep).
- **FR-008** — SQL: `SELECT max(version) FROM section_gates WHERE slug = ?` followed by an INSERT with the next version, then a DELETE on `section_gate_grants WHERE gate_slug = ?` with `.returning({id})`.
- **FR-009** — Audit hook: `void recordAudit({action: "gate.password.rotated", entityType: "section_gate", entityId: slug, metadata: {slug, version, by, grantsInvalidated}})`.
- **FR-010** — Rotate response: `200 {ok: true, plaintext, version}`. The plaintext is returned in cleartext exactly once.
- **FR-011** — Method matrix: GET/PUT/DELETE/PATCH return 405 `{error: "method_not_allowed"}` so framework defaults don't leak HTML.
- **FR-012** — `apps/web/src/app/api/admin/gates/[slug]/share/route.ts` exists with the same role/slug gates.
- **FR-013** — Share body validation: zod schema `{recipientUserId: uuid, channel: literal "whatsapp", plaintext: string 1-64}`.
- **FR-014** — Share looks up `users.phone`; 400 on missing recipient or missing phone.
- **FR-015** — Phone normalization strips every non-digit before embedding in the `wa.me` URL.
- **FR-016** — Share audit: `gate.password.share_initiated` with `{slug, recipientUserId, channel, by}`. **The plaintext password is NEVER written to audit_log.**
- **FR-017** — Share response: `200 {ok: true, url}` with `url = "https://wa.me/<digits>?text=<encoded>"`.
- **FR-018** — `/admin/gates/page.tsx` exists, calls `requireRole(["super_admin"])`, and renders one card per gate slug.
- **FR-019** — Page audit hook: `void recordAudit({action: "gate.password.surface_viewed", entityType: "section_gate"})`.
- **FR-020** — Page imports `RotateControls` from `./rotate-controls`. The client component handles all interactivity.
- **FR-021** — `/admin` index page replaces the "Section gates" placeholder with a live `<Link href="/admin/gates">`.
- **FR-022** — All imports are from existing workspace packages: `@gml/db`, `@gml/db/schema`, `@/auth`, `@/lib/audit`, `@/lib/guards`, `bcryptjs`, `drizzle-orm`, `next/server`, `node:crypto`, `zod`. No new dependencies.

## Acceptance Criteria

| AC | Behaviour | Verification |
|----|-----------|--------------|
| AC-1 | Rotate route exists | `existsSync` test |
| AC-2 | Share route exists | `existsSync` test |
| AC-3 | Admin page exists | `existsSync` test |
| AC-4 | Client controls exist | `existsSync` test |
| AC-5 | Rotate gates by super_admin only (not programme_admin) | grep `"super_admin"`, assert no `"programme_admin"` string |
| AC-6 | Rotate audit fires `gate.password.rotated` | grep the action string |
| AC-7 | Rotate response carries `plaintext` | grep `plaintext` in response shape |
| AC-8 | Rotate INSERTs new section_gates row | grep `db.insert(sectionGates)` |
| AC-9 | Rotate DELETEs section_gate_grants | grep `db.delete(sectionGateGrants)` and `.where(eq(sectionGateGrants.gateSlug` |
| AC-10 | Share builds `wa.me/...?text=` URL | grep `wa.me/` |
| AC-11 | Share audit fires `gate.password.share_initiated` | grep the action string |
| AC-12 | Admin index links to /admin/gates | grep `href="/admin/gates"` |
| AC-13 | No new deps in package.json | (manual — diff check) |
| AC-14 | governance test passes | `pnpm test -- tests/governance/test_115_*` exits 0 |

## Schema gaps / deviations

None. The route rides existing tables:

- `section_gates` (spec 008) — has `id, slug, password_hash, version, rotated_at, rotated_by_user_id, created_at`. The INSERT path uses exactly those columns.
- `section_gate_grants` (spec 008) — has `id, user_id, gate_slug, granted_at, expires_at, ip` with a CHECK constraint enforcing the 8h ceiling. The DELETE WHERE `gate_slug = ?` mass-invalidates on rotation.
- `audit_log.action` is `varchar(64)` since spec 021, so `gate.password.rotated`, `gate.password.share_initiated`, and `gate.password.surface_viewed` land without enum migration.
- `users.phone` is `varchar(32)` and nullable (spec 004); the share endpoint reads it and 400s on null.

No new columns, no new enum values, no new indexes.

## Out of scope

- Actually calling the WhatsApp Cloud API to send the password. The `/api/webhooks/whatsapp` surface (spec 043) is RECV-only; SEND-side automation (spec 105) covers video-receipt acknowledgement, not gate-password distribution. The human-in-the-loop deep-link approach is the SM-7 PII-handling guarantee for v1.
- A "show current password" affordance. Current passwords are bcrypted and not recoverable; the only way to know the password is to have it in hand at rotation time, which is exactly the rotate-then-reveal flow.
- Multi-recipient share. The dropdown is single-select for v1; a future spec can extend to multi-select if operations need to bulk-distribute.
- Email / SMS share channels. The `channel` field is parsed and validated to `"whatsapp"` (enum-of-one for now) so a future spec can extend without changing the URL shape.
- A rotation-history table. The `section_gates` table already keeps every version (we don't UPDATE in place; we INSERT a new row with the next version), so the history is queryable via `SELECT * FROM section_gates WHERE slug = ? ORDER BY version DESC`. A dedicated UI page can land later.
- Auto-rotate on schedule (cron). A future spec can add a BullMQ scheduled job that calls the rotate route every N days; out of Run-9 scope.
- Password-strength meter on the UI. The plaintext is generated by `crypto.randomBytes` from a 86-character pool, giving log2(86^12) ≈ 77 bits of entropy — well above any reasonable strength target.

## Audit hooks (SM-1, SM-7)

Three free-form actions land in `audit_log.action`:

- `gate.password.rotated` — entityType `section_gate`, entityId `<slug>`, metadata `{slug, version, by, grantsInvalidated}`. The plaintext is NEVER in metadata.
- `gate.password.share_initiated` — entityType `section_gate`, entityId `<slug>`, metadata `{slug, recipientUserId, channel, by}`. The plaintext is NEVER in metadata.
- `gate.password.surface_viewed` — entityType `section_gate`, no entityId. Useful for incident timeline reconstruction ("admin opened the rotation surface at T, rotated at T+45s").

All three are best-effort `void` calls — audit-log insert failure never blocks the user-facing flow.

## Caller compatibility

The JSX prototype at `LMS GML Frontend/admin.jsx::SectionGates` (lines 285-325) renders four cards with `id`s `observation`, `mentorship`, `assessment`, `admin`. Our backend ships five gates (the four enum values from spec 008 plus `admin` from the spec-021 v2 migration). The card labelled `assessment` in the prototype is not yet a real enum value — we omit it for v1 and document the prototype-vs-backend drift in the page comments. A future spec can either add `assessment` to the `section_gate_slug` enum (migration required) or rename the prototype card to one of the existing slugs.

The "Rotate" button in the prototype is a styled `<button>` with no `onClick`; our implementation wires it through `RotateControls` as a real `<form>` submit so server-side validation always runs before any client-side modal renders.

The prototype's "Show" button (toggles the password input between `type="password"` and `type="text"`) is not implemented — the live database doesn't store the plaintext, so there's nothing to show. The "Rotate" flow is the only way to see a password, and only the freshly-generated one.
