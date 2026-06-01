# Research 108

## D-001 — Wrapper as bash script, not a pnpm composite

We could express the deploy chain as a `pnpm` script (`"deploy": "node scripts/check-restore-drill.mjs && docker compose up -d && ..."`) but bash beats it on two axes: (a) the curl-poll health-wait needs a loop with a timeout, and embedding multi-line shell in JSON is fragile (escape soup); (b) `pnpm run` adds ~300 ms of node-startup tax per chained command, which matters on the slow-disk VPS where postgres cold-start is already the long pole.

## D-002 — curl-polling vs `docker compose --wait` for health-wait

Docker Compose v2.17+ supports `docker compose up -d --wait` which blocks until all services with `healthcheck:` go healthy. We picked the curl loop instead because (a) the app's `/api/health` is the *application-level* readiness signal (it pings postgres + redis); a container-level HTTP healthcheck would just hit the next.js process, missing the "DB connection pool is live" condition; (b) `--wait` ties us to a Compose version floor that may not be installed on operators' VPSes (Debian 12 ships 2.21 but Debian 11 backports lag). The curl loop is portable to any host that has `curl` (which is every Linux distro we'd target).

## D-003 — Makefile is optional, not mandatory

Operators reach for `make deploy` reflexively on Linux, but `make` isn't installed by default on minimal Debian / Alpine images. Adding `make` as a hard dependency for *deploy* (which is by definition the first thing you do on a fresh box) would be circular. The script is the canonical entry point; the Makefile is a convenience shim. The governance test allows the Makefile to be absent as long as the README references the script unambiguously.
