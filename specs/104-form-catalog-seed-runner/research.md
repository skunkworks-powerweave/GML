# Research 104

## D-001 — In-process imports beat `spawnSync` for the orchestrator

Two viable options: spawn each sub-script as a child process via
`child_process.spawnSync("tsx", [...])`, or import each `main()` and call
sequentially in-process. We picked in-process imports because (a) it keeps
all logging on one stdout stream, (b) it avoids the per-phase ~300ms tsx
boot tax (relevant on slow VPS disks), (c) failures surface as JS
exceptions with stack traces rather than opaque exit codes, and (d) the
entry-point guard pattern (`import.meta.url === pathToFileURL(process.argv[1]).href`)
is the standard ESM-native way to make a script dual-purpose without
breaking direct invocation.

## D-002 — No cross-phase transaction; per-script pools stay

Each sub-script opens and closes its own `pg.Pool`. Wrapping the
orchestrator in a single transaction would require restructuring all five
scripts to accept an injected `db` handle and skip their own pool
lifecycle — five times more diff than this spec's mandate. The
idempotency guards (existence checks on natural keys, `onConflictDoNothing`
on the observation forms) already make partial-completion safe to re-run,
so a wrapper transaction adds complexity without buying recoverability we
don't already have.
