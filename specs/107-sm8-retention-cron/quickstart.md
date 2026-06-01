# Quickstart 107

`docker compose up worker` (or `pnpm --filter @gml/worker dev`). Look for `[retention] nightly schedule registered (cron '0 3 * * *')` on boot. To verify the schedule landed in Redis: `docker compose exec redis redis-cli KEYS 'bull:retention:*'` — expect a `repeat:retention:nightly` key. To manually trigger an immediate run for testing: `pnpm --filter @gml/db retention` (the CLI entry point still works post-refactor and exercises the exact same code path).
