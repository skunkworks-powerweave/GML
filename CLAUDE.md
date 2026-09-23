# GML LMS — Project Context for Claude Code

## Project

Custom LMS for Goldenmile Learning's RTT (Refresher Teacher Training) programme in Ladakh-UT. Low-bandwidth-aware, Postgres-backed, self-hostable via single `docker compose up -d`. Internal use only — never SaaS.

Three core surfaces: **Classroom Observation** (baseline / developmental / evaluative), **RTT Phases 1-3** (district → zone → term → subject), **Mentorship** (~150 meeting recordings + Q1/Q4 mentee videos).

Hard requirements: Postgres backend; section-level rotatable passwords; audit log; two video paths (direct upload + WhatsApp Business webhook); admin-editable no-code tables; mobile-friendly.

## Plan + Ledger

**New work lives in [`docs/superpowers/`](docs/superpowers/README.md).** A design
under `docs/superpowers/specs/`, a plan under `docs/superpowers/plans/`, a
worktree, a test that fails first, and the evidence the gates ask for. That
README is the contract — read it before starting anything.

**The historical plan and ledger are outside this repository and unmaintained.**
They sit next to the checkout at `D:\GML\PLAN.md` and `D:\GML\PROGRESS.md`. This
section used to link them as `../PLAN.md` and `../PROGRESS.md`; those resolve to
a parent directory that a clone does not have, so the links were dead for
everyone but the one machine they were written on — and the "canonical" path
quoted beside them pointed into a different user's home directory, which is
worse than a dead link because it looks live. Both were removed rather than
repaired: the files are not in the repository and no link from inside it can
reach them.

The ledger was last written 2026-09-18, and its status board still describes a
95-spec catalogue with 28 done. Read it as an archive, never as the state of the
repository. Phase 5 of the enforcement work moves what is worth keeping into
`docs/history/`.

For the live state, ask the tree: `git log`, the receipts in
`workspace/test-receipts.jsonl`, and the SessionStart hook, which is allowed to
print only what it reads at that moment.

## Specs (spec-kit)

**`specs/` is HISTORY.** It is a record of what was intended, useful for
archaeology and for nothing else. New work does not go there; it goes through
[`docs/superpowers/README.md`](docs/superpowers/README.md).

This section used to say every feature is a numbered folder with five files
(`spec.md`, `plan.md`, `research.md`, `quickstart.md`, `tasks.md`) plus
`contracts/`, and that 153 specs exist on disk. Measured against the tree:

- **132** numbered directories exist, not 153.
- **126** of them have all five files; the remaining 6 have four.
- **Zero** `contracts/` directories exist anywhere under `specs/`.
- **39** spec numbers between 001 and 153 have no directory at all. Among them
  are 036–045, which the ledger schedules as the video pipeline, and 057–063,
  the first half of its core pages. `git log --all --diff-filter=A` finds no
  commit that ever added a file under any of them: they were directories with
  nothing in them, and git cannot track an empty directory, so they do not
  exist in a clone and never did.
- **264** task checkboxes are still unticked across the 132 `tasks.md` files
  (427 are ticked), while **26** `spec.md` headers declare `Status: complete`
  and 45 declare `in_progress`.

So the corpus does not describe the code, and its own completion markers
disagree with its own checkboxes. Treat every number in it as a claim that was
never checked — which is exactly what it is.

## Harness

1. **Workflow contract** — [`docs/superpowers/README.md`](docs/superpowers/README.md).
   Brainstorm → design → plan → worktree → test-driven development →
   verification → code review → PR → merge, with a table saying what evidence
   each kind of change has to produce.

   This replaces the line that stood here from the first commit, claiming the
   project ran `brainstorming → writing-plans → test-driven-development →
   verification-before-completion → requesting-code-review →
   finishing-a-development-branch` **for every spec**. Three audits checked that
   claim against the tree and it was false for all six steps: no design document
   exists; none of the 132 `plan.md` files carries the writing-plans header; all
   37 commits that add a governance test also change `apps/` or `packages/` in
   the same commit, so no test has ever existed before its code; no code review
   is recorded anywhere; and of 90 commits exactly one has two parents — the
   history is otherwise a straight line onto the integration branch, with no
   worktree taken before 2026-09-24.
