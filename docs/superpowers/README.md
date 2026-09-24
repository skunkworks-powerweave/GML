# The workflow contract

This is the contract for **new** work in this repository. It is not a
description of how the project has been built; it is the thing that replaces
how the project has been built.

Everything under `specs/` is history (see CLAUDE.md § Specs). Nothing here
retrofits it. From the point this file lands, a change either arrives through
the pipeline below or it arrives with an override that says, in writing, which
step was skipped and why.

---

## Why a contract, rather than a description

CLAUDE.md has claimed since the first commit that this project follows
`brainstorming → writing-plans → test-driven-development →
verification-before-completion → requesting-code-review →
finishing-a-development-branch` **for every spec**. The claim was checked
against the repository, step by step. It was false for all six:

| Step | Claimed | Measured in this repository |
| --- | --- | --- |
| brainstorming | per spec | No design document exists. `docs/` holds `architecture.md`, `audit-actions.md`, `operations.md`, `substrate-moats.md`, `verification.md` — five cross-cutting documents, none of them a design for a feature. |
| writing-plans | per spec | 132 `plan.md` files exist and **none** carries the writing-plans header (Goal / Architecture / Tech Stack, bite-sized checkbox steps, exact paths, a commit step per task). |
| test-driven-development | per spec | 37 commits add a `tests/governance/*.test.mjs` file. All 37 also add or change code under `apps/` or `packages/` **in the same commit**. Zero test-only commits: no test in this project's history has ever existed before the code it tests. |
| verification-before-completion | per spec | 264 task checkboxes are still unticked across the 132 `tasks.md` files (443 are ticked). No `spec.md` in the corpus contains a checkbox at all: the **26** is a count of `spec.md` headers declaring `Status: complete`, and one of those 26 folders (`specs/150-middleware-401-vs-403/`) still carries **3** unticked boxes in its `tasks.md`. |
| requesting-code-review | per spec | No review is recorded anywhere in the repository. |
| finishing-a-development-branch | per spec | Of **91** commits (`git rev-list --count HEAD`) exactly **one** has two parents (`git rev-list --count --merges HEAD`), and that merge is dated 2026-09-24. The history is otherwise a straight line onto the integration branch, and `.worktrees/` did not exist before that date. |

A discipline that is written down and enforced by nothing is not a discipline,
it is a wish. The gates in `.claude/hooks/` exist so that the table above cannot
be true of the next 90 commits, and this file is what they are enforcing.

---

## The pipeline

### 1. Brainstorm, and write the design down

Argue the shape of the thing before any of it is typed. The output is a design
document:

```
docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md
```

It records the problem, the options considered, the option chosen, and what
would have to be true for the choice to be wrong. A design document that lists
only the option taken is a summary, not a design: the value is in the rejected
branches, because those are what a later reader re-proposes when they do not
know they were already considered.

Small, obvious changes do not need one. "Obvious" means you can say in one
sentence why there was no decision to make, and that sentence goes in the PR.

### 2. Write the plan

```
docs/superpowers/plans/YYYY-MM-DD-<name>.md
```

The plan opens with the writing-plans header, in this order:

- **Goal** — what is true when this is done, in terms someone can check.
- **Architecture** — the pieces, and which existing code each one touches.
- **Tech Stack** — what it is built from, including anything new being
  introduced and why the existing thing was not enough.

Then bite-sized steps, each one a checkbox, each one carrying:

- the **exact file path** it changes — not "the queue module";
- the **complete code** for the change, not a description of it;
- the **test that comes first**, with the failure it is expected to produce;
- a **commit step** ending the task.

The size test for a step: one step, one commit, one reviewable diff. If a step
cannot say what its commit message would be, it is two steps.

This is the part with no precedent in the repository — all 132 existing
`plan.md` files are prose. A plan whose steps are prose cannot be executed by
anything that has to check its own work, which is why every one of them was
"executed" by writing the code and the test together.

### 3. Take a worktree

```
git worktree add .worktrees/<slug> -b <type>/<slug>
```

Never work on `main`. `.claude/hooks/pre-edit.mjs` refuses an edit on `main` or
`master` and hands back this exact command, because a gate that says "use a
branch" and leaves you to remember the invocation gets skipped out of
impatience rather than disagreement.

`.worktrees/` is gitignored, so a worktree's contents can never be committed
into the repository that contains it.

### 4. Test-driven development — the test fails first, and you watch it fail

The order is not negotiable and it is not a formality:

1. Write the test.
2. **Run it. Watch it fail.** Keep the actual `not ok N - <name>` line and its
   error text — that text goes in the PR.
3. Write the smallest code that makes it pass.
4. Run it again. Watch it pass.

Step 2 is the one this project has never done, and the cost is measurable: at
least 28 assertions in the existing suite pin a defect in place rather than
catching one, because they were written against code that already behaved that
way. A test that has never been seen failing is an assertion that the code does
what it does.

Run tests through the gate, never by hand:

```
pnpm test                      # governance + scripts + hooks
node scripts/test-gate.mjs behaviour
```

