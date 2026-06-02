# Research 166

Five small design choices, documented inline in the touched files
and expanded here.

## (1) `.gitattributes` — why `text=auto eol=lf` over `text eol=lf`

Two viable defaults for a polyglot mixed-Windows-Linux team:

- **`* text eol=lf`** — declares every file as text (Git will
  attempt to normalise line endings on every file). Most aggressive.
  Risks corrupting any binary file that happens to slip past the
  binary pins (Git would re-encode it as text, breaking the file).
- **`* text=auto eol=lf`** — Git uses heuristics to detect text
  vs binary content and only normalises files it auto-detected
  as text. Safer fallback. The `eol=lf` part still applies to
  any file Git decides is text.

We chose `text=auto eol=lf` because the auto-detection is
load-bearing for safety. The explicit binary pins (`*.pdf binary`
etc.) catch the known formats up front; the `text=auto` heuristic
catches anything we forgot.

Three rejected alternatives:

- **`core.autocrlf` per-developer.** The status quo. Relies on
  each developer setting their global Git config correctly.
  Three contributors → three forgotten settings → CRLF churn in
  PR diffs.
- **Linux-only contributors.** Not viable — two of the three
  current contributors are on Windows + OneDrive, and the LMS
  is built for low-bandwidth deployments where the maintenance
  team's OS preferences shouldn't matter.
- **`.editorconfig`.** Covers line endings inside editors but
  NOT Git's own normalisation. Git doesn't read `.editorconfig`.
  We use both — `.editorconfig` covers in-editor behaviour,
  `.gitattributes` covers what Git stores.

The binary pins are listed grouped by purpose (documents/images,
video, fonts, archives) so a contributor adding a new binary
format knows which group to extend. The list is the union of
binary formats currently present in `apps/web/public/`, `docs/`,
and the WhatsApp ingest pipeline's expected upload types.

## (2) Why six env-vars and not more

The audit team's sweep found these six specific knobs read by
the codebase without documentation in `.env.example`:

- `WORKER_CONCURRENCY` — read by `apps/worker/src/index.ts`,
  clamped `[1, 16]`. Default 2.
- `TZ` — read by the Node runtime for `node-cron` scheduling.
  Default `Asia/Kolkata` matches the LMS deployment region (Ladakh)
  but should be explicit so a non-IST deployment knows to override.
- `MINIO_BUCKET` — already present in `.env.example` from earlier
  work; called out here as a checkpoint so the governance test
  can pin its presence (regression-proofing against an accidental
  removal).
- `GML_WHATSAPP_NUMBER` — surfaced by `UploadModal` and the
  ingest log.
- `GML_HELPDESK_PHONE` — surfaced by `HelpPanel`'s "Talk to a
  person" CTA.
- `GML_HELPDESK_EMAIL` — surfaced by `HelpPanel`'s "Email admin"
  CTA.

Other knobs the codebase reads (`NEXT_PUBLIC_SITE_URL`, various
internal feature flags) are either auto-derived from existing
documented knobs (`AUTH_URL`) or are dev-only and should NOT be
in `.env.example` (would mislead production operators). The audit
asked specifically for these six and we ship those six — narrower
scope, easier to verify.

The comment-on-the-right style is chosen to match the existing
file convention (lines 6, 7, 11-15 etc. all use this style). A
contributor copying `.env.example` to `.env` sees the same shape
they're used to.

## (3) Why three root-level scripts and not more

The repo already has root-level forwarders for `lint`, `build`,
and `test` (see `package.json`). The audit team flagged exactly
these three additional knobs as worth surfacing:

- `typecheck` — uses `pnpm -r --if-present typecheck` so packages
  without a `typecheck` script are silently skipped. Currently
  only `packages/db` defines this script; others can opt in later
  by adding their own `tsc --noEmit` line.
- `migrate` — targets `@gml/db` directly. Only one package owns
  the live DB surface.
- `seed:all` — same reasoning as `migrate`. Both `migrate` and
  `seed:all` are operator-facing (the README's deploy steps
  invoke them) so surfacing them at the root is a documented-UX
  win.

Other potential candidates (`generate` for drizzle-kit,
`retention` for the SM-8 cron) are NOT added because:

- `generate` is a developer-only command run when authoring a
  new migration — it shouldn't be in the operator's mental model.
- `retention` runs inside the worker as a scheduled job; an
  operator manually invoking it is a debugging escape hatch,
  not a routine flow. The README documents the `pnpm
  --filter @gml/db retention` direct invocation for that case.