2. **Gates** — `.claude/settings.json` wires six hooks in `.claude/hooks/` (see
   Hooks below). They are what makes item 1 a rule rather than a wish.
3. **Test receipts** — `scripts/test-gate.mjs` runs the suites and appends a
   receipt to `workspace/test-receipts.jsonl` recording which suites ran, what
   they returned, and a fingerprint of the working tree they ran against. The
   commit gate reads receipts, because "the tests pass" is a claim about a
   moment and a receipt is a claim about a tree.
4. **Spec-kit corpus** — `specs/`, history (see Specs above). The append-only
   ledger it was paired with lives outside the repository and is unmaintained
   (see Plan + Ledger above).
5. **Substrate moats** — SM-1..SM-9 invariants defended at multiple layers. Defined in [`docs/substrate-moats.md`](docs/substrate-moats.md) (SM-7/8/9 were cited in ~40 source files and defined nowhere until that doc was written).

## Hooks

Configured in [`.claude/settings.json`](.claude/settings.json); wiring notes in
[`.claude/hooks/README.md`](.claude/hooks/README.md). Six hooks, all sharing
`.claude/hooks/_lib.mjs`.

| Event · matcher | Hook | What it actually enforces |
|---|---|---|
| SessionStart | `session-start.mjs` | Prints only facts read live at that moment — repo path and whether the session started inside it, branch, working-tree state, the newest test receipt and whether it still matches the tree, open PRs, plan in progress. No cached counts: the script it replaces read a state file last written 2026-06-01 and opened every session with three wrong numbers. |
| PreToolUse · Bash | `pre-bash.mjs` | **Refuses, no override:** `rm -rf`, `DROP TABLE`, `DROP DATABASE`, `TRUNCATE`, `docker compose down -v`, `docker volume rm`, `git reset --hard`, `git clean -fd`, `git stash drop`/`clear`. **Refuses a `git commit`** that runs outside this tree, that targets `main`/`master`, or that has no green receipt in `workspace/test-receipts.jsonl` whose tree fingerprint equals the tree being committed (a stale or failing receipt is named as such). Parses the command into segments and matches on tokens, so `git -C . commit` and `FOO=1 sudo rm -rf` are seen. |
| PreToolUse · Edit\|Write\|MultiEdit | `pre-edit.mjs` | **Refuses, no override:** writes to `.env` and `.env.*` (except `.env.example`) and to generated drizzle snapshots under `packages/db/src/migrations/meta/`. **Refuses, overridable:** edits on `main`/`master`, and edits to `apps/*/src/**` or `packages/*/src/**` when nothing in the working tree shows a test alongside. It matches `tool_input.file_path` itself. |
| PostToolUse · Edit\|Write\|MultiEdit | `post-edit.mjs` | Migration hygiene, advisory (a PostToolUse cannot undo a write). Flags a `DROP TABLE`/`DROP COLUMN` with no `-- irreversible:` justification, a `CREATE INDEX CONCURRENTLY` that the transaction-wrapping runner will reject at deploy time, a migration absent from `meta/_journal.json` and therefore never run, and a `_post/` file declaring an object the drizzle schema also declares. |
| PostToolUse · Bash | `post-bash.mjs` | Advisory. Meant to catch source files written *through a shell* — heredoc, `sed -i`, `cp`, a generator, `git checkout -- .` — which no Edit hook ever sees. It does so by diffing `git status` against `workspace/.status-snapshot`, and it stays silent whenever that file is absent. **`pre-bash.mjs` does not currently write it**, so this hook reports nothing today. |
| Stop | `stop.mjs` | Appends this session's line to `workspace/session_log.md`, including any overrides taken. Blocks **once per session** (exit 2) when source files are uncommitted with no green receipt for that exact tree, and offers four ways forward. Three separate brakes against a block/resume loop, starting with `stop_hook_active`. |

**The six hooks this replaces enforced nothing.** Two reasons, both checked
against the installed Claude Code binary rather than documentation, zero
occurrences each: the Bash hook was invoked as
`node scripts/block_destructive.mjs "$TOOL_INPUT"` and there is no `$TOOL_INPUT`
— the payload arrives as JSON on stdin, so `argv[2]` was always empty and the
project's only blocking hook matched nothing for its entire life; and the three
"path-scoped" Edit/Write hooks used a `pathGlob` key that is not a config field,
so they fired on every single edit instead.

