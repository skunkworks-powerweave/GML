# Research — spec 167 defensive-coding fixes

## D-001 — Why `throw` instead of upgrading `console.error` to a different
## logger?

A switch from `console.error` to a structured logger (e.g.
`logger.error`) would still rely on a developer noticing the message
scroll past. The audit explicitly flagged the issue as "loud enough for
tests / dev to crash, silent in production" — that's the precise
behaviour of a guarded `throw`:

```ts
if (process.env.NODE_ENV !== "production" && action && onSubmit) {
  throw new Error("FormRenderer: pass either `action` or `onSubmit`, not both.");
}
```

- In **test** (NODE_ENV=test → not "production" → throws): jsdom
  rethrows, vitest fails the test, the contributor sees the regression
  in CI before merge.
- In **dev** (NODE_ENV=development → not "production" → throws): React
  surfaces the error boundary card with the message, instantly visible.
- In **prod** (NODE_ENV=production → guard false → no throw): the render
  proceeds; the `action` wins by virtue of being declared on the `<form>`
  element while `onSubmit` runs only its validation half. Worst case the
  user sees both submit paths fire — a known degradation, but better
  than a crashed page.

Alternative considered: `console.error + Sentry breadcrumb`. Rejected
because Sentry is not wired in this LMS deployment (the SOC-2 plan calls
for self-hosted alternatives) and adding it just to surface this guard
would be a 200-line yak-shave.

## D-002 — Why export `BCRYPT_COST` instead of a `getBcryptCost()` getter?

A getter introduces an indirection that's invisible at the call site (no
import-traceable origin) and doesn't compose with the `bcrypt.hash(s, n)`
positional argument. The literal const composes naturally:

```ts
import { BCRYPT_COST } from "@/lib/password";
const hash = await bcrypt.hash(secret, BCRYPT_COST);
```

A getter would force callers to `await getBcryptCost()` even though the
value is fundamentally a compile-time constant. Rejected.

The cross-workspace boundary (seed.ts in `packages/db` can't import from
`apps/web`) is closed by a paired inline comment + a governance-test
assertion that both literals say `10` and the seed has the mirror note.
A future cost bump to 12 will fail the test on the seed side, forcing
the contributor to edit both files. That's the cheapest correctness
guarantee that doesn't require a third workspace package.

## D-003 — Why `noteAuditDegraded` rather than rolling the counter into
## `recordAudit` itself?

`recordAudit` already returns `false` on failure (spec 141). Adding the
counter increment inside `recordAudit` would tally every miss, including
the legitimate `void recordAudit(...)` calls in low-stakes paths where
the caller has decided to discard the boolean. Those misses are
expected fail-soft behaviour and don't represent "high-stakes audit
degradation". A counter that ticks on every low-stakes miss too would
be too noisy to alert on.

Keeping the counter behind an explicit `noteAuditDegraded(callsite)`
call means only the call sites that the spec deems high-stakes
contribute to the metric. The callsite tag itself is the alerting
discriminator — "the gate-rotate audit is failing" is a different ops
response from "the learners-export audit is failing".

## D-004 — Counter persistence and resets

The counter is process-local. Across a deploy or a hard restart the
count resets to 0. That's by design: the counter is a within-process
alerting signal, not a long-term forensic record (the forensic record
IS the audit_log table, which the counter exists to detect outages of).
A future enhancement could expose `/metrics` for Prometheus to scrape,
at which point the metric becomes a `audit_degraded_total{callsite="..."}`
counter that Prometheus persists across restarts. For today, the
in-process tally + `console.error` is enough.

The `__resetAuditDegradedCountForTests` hook is exported so the
governance test can isolate counts between runs without exposing a
setter to production. The name's double-underscore prefix marks it as
test-only; the export shape is unusual enough that a code reviewer
seeing it imported from a non-test file would flag the use.

## D-005 — Why capture only on these four routes, not all 18 `recordAudit`
## callers?

The audit explicitly named four high-stakes flows. Expanding to all 18
would balloon the spec; each route also has its own ergonomics
question (e.g. the whatsapp webhook handler runs in a fire-and-forget
queue context where the caller can't react to a degraded write because
the originating WhatsApp request has already been ACKed).

The four chosen are:

1. **Gate rotation** — the password-rotation forensic trail is the only
   record of compromised-credential containment. Audit miss = silent
   containment-event loss.
2. **Learners bulk export** — SM-9 PII bulk-export. Audit miss = silent
   PII exfiltration trail loss.
3. **Audit-log export** — recursively meta. Audit miss = nobody knows
   the audit log was exported.
4. **Password reset** — auth-mutating event. Audit miss = silent
   account-takeover trail loss.

A future spec can extend to other call sites (helpdesk PII writes,
mentor CSV export, etc.) once a consistent shape is proven across the
four flagged today.
