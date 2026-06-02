# Spec 166 — Build & config hygiene (Workflow Run 16 audit closure, HIGH-priority hygiene round)

## Why

Workflow Run 16 opens with a fresh-eyes sweep over the 163 specs
shipped to date and surfaces a cluster of "real but small" build /
config / docs-drift issues. None is a behaviour bug — but each adds
friction for the next contributor (Windows users, ops, anyone
configuring a fresh deploy):

1. **No `.gitattributes`.** Two of the three current contributors
   work on Windows + OneDrive. Every commit they make produces a
   diff polluted with CRLF / LF churn against the LF-default files
   the Linux-based CI sees. Binary files (the seed PDFs in
   `docs/`, font files baked into the static export, the SVG / ICO
   icons in `apps/web/public/`) also have no binary pin — Git
   sometimes tries to "auto-detect" them, occasionally guessing
   wrong and committing a corrupted file. A repo-root
   `.gitattributes` declaring `* text=auto eol=lf` plus explicit
   binary pins for known formats closes the gap once and for all.

2. **Six undocumented env-vars in `.env.example`.** The current
   `.env.example` documents the obvious infra knobs (Postgres,
   MinIO, WhatsApp, SMTP, super-admin seed) but is missing six
   knobs that the codebase actively reads:
   - `WORKER_CONCURRENCY` (clamped `[1, 16]` by the worker)
   - `TZ` (the `node-cron` schedule for retention assumes
     `Asia/Kolkata`)
   - `MINIO_BUCKET` (the bucket name; was assumed-default in early
     specs, now made explicit and overridable per service —
     verified present in the current file from earlier work but
     called out here as a hygiene checkpoint)
   - `GML_WHATSAPP_NUMBER` (the WhatsApp number teachers send media
     to; surfaced in `UploadModal` and the ingest log)
   - `GML_HELPDESK_PHONE` (the WhatsApp helpdesk for the
     `HelpPanel`'s "Talk to a person" CTA)
   - `GML_HELPDESK_EMAIL` (the `mailto:` target for the
     `HelpPanel`'s "Email admin" CTA)

   A new operator following the README will copy `.env.example` to
   `.env` and miss these knobs entirely. The runtime defaults are
   reasonable but the surface is invisible from the env file.

3. **Three missing root-level npm scripts.** The repo has
   per-package `typecheck`, `migrate`, and `seed:all` scripts (in
   `packages/db` and the worker) but no root-level aliases. An
   operator running `pnpm migrate` from the repo root gets "command
   not found" — they have to know to `cd packages/db` first.
   Adding three root-level forwarders (`typecheck`, `migrate`,
   `seed:all`) brings the surface in line with the existing
   `lint` / `build` / `test` root-level forwarders.

4. **No ESLint config for `@gml/worker` or `@gml/db`.** Only
   `apps/web` carries an `eslint.config.mjs`. A `pnpm -r lint` at
   the root silently skips the worker and the db package because
   neither has a lint script and neither has a config — ESLint
   would have nothing to load even if invoked. The audit team
   spotted at least two undocumented `any` types in the worker and
   one in the retention script that a basic
   `@typescript-eslint/recommended` config would have flagged.

5. **No `tsconfig.base.json` at the repo root.** Each package
   re-declares its own compiler options (strict, target, module
   resolution). Most of them happen to agree but the drift surface
   is real: `apps/web` targets ES2017 (browser bundle), the worker
   and db target ES2022 (Node 22). A shared base in
   `tsconfig.base.json` codifies the "everything else" defaults so
   future packages don't have to re-derive the matrix.

## What we ship

### `.gitattributes` (CREATED at repo root)

A repo-root `.gitattributes` file declaring:

```
* text=auto eol=lf
```

as the global default (kills CRLF churn on Windows commits) plus
explicit binary pins for the known formats present in the repo:
`*.pdf`, `*.png`, `*.jpg`, `*.jpeg`, `*.mp4`, `*.mov`, `*.webm`,
`*.ico`, `*.woff`, `*.woff2`, `*.ttf`, `*.zip`, `*.gz`. Inline
comments group the pins by purpose (documents/images, video, fonts,
archives) so a contributor adding a new binary format knows where
to put their addition.

### `.env.example` (EDITED)

Six new env-var documentation lines added in two new comment-bracketed
sections at the end of the file:

```
# ── Worker / scheduler (spec 166) ──
WORKER_CONCURRENCY=2     # BullMQ worker concurrency, clamped [1, 16]
TZ=Asia/Kolkata          # server timezone for cron scheduling (retention runs at 03:00 local)

# ── WhatsApp helpdesk / ingest UX (spec 166) ──
GML_WHATSAPP_NUMBER=+919999999999    # WhatsApp number teachers send media to; used by UploadModal + ingest log
GML_HELPDESK_PHONE=+919999999999     # WhatsApp helpdesk for "Talk to a person" CTA in HelpPanel
GML_HELPDESK_EMAIL=helpdesk@example.org   # mailto target for HelpPanel "Email admin" CTA
```

(`MINIO_BUCKET` was already present from earlier work; the
governance test verifies its presence as a checkpoint.)

The comment-on-the-right style matches the existing file convention.

### `package.json` (EDITED, root)

Three new scripts added to the root `scripts` block, alphabetically
adjacent to the existing forwarders:

```json
"typecheck": "pnpm -r --if-present typecheck",
"migrate":   "pnpm --filter @gml/db migrate",
"seed:all":  "pnpm --filter @gml/db seed:all"
```

`typecheck` uses the same `-r --if-present` shape as `lint` and
`build` so packages without a `typecheck` script are silently
skipped (graceful no-op). `migrate` and `seed:all` target
`@gml/db` directly because that's where the scripts live; only one
package can own the live database surface.

### `apps/worker/eslint.config.mjs` (CREATED)

A minimal flat ESLint config wiring
`@typescript-eslint/recommended`:

```js
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
export default [
  { files: ["**/*.ts"], languageOptions: { parser: tsParser }, plugins: { "@typescript-eslint": tsPlugin }, rules: { ...tsPlugin.configs.recommended.rules } },
];
```

### `packages/db/eslint.config.mjs` (CREATED)

Identical shape to the worker config (above). Both packages are
pure TS / Node — no React, no JSX, no Next.js — so the
`@typescript-eslint/recommended` rule set is the right surface.

### `apps/worker/package.json` + `packages/db/package.json` (EDITED)

Two new devDependencies added to each:
- `@typescript-eslint/eslint-plugin` (`^8.18.0`)
- `@typescript-eslint/parser` (`^8.18.0`)

Version pin matches the broader ecosystem; these are the only two
new packages this spec introduces.

### `tsconfig.base.json` (CREATED at repo root)

A shared TypeScript baseline:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "composite": true,
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

### `apps/web/tsconfig.json` (EDITED)

Adds `"extends": "../../tsconfig.base.json"` at the top of the file
as proof-of-life. The web app overrides the `target` (ES2017 for
browser bundle compatibility) and `composite` (`false` — Next.js
manages its own incremental build) inside its own `compilerOptions`
block; everything else is inherited from the base. The other two
packages (worker, db) keep their existing tsconfig as-is in this
run — adopting the base is a follow-up tracked in `research.md`.

## Acceptance criteria

- `.gitattributes` exists at the repo root and contains the literal
  string `text=auto eol=lf`.
- `.gitattributes` declares `binary` for each of `*.pdf`, `*.png`,
  `*.jpg`, `*.jpeg`, `*.mp4`, `*.mov`, `*.webm`, `*.ico`, `*.woff`,
  `*.woff2`, `*.ttf`, `*.zip`, `*.gz`.
- `.env.example` declares the six env-vars `WORKER_CONCURRENCY`,
  `TZ`, `MINIO_BUCKET`, `GML_WHATSAPP_NUMBER`, `GML_HELPDESK_PHONE`,
  and `GML_HELPDESK_EMAIL`.
- Root `package.json` declares `typecheck`, `migrate`, and
  `seed:all` scripts.
- `apps/worker/eslint.config.mjs` exists and is a flat-config array.
- `packages/db/eslint.config.mjs` exists and is a flat-config array.
- `tsconfig.base.json` exists at the repo root with the keys listed
  above.
- `apps/web/tsconfig.json` extends from `../../tsconfig.base.json`
  (proof-of-life).
- All five spec-kit files exist under
  `specs/166-build-and-config-hygiene/`.
- `tests/governance/test_166_build_and_config_hygiene.test.mjs`
  passes with at least 10 assertions covering the above.

## Non-goals

- **No mass-rewrite of all package tsconfigs.** Only `apps/web`
  adopts the base in this run as a proof-of-life. Adopting the
  base for `apps/worker`, `packages/db`, `packages/shared`, and
  `packages/ui` is tracked as a follow-up in `research.md` — each
  package may have package-specific overrides (e.g. `outDir`,
  `rootDir`) that need to be considered case-by-case before the
  switch.
- **No new ESLint rules beyond `@typescript-eslint/recommended`.**
  This spec wires the config — it does NOT tighten the rule set.
  Stricter rules (no-floating-promises, no-explicit-any, etc.)
  are tracked as a follow-up; the audit team's specific findings
  in the worker and retention script will be addressed when
  those stricter rules land.
- **No behaviour change.** Every env-var added to `.env.example`
  is documentation only — the runtime already reads these knobs
  with sensible defaults. No DB schema delta, no API change, no
  protocol shift.
- **No CI workflow changes.** Wiring the new `typecheck` /
  `migrate` / `seed:all` scripts into a CI job is a follow-up.
  This spec adds the scripts; the existing CI matrix already
  runs `pnpm test` + `pnpm build`, which is enough to keep the
  governance test honest.
- **No commit.** Per the Run 16 ground rules, this spec ships
  the file changes but does NOT create a Git commit; the
  workflow runner aggregates all Run 16 specs into a single
  commit at the end of the run.
