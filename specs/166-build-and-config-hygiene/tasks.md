# Tasks 166

- [x] T1 → write the governance test (red) covering:
  - `.gitattributes` exists at repo root and contains
    `text=auto eol=lf`;
  - `.gitattributes` declares `binary` for `*.pdf`, `*.png`,
    `*.jpg`, `*.jpeg`, `*.mp4`, `*.mov`, `*.webm`, `*.ico`,
    `*.woff`, `*.woff2`, `*.ttf`, `*.zip`, `*.gz`;
  - `.env.example` contains `WORKER_CONCURRENCY`, `TZ`,
    `MINIO_BUCKET`, `GML_WHATSAPP_NUMBER`,
    `GML_HELPDESK_PHONE`, `GML_HELPDESK_EMAIL`;
  - root `package.json` declares `typecheck`, `migrate`,
    and `seed:all` scripts;
  - `apps/worker/eslint.config.mjs` exists and is a flat-config
    array wiring `@typescript-eslint/recommended`;
  - `packages/db/eslint.config.mjs` exists and is a flat-config
    array wiring `@typescript-eslint/recommended`;
  - `tsconfig.base.json` exists at repo root with the
    `target: ES2022` baseline;
  - `apps/web/tsconfig.json` extends from `../../tsconfig.base.json`.
  Run suite → red.

- [x] T2 → create `.gitattributes` at the repo root:
  - first non-comment line: `* text=auto eol=lf`;
  - binary pins grouped by purpose (documents/images, video,
    fonts, archives).
  Run scoped governance test → gitattributes assertions green.

- [x] T3 → edit `.env.example`:
  - add `WORKER_CONCURRENCY=2` (with the clamp comment) and
    `TZ=Asia/Kolkata` under a new "Worker / scheduler (spec 166)"
    section;
  - add `GML_WHATSAPP_NUMBER`, `GML_HELPDESK_PHONE`,
    `GML_HELPDESK_EMAIL` under a new "WhatsApp helpdesk /
    ingest UX (spec 166)" section;
  - verify `MINIO_BUCKET=gml-media` is already present in the
    file (checkpoint; was added in earlier work).
  Run scoped governance test → env.example assertions green.

- [x] T4 → edit root `package.json`:
  - add `"typecheck": "pnpm -r --if-present typecheck"`;
  - add `"migrate": "pnpm --filter @gml/db migrate"`;
  - add `"seed:all": "pnpm --filter @gml/db seed:all"`.
  Run scoped governance test → root-scripts assertion green.

- [x] T5 → create `apps/worker/eslint.config.mjs`:
  - flat config array, default-export shape;
  - imports `tsParser` from `@typescript-eslint/parser` and
    `tsPlugin` from `@typescript-eslint/eslint-plugin`;
  - one block with `files: ["**/*.ts"]`, parser wired,
    plugin wired, `rules: { ...tsPlugin.configs.recommended.rules }`.
  Run scoped governance test → worker-eslint assertion green.

- [x] T6 → create `packages/db/eslint.config.mjs`:
  - identical shape to T5.
  Run scoped governance test → db-eslint assertion green.

- [x] T7 → edit `apps/worker/package.json` and
  `packages/db/package.json`:
  - add `@typescript-eslint/eslint-plugin@^8.18.0` and
    `@typescript-eslint/parser@^8.18.0` to each `devDependencies`.

- [x] T8 → create `tsconfig.base.json` at the repo root:
  - keys: `target: ES2022`, `module: ESNext`,
    `moduleResolution: Bundler`, `composite: true`,
    `strict: true`, `skipLibCheck: true`,
    `esModuleInterop: true`, `isolatedModules: true`,
    `resolveJsonModule: true`,
    `forceConsistentCasingInFileNames: true`.
  Inline `_comment` documenting the deferred rollout.
  Run scoped governance test → tsconfig-base assertion green.

- [x] T9 → edit `apps/web/tsconfig.json`:
  - add `"extends": "../../tsconfig.base.json"` at the top;
  - keep web-specific overrides (`target: ES2017` for browser
    bundle, `composite: false` because Next.js manages its own
    incremental build, `lib`, `paths`, `jsx`, `plugins`,
    `allowJs`, `incremental`, `noEmit`).
  Run scoped governance test → web-tsconfig assertion green.

- [x] T10 → author all five spec-kit files under
  `specs/166-build-and-config-hygiene/`.

- [x] T11 → run the full governance suite. Confirm no regression
  — all changes are config / docs / hygiene fixes; no other
  governance test reaches into the modified surface.

- [ ] T12 (future, out of scope) → migrate `apps/worker/tsconfig.json`,
  `packages/db/tsconfig.json`, `packages/shared/tsconfig.json`, and
  `packages/ui/tsconfig.json` to extend from `tsconfig.base.json`.
  Each package may have a small package-specific override (e.g.
  worker has `outDir: dist` + `rootDir: src`; db has `noEmit:
  true`) that needs to be preserved. Track-by-track follow-up.

- [ ] T13 (future, out of scope) → wire a `lint` script into each
  `package.json` for the worker and db so `pnpm -r lint` from
  the repo root picks them up. Currently the ESLint configs
  exist but no script is wired; an operator has to run
  `pnpm --filter @gml/worker exec eslint src/` directly.

- [ ] T14 (future, out of scope) → tighten the worker / db ESLint
  rule set beyond `@typescript-eslint/recommended` (e.g. add
  `no-floating-promises`, `no-explicit-any`). The audit team's
  specific findings (`any` types in the worker, one in
  retention) will be cleaned up as part of that follow-up.

- [ ] T15 (future, out of scope) → wire the new root-level
  `typecheck` script into the CI workflow alongside the existing
  `pnpm test` + `pnpm build` matrix. The current CI already
  exercises the TypeScript compiler through Next.js's build +
  the governance tests' import-time type checks, so this is a
  hardening-only follow-up.
