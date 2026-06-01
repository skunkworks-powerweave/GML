# Research 100

- `apps/worker/package.json` already exposes `"start": "tsx src/index.ts"` and lists `tsx ^4.19.2` in `devDependencies` — the install layer (`pnpm install --frozen-lockfile --filter @gml/worker... --filter @gml/worker`) brings tsx into `apps/worker/node_modules/.bin`, so `pnpm exec tsx` resolves at runtime without an additional install step.
- `apps/worker/tsconfig.json` has `outDir: "dist"`, `rootDir: "src"` — a compile step is *possible* but not wired into any script; running `tsx` against the source keeps the runtime path identical to local dev (`pnpm dev`) and skips a second build pipeline.
- The runner stage already does `apt-get install -y --no-install-recommends ffmpeg ca-certificates wget` (line 27) — ffmpeg is on the worker user's PATH; `transcode.ts` calls it via `spawn("ffmpeg", …)` with no absolute path so PATH resolution is the only requirement.
- `apps/worker/src/index.ts` imports `IORedis` + `bullmq.Worker` + `./transcode.js` (the .js extension matters: tsx-on-ts source uses the post-transpile extension for relative imports per Node ESM convention; tsx handles both at load time).
