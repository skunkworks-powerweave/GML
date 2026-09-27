# Hook wiring

`.claude/settings.json` is strict JSON and cannot carry comments, so the two
things a reader needs in order not to break it live here.

## Why the commands say `$CLAUDE_PROJECT_DIR` but the hooks ignore it

Every registration is written in the documented form:

```
node "$CLAUDE_PROJECT_DIR"/.claude/hooks/<name>.mjs
```

`$CLAUDE_PROJECT_DIR` is the directory the **session** started in, which is not
necessarily the repository — a session opened in `D:\GML` sets it there while
the repo is `D:\GML\lms-app`, and in a git worktree it can point at the main
checkout rather than the tree the commit will come from. Acting on the wrong
tree is worse than not acting at all, so `_lib.mjs` derives `PROJECT_DIR` from
the hook file's **own** location (`resolve(HERE, "..", "..")`) and uses
`$CLAUDE_PROJECT_DIR` only as a sanity check via `sessionRootMismatch()`.

The settings file still spells it the documented way because that is the form
Claude Code's own resolution is defined against; the hooks simply do not trust
it as the answer.

## Two fields that do not exist

Both were checked against the installed Claude Code binary, not against
documentation or memory — zero occurrences each:

| Written before | Reality |
| --- | --- |
| `node scripts/block_destructive.mjs "$TOOL_INPUT"` | There is no `$TOOL_INPUT`. The payload is JSON on **stdin**; read it with `readInput()`. The old hook took `process.argv[2]`, which was always empty, so the project's only blocking hook never matched anything. |
| `"pathGlob": "**/packages/db/src/schema/**"` | Not a config field. The three "path-scoped" registrations fired on **every** `Edit`/`Write`. A hook that cares about paths must inspect `tool_input.file_path` itself. |

The proof that none of it ran: `scripts/stop_session.mjs` appended to
`workspace/session_log.md` unconditionally, and that file sat at 112 bytes —
header only — across every session since its creation at 2026-09-18 12:57.
**53** commits had landed in that window as of `3a1eaaf`:

```
git rev-list --count --since='2026-09-18 12:57' 3a1eaaf
```

This paragraph said "27 commits" while `CLAUDE.md` and
`docs/superpowers/README.md` said 52 about the same stretch, in the same commit.
Citing the command was not enough on its own: all three then said **53**, which
was true at `3a1eaaf` and false at the very next commit, so the three of them
were wrong together again one commit later. The command now names a REF instead
of `HEAD`, which is the only form of this sentence that stays true.

`tests/hooks/settings-wiring.test.mjs` pins both absences, that each registered
command resolves to a file that exists and parses, and that each of the two Bash
hooks declares an explicit `timeout` between 30 and 60 seconds. Both carry
`timeout: 60` in `.claude/settings.json` today.

The bound is two-sided on purpose. Below 30s, the merge rule's `gh pr view` can
be killed mid-flight, and a gate killed mid-run fails **open**. Above 60s, a
hung `gh` stalls the session long enough that the layer gets removed out of
impatience. This paragraph claimed `timeout: 120`, which is not the number in
`.claude/settings.json` and not what the test asserts. The test's own comment
records that an earlier draft of it did assert exactly 120, and why that was
replaced by a range — so the doc was quoting a version of the test that no
longer exists.
