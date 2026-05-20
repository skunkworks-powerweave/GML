# Spec 001 — Harness Scaffold

**Status:** in_progress
**Date:** 2026-05-20
**Author:** GML LMS team
**Constitution Check:** N/A (scaffolding spec — substrate moats land in 011)

---

## Overview

Establish the empty `lms-app/` workspace and harness wiring so every subsequent spec has a consistent home. This spec creates the directory layout, pnpm workspace config, Next.js 15 app skeleton, `.claude/settings.json` with the 6 project hooks, `workspace/` runtime dir, and the first append-only ledger entry in `PROGRESS.md`. No business logic, no DB, no auth — those land in later specs.

---

## User Stories

**US1 (Developer — clean start):**
As the GML LMS developer, when I open `C:\Users\himan\OneDrive\Desktop\GML\lms-app\` I see a complete monorepo skeleton (apps/web, apps/worker, packages/*, docker/, docs/, scripts/, specs/, workspace/, tests/) plus a working pnpm workspace, so I can begin spec 002 without setup friction.
**Independent Test:** Run `pnpm install` from `lms-app/`; it completes without errors. Run `pnpm --filter @gml/web dev` (after 002 ships docker); the Next.js app's dev server starts on localhost:3000 and serves a default page.

**US2 (Developer — harness wired):**
As the developer, when a Claude Code session starts inside `lms-app/`, the `SessionStart` hook fires and prints a one-line progress summary (e.g. `Spec 001 in_progress — 0 / 70 done`).
**Independent Test:** Run `node scripts/session_start.mjs` from `lms-app/` — prints a summary line based on `workspace/state.json` and `PROGRESS.md`. Exit code 0.

**US3 (Future-developer — discoverable):**
As a future developer (including a Claude Code session weeks later), reading `lms-app/CLAUDE.md` gives me enough context to navigate the project: where specs live, how the ledger works, where the substrate moats are documented, where the 6 hooks fire.
**Independent Test:** Open `lms-app/CLAUDE.md` — it links to PROGRESS.md, specs/, the substrate-moats doc placeholder, and the 6 hook scripts. No 404 links.

**US4 (IT — eventual handover):**
As GML's IT team, when I unzip the final release I see a 1-page `README-IT.md` and an obvious entry point. (Just the *placeholder* lands in 001; full content lands in spec 069.)
**Independent Test:** `lms-app/README-IT.md` exists, is < 200 lines, references `docker-compose.yml` (file may not exist yet — spec 002), and points to PLAN.md.

---

## Functional Requirements

- **FR-001 (Folder layout)**: create the directory tree exactly as listed in PLAN.md § "Folder layout".
- **FR-002 (pnpm workspace)**: `package.json` at root declares `private: true`, workspaces `apps/*` and `packages/*`, `packageManager: pnpm@10.x`. `pnpm-workspace.yaml` lists the same.
- **FR-003 (Next.js app)**: `apps/web` initialised with `create-next-app` for Next.js 15 + App Router + TypeScript + Tailwind, name `@gml/web`.
- **FR-004 (Empty packages)**: `packages/db`, `packages/ui`, `packages/shared` each get a minimal `package.json` so pnpm recognises them as workspaces; no source code yet.
- **FR-005 (Worker app placeholder)**: `apps/worker` gets a stub `package.json` (no entry point yet — that lands in spec 024).
- **FR-006 (.claude/settings.json)**: contains the 6 hooks specified in PLAN.md § "Hooks". Each hook references a script under `scripts/` that may be a stub (real logic in later specs) but must exit 0.
- **FR-007 (workspace/ runtime dir)**: `workspace/state.json` exists with `{currentSpec: "001", phase: 0, specsCompleted: 0, specsTotal: 70}`. `workspace/session_log.md`, `workspace/marathon_log.md` exist as empty files with a header line.
- **FR-008 (scripts/)**: `session_start.mjs` reads `workspace/state.json` + `PROGRESS.md` and prints a one-line summary; exit 0.
- **FR-009 (CLAUDE.md)**: project-context doc with sections: Project, Plan + Ledger, Specs, Harness, Hooks, Folder map. Links resolve.
- **FR-010 (Placeholders)**: `README.md`, `README-IT.md`, `.env.example`, `.gitignore`, `docs/substrate-moats.md` (placeholder), `docs/verification.md` (placeholder), `docs/architecture.md` (placeholder), `docs/operations.md` (placeholder) all exist.
- **FR-011 (PROGRESS ledger entry)**: append to `C:\Users\himan\OneDrive\Desktop\GML\PROGRESS.md` (the existing file) the spec 001 COMPLETE block at the bottom.
- **FR-012 (git init)**: run `git init` inside `lms-app/`; `.gitignore` includes `node_modules`, `.next`, `.docker-volumes`, `workspace/`, `*.local.*`. No initial commit yet (waits for spec 002 so docker-compose lands in the same commit).

---

## Security Constraints

- **SC-001**: `.env.example` documents required env-var names but never contains real values.
- **SC-002**: `workspace/` and any `*.local.*` are git-ignored. Real secrets never reach git.
- **SC-003**: `.claude/settings.local.json` is git-ignored; per-machine overrides do not leak.

---

## Independent Test (composite)

```powershell
cd C:\Users\himan\OneDrive\Desktop\GML\lms-app
pnpm install                                           # FR-002 + FR-003 + FR-004 + FR-005
node scripts/session_start.mjs                         # FR-008 — should print one line, exit 0
git status                                             # FR-012 — should show untracked files
Get-Content workspace/state.json | ConvertFrom-Json    # FR-007 — should parse to {currentSpec:"001", ...}
```
All four commands exit 0. The ledger entry appended to `GML/PROGRESS.md` documents this spec's closure.

---

## Out of scope (for this spec)

- Drizzle schema → spec 004
- Auth.js → spec 005
- docker-compose.yml → spec 002 (next spec; intentionally split to keep this scaffold-only)
- Initial git commit → spec 002 (so docker-compose lands in the same commit as the scaffold)
- Substrate moat enforcement → spec 011
- Any real business logic — every spec from 004 onwards
