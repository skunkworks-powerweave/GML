# Tasks 101

- [x] Edit `docker-compose.yml` to add `WHATSAPP_APP_SECRET` + `MEDIA_SIGN_SECRET` (app service) and `ACME_EMAIL` (caddy service), all using the strict-fail `${VAR:?required}` form.
- [x] Edit `.env.example` to add the 3 keys with placeholder values and explanatory comments under the WhatsApp, Deployment, and (new) Media signed-URL minting section headers.
- [x] Land `tests/governance/test_101_compose_env_completeness.test.mjs` with assertions covering all 3 vars in docker-compose (with strict-fail form) and all 3 in `.env.example`. Run `pnpm test -- tests/governance/test_101_*` and confirm green.