## (4) Why @typescript-eslint/recommended and not a richer ruleset

Four candidate ESLint rule sets for the worker / db packages:

- **`@typescript-eslint/recommended`** — the baseline. Catches
  `any` types, unused vars, basic TS misuse. ~30 rules.
- **`@typescript-eslint/recommended-type-checked`** — adds
  type-aware rules (no-floating-promises, no-unsafe-assignment,
  etc.). Requires a `tsconfigRootDir` + `project` in the parser
  options, which means every package needs its own config tweak.
  ~50 rules.
- **`@typescript-eslint/strict`** — the kitchen sink. ~80 rules
  including stylistic preferences that don't map to LMS team
  conventions.
- **Custom from `eslint-config-next`.** The web app uses this.
  Pulls in `react-hooks` rules etc. that don't apply to the
  worker (no React, no JSX). Would produce false-positives at
  every JSX-aware rule.

We chose `@typescript-eslint/recommended` because:

- It's the entry point. The audit team's specific findings
  (`any` types in the worker, one in retention) are all caught
  by this set.
- Adding stricter rules later is one config line away — the
  governance test pins the existence of the config, not the
  rule set, so a future spec can tighten without breaking the
  test.
- `recommended-type-checked` would need a `tsconfigRootDir`
  setting that requires solving the tsconfig-base-adoption
  question for these packages first. That's a follow-up.

## (5) Why a tsconfig.base.json and the limited rollout

The audit team's complaint was: "each package re-declares the
same `strict: true`, `skipLibCheck: true`, `esModuleInterop:
true`, `isolatedModules: true` block. Drift surface is real."

A shared base solves that. The keys we ship in the base are the
keys all four packages currently agree on:

- `target: ES2022` — agrees with worker, agrees with db.
  `apps/web` overrides to ES2017 for browser bundle compatibility.
- `module: ESNext` — agrees with all four packages.
- `moduleResolution: Bundler` — agrees with all four.
- `composite: true` — enables `tsc -b` reference-based incremental
  builds when we want them. `apps/web` overrides to `false`
  because Next.js manages its own incremental build.
- `strict`, `skipLibCheck`, `esModuleInterop`, `isolatedModules`,
  `resolveJsonModule` — all four packages agree.
- `forceConsistentCasingInFileNames` — already in `packages/db`,
  not yet in others; safe to add to the baseline.

The rollout in THIS spec is limited to `apps/web` (the most
visible package, also the package whose tsconfig change is most
likely to surface a downstream build break if it goes wrong).
The other three packages (worker, db, shared, ui) will be
migrated in a follow-up after this proof-of-life is confirmed
green by the full governance suite + a clean `pnpm build`. Each
of those packages may have a small package-specific override
(e.g. worker has `outDir: dist` + `rootDir: src` which the base
doesn't carry; db has `noEmit: true`) that needs to be preserved.
That's the per-package case-by-case consideration the rollout
follow-up covers.

The `_comment` field at the top of `tsconfig.base.json` documents
the deferral inline so a future contributor doesn't get confused
why the base exists but only the web app uses it.

## (6) Why no CI wiring in this spec

The audit team's findings did not include "CI silently doesn't
check typecheck" — the existing CI matrix already runs `pnpm
test` and `pnpm build`, both of which exercise the TypeScript
compiler through Next.js's build + the governance tests'
import-time type checks. Adding a separate `pnpm typecheck`
step would be redundant given that.

A future spec that wants to harden CI further (e.g. matrix
across Node 22 / 24, parallel-package builds, cache-friendly
incremental compilation) can wire the new root-level
`typecheck` script into the CI workflow at that point. This
spec's scope is just to make the surface exist; CI integration
is an orthogonal concern.

## Follow-up tsconfig adoption tracker

After this spec lands, the following packages still need to be
migrated to extend from `tsconfig.base.json`:

- `apps/worker/tsconfig.json` — has `outDir: dist`, `rootDir:
  src`, `allowSyntheticDefaultImports: true`. The first two need
  to remain after the extend; the third is already implied by
  `esModuleInterop`.
- `packages/db/tsconfig.json` — has `noEmit: true`,
  `forceConsistentCasingInFileNames: true`. The first needs to
  override the base's `composite: true` (composite implies
  emit); the second is now redundant since it's in the base.
- `packages/shared/tsconfig.json` — needs inspection.
- `packages/ui/tsconfig.json` — package has no tsconfig yet
  (verified `ls packages/ui` shows only `package.json`); the
  follow-up adds one.

Tracked as task T9 in `tasks.md` (out of scope this run).