**The proof they never loaded at all:** the old `Stop` script appended to
`workspace/session_log.md` unconditionally — there was no branch through it that
skipped the write. That file is 112 bytes, header only, with an mtime equal to
its creation time of 2026-09-18 12:57, and 52 commits have landed since. A hook
that ran once would have left a line.

Hook configuration is read from the directory the **session** started in. Start
Claude Code in the repository root or in a worktree under it — started anywhere
else, none of the above applies and the session looks exactly like one in which
every gate happened to pass.

## Folder map

```
lms-app/
├── apps/web/             ← Next.js 16
├── apps/worker/          ← ffmpeg + Postgres-queue consumer
├── packages/db/          ← Drizzle schema, migrations, job queue
├── packages/ui/          ← shadcn re-exports
├── packages/shared/      ← zod schemas, utils, types
├── specs/                ← 132 spec folders; HISTORY, not the plan
├── workspace/            ← runtime state: receipts, gate logs, session log (gitignored)
├── .worktrees/           ← one worktree per branch/PR (gitignored)
├── .claude/settings.json ← hook wiring
├── .claude/hooks/        ← the six hooks + _lib.mjs
├── scripts/              ← deploy.sh, backup.sh, restore.sh, rollback.sh,
│                            preflight.sh, verify-tls-local.sh,
│                            check-restore-drill.mjs, test-gate.mjs
├── docker/               ← Dockerfiles + Caddyfile
├── docs/superpowers/     ← the workflow contract, + specs/ and plans/ for new work
├── docs/                 ← architecture / verification / operations / audit-actions
│                            / substrate-moats
└── tests/                ← governance (text) · behaviour (real Postgres)
                             · scripts (dry-run) · hooks · integration (booted stack)
```

`scripts/ship.ps1` was listed here and has never existed in this repository. The
hook scripts that were listed here are gone too: hooks now live in
`.claude/hooks/`.

## Current state (read this before trusting anything above)

The sections above describe the harness and the original plan. What is actually
deployed differs in ways worth knowing:

- **Auth is Supabase**, not Auth.js. `auth()` keeps its old signature; the
  implementation behind it changed completely. See `docs/architecture.md`.
- **There is no local Postgres, Redis, MinIO or tusd.** Four containers:
  `caddy`, `app`, `worker`, `migrate`.
- **`middleware.ts` is `proxy.ts`** (Next 16 renamed the convention; proxy runs
  on the Node runtime and that is not configurable).
- **Tests are in three tiers and they are NOT interchangeable.**
  `tests/governance/` regex-matches source text and cannot observe a runtime
  behaviour — it was green for months while the app could not boot.
  `tests/behaviour/` executes real code against a real Postgres.
  `tests/integration/` drives a running deployment.

## Locked-in decisions (do not re-litigate without explicit sign-off)

1. Postgres (not MariaDB / MySQL / MongoDB) — non-negotiable.
2. Custom build (not Frappe / CourseLit / Open edX / Canvas) — see [`../PLAN.md` § "LMS base evaluation"](../PLAN.md).
3. WhatsApp Business Cloud API is the **primary** low-bandwidth video path.
4. Hosting: single AWS EC2 instance running `docker compose`, with Supabase for Postgres/Auth/Storage. (Superseded the original 'Cloud VPS' decision when MinIO withdrew their public Docker images and the self-hosted stack became unbootable.)
5. v1 scope is FULL: quizzes, SCORM, seed data, en/hi/bo i18n.
6. Internal use only — AGPL is not a concern.

## Reference repos (clones at `C:\Users\himan\OneDrive\Desktop\Repos\`)

- `frappe-lms` — borrow DocType-style admin patterns; do NOT use as base (MariaDB-locked)
- `courselit` — borrow shadcn admin shell + dual app+queue split; do NOT use as base (Mongoose-locked)
- `canvas-lms` — borrow `enrollments`/`submissions`/`gradebook_csv_export` schema patterns; do NOT use as base (Rails + 8GB-dev-floor)
- `edx-platform` — borrow nothing major; ruled out (MySQL-only)
