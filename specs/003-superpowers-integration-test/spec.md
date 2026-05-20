# Spec 003 — Superpowers Integration Test

**Status:** in_progress
**Date:** 2026-05-20
**Constitution Check:** N/A (proof-of-discipline only)

## Overview

Ship a trivial endpoint (`GET /api/ping`) through the **full superpowers lifecycle** as the canonical example future specs follow. The endpoint itself is throwaway-trivial; the value of this spec is proving the harness end-to-end before we start real LMS features at spec 004.

## User Stories

**US1 (Harness self-check):**
As the developer (or a future Claude session), I can invoke `GET /api/ping` and confirm the app, routing, and Next.js standalone build are alive.
**Independent Test:** `curl http://localhost:3000/api/ping` → `{pong: true, ts: <iso>, spec: "003"}`.

**US2 (Discipline proof):**
As the project lead, I can read spec 003's ledger entry and see every step of the superpowers lifecycle was applied (brainstorm → plan → TDD red → green → verify → commit) on a real but trivial change. Sets the pattern.

## Functional Requirements

- **FR-001**: `GET /api/ping` returns JSON `{pong: true, ts: <iso8601>, spec: "003"}` with HTTP 200.
- **FR-002**: Route is at `apps/web/src/app/api/ping/route.ts`, follows Next.js App Router conventions, exports an async `GET` function.
- **FR-003**: Response shape validated by `@gml/shared/api-contracts/ping.ts` zod schema.
- **FR-004**: Governance test (`test_003_*.test.mjs`) hits the route file's contract (parse + key presence) without spinning up a dev server.

## Independent Test

```powershell
cd lms-app
pnpm test                                  # governance tests all green
pnpm --filter @gml/web dev                 # in another shell
curl http://localhost:3000/api/ping        # {pong:true, ts:..., spec:"003"}
```

## Out of scope
- Health checks per subsystem (already covered in spec 002 /api/health)
- API versioning (premature; revisit when public-facing routes ship)