`scripts/test-gate.mjs` writes a **receipt** to
`workspace/test-receipts.jsonl` recording which suites ran, what they returned,
and a fingerprint of the exact working tree they ran against. "The tests pass"
is a claim about a moment; a receipt is a claim about a tree. The commit gate
reads receipts, not assertions.

### 5. Verification before completion

Done means demonstrated. Before a change is called finished:

- the suites its evidence row requires have run green **against the tree being
  committed** (a receipt whose fingerprint no longer matches the tree is stale
  and the commit gate will say so);
- every checkbox in the plan is ticked, or the plan is amended to say why not;
- the **mutation check** has been done where the table below requires it:
  revert one hunk of the implementation, re-run, and confirm a test fails. A
  test that still passes with the code removed is measuring nothing.

### 6. Code review

The diff is read by something other than the agent that wrote it. Findings go
in the PR, one line each. `none` is a finding and needs a sentence saying what
was examined — "no findings" without a scope is indistinguishable from "not
looked at".

### 7. Pull request

`.github/pull_request_template.md` asks for evidence, not description, and its
sections are the sections below: plan link, RED evidence, GREEN evidence,
mutation check, review, verification output, overrides used. Delete nothing; a
section that does not apply gets `n/a` and one line saying why.

The PR body must carry a `Review-Verdict:` line whose value is the single word
`approved`. The template ships that field reading `pending`; the reviewer is
what changes it, and nothing else in the body should mention it.

The hook is weaker than that sentence, and this file used to claim otherwise.
`.claude/hooks/pre-bash.mjs` matches `/Review-Verdict:\s*approved/i` —
**unanchored**, so a qualified verdict and even prose merely discussing the
field satisfy it (finding I6, being anchored to
`/^[ \t]*Review-Verdict:[ \t]*approved[ \t]*$/im`). Until that lands, the field
is kept honest by the person filling it in rather than by the gate. The one
thing now pinned is that the default template no longer approves itself:
`tests/hooks/template-not-self-approving.test.mjs`.

### 8. Merge

Merge the PR; do not push to `main`. The branch and its worktree go away
afterwards:

```
git worktree remove .worktrees/<slug>
git branch -d <type>/<slug>
```

---

## Evidence per artefact

This table is the **convention a reviewer checks**. What you changed determines
what you must be able to show; there is no artefact class whose evidence is "I
read it carefully".

It is not what the commit gate enforces. This paragraph used to say it was, and
that was the same defect as everything else on this page: a control described as
installed, enforcing something narrower than its description. The gate's actual
rules are listed under the table — read both, because the gap between them is
the part only a human closes.

| Artefact changed | Evidence required |
| --- | --- |
| TS/TSX product code (`apps/**`, `packages/**`) | A `tests/behaviour` test that **fails first**, then passes. Governance tests do not count here: `tests/governance/` regex-matches source text and was green for months while the application could not boot. |
| `scripts/*.sh`, `docker/**` | A `tests/scripts` test that drives the script in **dry-run**, failing first. Never a real deploy, restore or `docker compose` from a test. |
| Governance test edits (`tests/governance/**`) | A **mutation check pasted in the PR**: name the hunk reverted and the test that failed as a result. Editing an assertion is the one change that can make a suite greener by making it weaker, so it is the one change that must prove it still constrains something. |
| Docs, comments (`docs/**`, `*.md`, comment-only diffs) | Reviewer, plus any doc-sync test that covers the claim. A doc that states a number or a path the tree can be asked about should be asked. |

The phrase "fails first" in the first two rows means the literal failing output
in the PR, not a statement that it failed. Nothing in the tree can check that,
which is why it is in this table and not in the list below.

### What the gates actually check

Measured by spawning the hooks against sandbox repositories, not by reading
them. All of it is narrower than the table above:

- **`pre-bash.mjs`, on `git commit` — "test with code".** If anything under
  `apps/**`, `packages/**`, `scripts/*.sh` or `docker/**` is staged, then at
  least one staged path must begin with `tests/`. That is the entire rule. It
  does not look at the tier, at the file's contents, or at whether the file is a
  test: staging an **empty `tests/anything.txt`** beside
  `apps/web/src/lib/authz.ts` clears it (measured — the hook exits 0), and so
  does a `tests/governance/` file beside runtime code.
- **`pre-bash.mjs`, on `git commit` — receipt.** A receipt must exist, have
  exited 0, recorded at least one suite that actually RAN, and carry a tree
  fingerprint equal to the tree being committed. The fingerprint covers HEAD,
  the worktree diff, the INDEX and untracked files — the index because
  `git commit` writes it, and HEAD because without it every clean tree
  fingerprinted to `sha256("")` and one green receipt satisfied them all.
- **`pre-bash.mjs`, on `git commit` — no-database runs.** If the staged set
  touches `apps/**` or `packages/**` and the receipt is marked `noDb`, the
  commit is refused, because a run without `DATABASE_URL` never executed
  `tests/behaviour/`. This is the only point at which the tier distinction
  reaches a commit, and it is a statement about the RUN, not about which file
  you staged.
