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
header only — across the sessions that produced 27 commits.

`tests/hooks/settings-wiring.test.mjs` pins both absences, that each registered
command resolves to a file that exists and parses, and that the two Bash hooks
carry `timeout: 120` (a gate killed mid-run is a gate that fails open).
