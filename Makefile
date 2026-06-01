# Spec 108 — minimal Makefile so operators reaching for `make deploy`
# reflexively get the SM-5-gated deploy wrapper. The canonical entry
# point is scripts/deploy.sh; this is just a discoverable alias.

.PHONY: deploy

deploy:
	./scripts/deploy.sh
