# Spec 108 — SM-5 Deploy Pre-flight Wrapper (Workflow Run 7 Tier D2)

**Status:** complete · **Date:** 2026-06-01 · **Phase:** Workflow Run 7 — Tier D (operational hardening)

## Why

Spec 091 introduced the SM-5 invariant: a production deploy MUST refuse to
start if the operator has not exercised the restore pipeline in the last
30 days. The mechanism was correct on paper —
`scripts/check-restore-drill.mjs` reads `workspace/last_restore_drill.json`
and `process.exit(1)`s if the stamp is older than 30 days when
`NODE_ENV=production`. The deployment audit for Workflow Run 7 surfaced
the gap: **nobody is calling that script.** `README-IT.md`'s step-3 deploy
instruction is the bare `docker compose up -d`, which sidesteps the gate
entirely. So the SM-5 moat exists in code but not on the operator's
runbook — exactly the kind of "configured but unenforced" failure mode a
postmortem six months from now would flag as the single root cause of a
backup-less restoration attempt.

The fix is deliberately the smallest possible wrapper: a one-file shell
script that runs the pre-flight, then `docker compose up -d`, then waits
for `/api/health` to return green, then runs migrations + seed_all. The
README-IT.md step-3 is rewritten to call this wrapper. The original
docker-compose commands are preserved verbatim under a "manual fallback"
subsection so an operator debugging a wedged stack can still drop down to
the primitives without losing institutional memory of what each step
does.

## What

A single wrapper script — `scripts/deploy.sh` — that chains the four
operations a fresh-deploy operator must run in sequence:

1. **Pre-flight** — `node scripts/check-restore-drill.mjs` (exits non-zero
   in production if the SM-5 stamp is stale). The bash `set -e` propagates
   the failure so docker compose never runs without a fresh restore drill.
2. **Boot** — `docker compose up -d` brings up all 7 services
   (postgres / redis / minio / tusd / app / worker / caddy).
3. **Wait for health** — a `curl` polling loop on
   `http://localhost:3000/api/health` (60 s timeout, 2 s interval) so we
   don't run migrations against a database that hasn't accepted its first
   connection yet. The app container's `/api/health` route also pings
   Postgres + Redis, so 200 OK means the dependencies are live too.
4. **Migrate + seed** — `docker compose exec -T app pnpm --filter @gml/db
   migrate` then `docker compose exec -T app pnpm --filter @gml/db exec
   tsx packages/db/src/scripts/seed_all.ts` (the spec-104 orchestrator).
   `-T` disables TTY allocation so the script works under cron / CI / SSH
   non-interactive shells.

The script's first line is `set -euo pipefail` — any single failure
aborts the whole sequence (no `|| true` swallows, no `set +e` islands).
This matches the failure semantics of `scripts/backup.sh` (spec 091, 109)
so an operator who's read one script already knows how the other behaves.

`README-IT.md` step 3 is rewritten to point operators at the wrapper:

```bash
# 3. Boot the stack with SM-5 pre-flight + health-wait + migrations
./scripts/deploy.sh
```

A "Manual fallback" subsection below preserves the original
`docker compose up -d` + `docker compose exec ...` commands verbatim, so
an operator debugging a partial-boot situation can run them one at a
time. The fallback explicitly notes that bypassing `./scripts/deploy.sh`
also bypasses the SM-5 gate — anyone reading the runbook sees the
trade-off in writing.

Optional convenience: a top-level `Makefile` with a `deploy` target that
just calls `./scripts/deploy.sh`. `make deploy` is a more discoverable
verb than a relative path; we expose both forms because Linux operators
reach for `make` reflexively and the bare path is what shows up in
copy-pasteable docs.

## Functional requirements

- **FR-001** — `scripts/deploy.sh` exists, is executable (`chmod +x`), and
  starts with the shebang `#!/usr/bin/env bash`. Not `/bin/sh` — we want
  bash arrays + `pipefail`, which are bash-isms.
