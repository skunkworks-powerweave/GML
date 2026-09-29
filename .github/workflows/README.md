# CI workflows

`test.yml` runs on every push to `main` and every pull_request: lint, typecheck, build,
governance and script tests, the behavioural suite on a real Postgres, and the container
images. Per Spec 165.

`release.yml` runs on a version tag (`v1.2.3`, `v1.2.3-rc.1`): the whole `test.yml` gate
again, then the app, worker and migrate images to ghcr.io under that version.

`deploy.yml` runs `scripts/deploy.sh` on a server over SSH: staging when a GitHub Release
is published, production by hand (final versions only). Setup and secrets:
`docs/handover/IT-HANDOVER.md`.
