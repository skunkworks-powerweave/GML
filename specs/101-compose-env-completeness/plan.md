# Plan 101

CREATED: `specs/101-compose-env-completeness/{spec,plan,research,quickstart,tasks}.md`, `tests/governance/test_101_compose_env_completeness.test.mjs`
EDITED: `docker-compose.yml` (added `WHATSAPP_APP_SECRET` + `MEDIA_SIGN_SECRET` to `app` service env, `ACME_EMAIL` to `caddy` service env — all three with the strict-fail `${VAR:?required}` form matching spec 002 pattern), `.env.example` (added the 3 keys with placeholder values + comments under appropriate section headers)
MIGRATED: none (no schema or app-code change — deployment YAML / env documentation only)
