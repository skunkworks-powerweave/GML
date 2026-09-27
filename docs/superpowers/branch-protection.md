# Branch protection on `main`

This is the one gate in the layer that an agent cannot enforce and must not
enable for you. Everything in `.claude/hooks/` binds THIS session; branch
protection binds everyone, including a session with the hooks switched off, a
`git push` from a terminal, and this repository's own admins. The hooks are the
fast feedback; this is the backstop.

**State at the time of writing:** not enabled.

```
gh api repos/skunkworks-powerweave/GML/branches/main/protection
-> {"message":"Not Found", ... "status":"404"}
```

## The command

Run it yourself — it changes a shared repository setting.

```bash
gh api -X PUT repos/skunkworks-powerweave/GML/branches/main/protection --input - <<'EOF'
{"required_status_checks":{"strict":true,"contexts":["static","behaviour","images"]},
 "enforce_admins":true,
 "required_pull_request_reviews":null,
 "restrictions":null,
 "allow_force_pushes":false,
 "allow_deletions":false,
 "required_conversation_resolution":true}
EOF
```

## Why each field is what it is

**`contexts` must match the check names EXACTLY.** A rule naming a check that
does not exist does not fail — it silently requires nothing, which is the same
failure mode as the six hooks this branch replaced. The three names above were
read off the live PR rather than off the workflow file:

```
gh pr checks 2 --json name -q '.[].name'
static
behaviour
images
```

They are the job **ids**, because no job in `.github/workflows/test.yml` declares
a `name:` (`grep -n '^    name:'` finds none in the job position). That is
deliberate: the jobs were once called `lint · typecheck · build · governance`,
`behavioural tests (real Postgres)` and `container images` — a U+00B7 and a pair
of parentheses that would have to be retyped exactly into the required-checks
box, and would silently require nothing if they were not.

`boot` is **not** in the list. It does not exist yet; it arrives with Phase 3.5,
and adding it now would require a check that never reports and block every merge.

**`required_pull_request_reviews: null`** — a single-human repository cannot
require an approving review of its own pull requests; GitHub will not let the
author approve. Review is enforced instead by the PR template, by the merge gate
in `pre-bash.mjs` (which refuses `gh pr merge` without a verdict line in the
body, including via `gh api …/pulls/N/merge`), and by running the reviewer. That
combination records that a reviewer wrote a verdict down. It cannot record that
the reviewer read anything — no configuration can.

**`enforce_admins: true`** — with no review requirement, this only enforces the
status checks, and the checks are exactly what an admin merging in a hurry
skips.

**`strict: true`** requires the branch to be current with `main` before merging,
so a check that passed against a stale base does not count.

**`allow_force_pushes: false` / `allow_deletions: false`** are the server-side
half of the rules `pre-bash.mjs` enforces locally. The hook can be bypassed by
any shell that is not this one; this cannot.

## Verifying it took

```bash
gh api repos/skunkworks-powerweave/GML/branches/main/protection \
  --jq '{checks: .required_status_checks.contexts, strict: .required_status_checks.strict, admins: .enforce_admins.enabled}'
```

Expect the three context names, `strict: true`, `admins: true`. If `checks` comes
back empty, the rule is requiring nothing and the merge gate is effectively off.