- **FR-002** — Line 2 (modulo blank lines / comments) is
  `set -euo pipefail`. The `-u` catches typo'd variable references, `-o
  pipefail` makes `failing-cmd | tee` actually fail the script.
- **FR-003** — The script calls `node scripts/check-restore-drill.mjs`
  BEFORE the `docker compose up` invocation. Ordering is verified in the
  governance test by the relative offset of the two substrings in the
  file's source.
- **FR-004** — The script invokes `docker compose up -d` (detached mode —
  the script returns control to the operator after health-wait).
- **FR-005** — Between `docker compose up` and the migration step, the
  script polls a `curl` against `/api/health` until it returns 200 or 60 s
  elapses, whichever comes first. On timeout, the script exits non-zero
  with a recognisable message ("app failed to become healthy in 60s") so
  the operator can `docker compose logs app` for the cause.
- **FR-006** — The script invokes `docker compose exec -T app pnpm
  --filter @gml/db migrate` after health passes.
- **FR-007** — The script invokes the spec-104 orchestrator via
  `docker compose exec -T app pnpm --filter @gml/db exec tsx
  packages/db/src/scripts/seed_all.ts` (NOT the older single-script
  `seed.ts` form). This keeps deploy.sh in sync with the canonical seed
  entry-point.
- **FR-008** — On overall success, the script `echo`s a recognisable
  success message (e.g. `[deploy] stack is up`) so the operator's terminal
  scrollback makes the outcome unambiguous.
- **FR-009** — `README-IT.md` step 3 references either `./scripts/deploy.sh`
  or `make deploy`. The literal `docker compose up -d` text remains in the
  document but is moved under a "Manual fallback" / "manual" subsection
  with an explicit SM-5-bypass warning.
- **FR-010** — `Makefile` (optional) exists at the repo root with a
  `deploy:` target whose recipe calls `./scripts/deploy.sh`. If we ship
  the Makefile, the governance test will check the target; if we ship
  only the script, the governance test passes via the README-IT.md
  reference clause.

## Acceptance criteria

| Behaviour | Verification |
| --- | --- |
| Stale drill blocks deploy | `NODE_ENV=production ./scripts/deploy.sh` with a 35-day-old stamp exits 1 before docker runs |
| Fresh drill allows deploy | Stamp written `5 days ago` → script runs full chain end-to-end |
| Non-prod skips pre-flight | `NODE_ENV=development ./scripts/deploy.sh` runs the chain without checking the drill stamp |
| Health-wait timeout surfaces | If the app container fails to bind :3000, the script aborts after 60 s with a clear message (not an indefinite hang) |
| README-IT.md still useful for manual recovery | The original docker-compose commands are preserved in a "Manual fallback" block |
| Governance test green | `pnpm test -- tests/governance/test_108_sm5_deploy_preflight.test.mjs` passes ≥ 6 assertions |

## Out of scope

- A `deploy:rollback` Makefile target or a script that reverts to a
  previous image tag. Rollback is currently `git revert + git pull +
  docker compose up -d --build` and that's documented in the upgrades
  section of README-IT.md. A dedicated rollback script is its own spec.
- A `deploy:status` health-check command. The `/api/health` endpoint is
  the source of truth and operators can `curl` it directly.
- A `make build` / `make test` / `make lint` set of Makefile targets.
  Those are `pnpm` commands and adding Make aliases just doubles the
  surface area. Only `deploy:` ships here because the deploy chain has
  multiple sequential steps a single `pnpm` script can't model cleanly.
- Healthcheck retries with exponential backoff. A flat 2-second polling
  interval is fine for a single-host VPS where the bottleneck is
  postgres-cold-start (~5-10 s), not network jitter.
- Integration with systemd, Nomad, or Kubernetes. This is a Docker
  Compose deploy. If we ever move to k8s the wrapper is replaced by a
  Helm chart's `helm install --wait`, which has its own SM-5 hook
  mechanism (a Job kind).
- Notifying Slack / PagerDuty / email on failure. The operator is
  watching the terminal when they run `./scripts/deploy.sh`; nightly
  unattended runs are a future spec if we ever set up scheduled deploys.

## Design deviations

None. The wrapper is a thin glue script — every line is either a literal
command an operator would otherwise type by hand, or the `set -euo
pipefail` boilerplate that makes the chain abort-on-first-failure. There
is no clever orchestration to deviate from; the spec is "concatenate
these four commands behind one entrypoint."