- **`pre-edit.mjs`, on an Edit/Write — the behaviour tier.** Required, but only
  on five named files — `apps/web/src/proxy.ts`, `apps/web/src/lib/authz.ts`,
  `apps/web/src/lib/gates.ts`, `apps/web/src/lib/rate-limit.ts`,
  `apps/web/src/lib/request-ip.ts` — plus anything under
  `packages/db/src/schema/`. There the touched test must live in
  `tests/behaviour/` or `apps/web/tests/behaviour/`. Every **other** source file
  is cleared by a touched test at any tier (measured: editing
  `apps/web/src/lib/report.ts` with only `tests/governance/` touched exits 0).
- **Every rule above is overridable** with `GML_GATE_SKIP` — measured one by
  one, each logging its own rule name: `commit-receipt` (for the missing, stale
  and `noDb` cases alike), `test-with-code`, `security-surface-behaviour-test`
  and `test-first`. The `pre-edit.mjs` rules are additionally cleared by a RED
  receipt on the branch or a live `workspace/tdd-exempt.json` exemption. The
  destructive-command scan and the merge verdict rule are the two with no hatch.

So: which tier the test belongs to, that it failed before the code, and that the
mutation check was really performed are reviewer obligations, not gate
obligations. The gate makes their absence visible at commit time; it cannot make
their presence true.

---

## The escape hatch

A gate with no way past it gets disabled wholesale the first time it is wrong,
and then nothing is enforced again. So every overridable rule honours:

```
GML_GATE_SKIP="<why>" <command>
```

Set it inline on the command, or in the environment. When a gate is overridden:

1. the override is appended to `workspace/gate-overrides.log` with a timestamp,
   the rule name and the reason;
2. the reason is echoed into the session log, so it is visible in the session
   that used it and not only in a file nobody opens;
3. it **must be quoted verbatim in the pull request**, in the "Overrides used"
   section.

The price of the hatch is visibility, not friction. An override that reaches
`main` unquoted is a gate that has quietly stopped existing — which is the exact
failure this whole layer was built to end.

Two rules have **no** hatch, because the cost of being wrong is not symmetrical
with the cost of asking a human:

- destructive commands (`rm -rf`, `DROP TABLE`, `DROP DATABASE`, `TRUNCATE`,
  `docker compose down -v`, `git reset --hard`, `git clean -fd`,
  `git stash drop/clear`) — no later commit undoes data loss;
- writes to `.env*` (except `.env.example`) and to generated drizzle snapshots
  under `packages/db/src/migrations/meta/`.

---

## Where hooks load from, and how the last set came to enforce nothing

**Claude Code must be started in the repository root, or in a worktree under
it. If it is started anywhere else, NOTHING here is enforced.**

Hook configuration is read from the directory the **session** started in. Open a
session in `D:\GML` and the repository at `D:\GML\lms-app` has no hooks at all:
no gate refuses anything, no receipt is required, no session log is written, and
the session looks exactly like a session in which every gate happened to pass.

That is not hypothetical — it is the recorded history of this repository. The
previous six hooks were registered in `.claude/settings.json` and enforced
nothing, for two reasons and one proof:

- `node scripts/block_destructive.mjs "$TOOL_INPUT"` — there is **no**
  `$TOOL_INPUT`. It appears zero times in the installed Claude Code binary. The
  script read `process.argv[2]`, which was always the empty string, so the
  project's only blocking hook never matched anything for its entire life. Hook
  input arrives as JSON on **stdin**.
- `"pathGlob": "**/packages/db/src/schema/**"` — **not a config field**, also
  zero occurrences. The three "path-scoped" `Edit`/`Write` hooks fired on every
  single edit and did nothing with the file they were handed. A hook that cares
  about paths must inspect `tool_input.file_path` itself.
- The proof they never fired at all: the old `Stop` hook script appended a line
  to `workspace/session_log.md` **unconditionally**, with no branch that could
  skip it. That file is 112 bytes — its header and nothing else — and its last
  modification time is the moment it was created, 2026-09-18 12:57. **53**
  commits have landed since — `git rev-list --count --since='2026-09-18 12:57'
  HEAD`. A hook that ran even once would have left a line.
  (The six old scripts were deleted on this branch; they are in git history.)

The current hooks defend against this directly: `_lib.mjs` derives the project
directory from the hook file's **own** location rather than trusting
`$CLAUDE_PROJECT_DIR`, and `sessionRootMismatch()` reports when the session
started somewhere else. That makes the hooks act on the right tree when they
run. It cannot make them run. Only starting the session in the right directory
does that.

---

## What to do when a gate is wrong

Not "turn it off". In order:

1. Use `GML_GATE_SKIP="<why>"` for the one call, and quote it in the PR.
2. Open a PR against the hook, with a `tests/hooks` test that fails first on
   the case it got wrong.

Every refusal these gates emit names the rule **and** the way forward. If you
hit one that only says "no", that is a defect in the gate — report it, because
a refusal without an exit is how an enforcement layer gets deleted rather than
fixed.
