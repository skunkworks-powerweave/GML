# Research 163

Five small design choices, documented inline in the touched files and
expanded here.

## (1) Why a hand-rolled logger rather than `pino` / `winston`

The worker is a tiny Node process — one BullMQ Worker, one retention
Worker, one scheduled job registration, six log call sites total. The
NIT round's complaint was about CONSISTENCY of format, not about
features (no log levels with filtering, no transports, no rotation).
Pulling in `pino` (the obvious choice — it's already battle-tested
and zero-config-fast) would add a dependency and a configuration
surface area for what amounts to six `process.stderr.write` lines.

Three rejected alternatives:

- **`pino`.** Best-in-class Node logger, ~50kB dep, supports
  pretty-print in dev and JSON in prod. Rejected because the worker's
  output is shipped to Loki via Promtail (per `docs/operations.md`)
  which has its own parser — pretty-print would actively HURT
  shipping, and prod-JSON is exactly what we want, which is also
  exactly what the four-line shim below produces. Adding `pino`
  would also force every future contributor to learn one more
  dependency.
- **`winston`.** Slower, heavier, more configurable. Same rejection
  reason as pino plus winston's transport abstraction is
  overengineered for a single-process worker.
- **`debug`.** Wrong shape — `debug` is for conditional dev logs
  toggled by an env var. The worker output is always-on production
  logging, not opt-in debug spew.

The shim shape (in `apps/worker/src/log.ts`) is intentionally three
functions and one `emit` private helper — under 50 lines, no
configuration surface, fits on one screen of source. If the worker
ever grows enough log call sites that levels / filtering matters,
swapping this shim for `pino` is one import change away (the
`log.info` / `log.warn` / `log.error` surface IS pino-compatible).

## (2) Format choice — bracketed prefix vs raw JSON

Two viable output formats for a Loki / Promtail pipeline:

- **Raw JSON line** — `{"level":"info","ts":"2026-06-02T...","msg":"online","fields":{...}}`.
  Easiest to parse, no regex needed in the shipper config.
- **Bracketed prefix + trailing JSON fields** —
  `[worker][2026-06-02T...][info] online {"redis":"redis://...","concurrency":4}`.
  Human-readable at `docker compose logs` AND machine-parseable
  with a single regex (the bracketed-segments grammar is unambiguous).

We chose the bracketed-prefix because the operations stack
(`docs/operations.md`) shows the team uses `docker compose logs -f`
during incident triage. A raw JSON line is unreadable in that
context — the operator would have to pipe it through `jq` to get
the message. The bracketed prefix is the best of both: the message
is right there for the human eye, the trailing JSON fields hold the
structured payload for the shipper. This is the same shape the
Next.js app's server logs use (a soft project-wide convention).

The trailing-JSON is OMITTED when fields is undefined or empty, so a
bare `log.info("online")` reads as `[worker][...][info] online` (no
trailing curly-brace clutter).

## (3) Stderr-only output

Sending everything to stderr (including info-level) is a deliberate
choice with two motivations:

- **Docker compose treats both fd1 and fd2 the same** for
  `docker compose logs`, so there's no functional regression.
- **Production log shippers split them.** Promtail's default config
  attaches a `stream=stderr` label to fd2 output and `stream=stdout`
  to fd1. The worker has no use for a "this is normal app output"
  vs "this is structured logging" split, so putting everything on
  stderr keeps the labels uniform — every worker log line gets
  `stream=stderr`, simplifying Loki queries.

The alternative ("info to stdout, warn+error to stderr") was
rejected because it'd produce TWO Loki streams to query and split
incidents across — when triaging a worker failure you want one
ordered stream, not a join of two.

## (4) `closest()` of the path comparison — why basename fallback over realpath

Three options for fixing the symlink-fragility in `retention.ts`'s
entry-point guard:

- **`fs.realpathSync(process.argv[1])` + `realpathSync(fileURLToPath(import.meta.url))`.**
  Resolves both sides to canonical absolute paths before comparing.
  Most correct.
- **Basename comparison.** Compares only the file name (`retention.ts`
  on both sides). Permissive — would false-positive if some unrelated
  script is also named `retention.ts` and run from a different
  directory. But in practice no other script in the LMS is named
  `retention.ts`, so the false-positive risk is zero.
- **Accept the fragility.** Status quo. The NIT round flagged this
  explicitly so leaving it alone isn't acceptable.

We chose the basename fallback (as a SECOND check after the original
strict equality) because:

- `realpathSync` is a sync filesystem call. On a cold container it'd
  open a stat syscall just for the entry-point guard. Cheap, but the
  basename comparison is free.
- The strict path equality (the original check, still primary)
  catches the common case where someone has a same-named script in
  another package. The basename fallback only takes over when the
  strict check fails AND the basenames match — which in practice
  means "symlinked script, same file underneath".
- The fallback is wrapped in try/catch so a `fileURLToPath` failure
  (extremely unlikely; would require an invalid `import.meta.url`)
  silently returns false. No path the guard takes can crash the
  process.

A future spec that hits a genuine basename collision (someone adds a
second `retention.ts` elsewhere) can upgrade to `realpathSync` —
the contract that matters is "the script auto-runs when invoked
directly", and either implementation honours that.

## (5) Rate-limit fail-closed — why the JSDoc, not a runtime assertion

The original spec 141 established that `rateLimit()` fails closed
(Redis outage → throw). The audit asked for documentation, not
behaviour change. Three options for documenting:

- **JSDoc block at the top of the module.** Easy to find, shows up
  in IDE hover for every caller, pin-able by governance test.
- **Runtime assertion** (throw if caller doesn't have the wrapping
  try/catch). Impossible — the function has no way to inspect its
  caller's syntactic shape.
- **TypeScript declaration that returns `never` on failure.** Could
  do `Promise<RateLimitResult | never>` but TS will collapse that
  to just `RateLimitResult` — `never` is already absorbed by every
  other type in a union.

The JSDoc was the obvious pick. The literal phrase "FAIL-CLOSED"
(with the hyphen) is pinned in the governance test so a future
contributor who wants to soften the doc has to confront the test
diff. A worked caller example sits inside the JSDoc so a reader
copying it gets the correct shape from the start — no risk of
copy-pasting from a stale internet example that fails-open.

## (6) Topbar verification — pinning ABSENCE rather than presence

The Topbar's hardcoded "EN" was already removed in spec 155 when
the `LanguagePicker` client island landed. The NIT round still
wants a guard against regression. Two patterns:

- **Pin presence of `LanguagePicker`.** Test that the import +
  render call exist. Catches a future contributor removing the
  picker entirely.
- **Pin absence of literal `"EN"`.** Test that no `"EN"`-shaped
  JSX literal appears in the source. Catches a future contributor
  RE-introducing the hardcode while leaving the picker import in
  place.

We use BOTH patterns in the governance test below. Spec 155 already
covers the presence half (its test pins the `LanguagePicker`
import); this spec adds the absence half, which is the load-bearing
NIT contract. The two patterns together make the regression
impossible to slip through.

A subtle edge: the test must allow `"EN"` to appear in JSDoc
comments / documentation strings (the spec.md narrative talks about
EN, the file might contain a comment referencing it). The regex pins
the JSX context (`>EN<` or `"EN"` as a literal string between tag
brackets) rather than naked occurrences of the two letters.
