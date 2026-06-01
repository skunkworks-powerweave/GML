# Spec 101 — docker-compose env completeness (Tier A2)

**Status:** complete · **Date:** 2026-06-01 · **Phase:** 10 (Hardening — Workflow Run 6 Tier A: deployment closure)

## Overview

Closes three deployment-time foot-guns surfaced by the post-Phase-10 deployment audit. The application code already reads `WHATSAPP_APP_SECRET`, `MEDIA_SIGN_SECRET`, and `ACME_EMAIL` from `process.env`, and `.env.example` will document them after this spec — but `docker-compose.yml` was never updated to pipe them into the container environments. The result, pre-spec: an operator could run `docker compose up -d` against a `.env` missing any of the three and the stack would come up looking healthy, then silently fail in three different ways.

- **WHATSAPP_APP_SECRET**: read by `apps/web/src/app/api/webhooks/whatsapp/route.ts` to HMAC-verify the `X-Hub-Signature-256` header on inbound WhatsApp webhook events. If unset, the signature check short-circuits to accept any payload — a forged-webhook RCE adjacent surface that the audit flagged as P0.
- **MEDIA_SIGN_SECRET**: read by `apps/web/src/lib/video/signed-url.ts` (`signMediaToken`) to mint short-lived HMAC tokens for the signed-URL media proxy. If unset, the helper falls back to an empty-string secret — every token verifies, every video and PDF in the system becomes publicly addressable to anyone who can guess a resource UUID.
- **ACME_EMAIL**: read by `docker/Caddyfile` (via `{$ACME_EMAIL:lms-admin@example.org}`) as the Let's Encrypt registration contact. The fallback `lms-admin@example.org` is unmonitored, so production Caddy installs that hit cert-expiry warnings would send the warning into the void.

This spec fixes the gap by adding all three to the appropriate service environment blocks in `docker-compose.yml` using the **strict-fail form** `KEY: ${KEY:?required}`. That form causes `docker compose up` to abort immediately with a clear human-readable error if the var is missing or empty in `.env`, rather than starting a quietly-broken container. It also documents the three keys in `.env.example` with inline comments explaining their purpose, so a fresh operator copying `.env.example -> .env` can't miss them.

## Functional Requirements

- **FR-001** — `docker-compose.yml` `app` service environment block declares `WHATSAPP_APP_SECRET: ${WHATSAPP_APP_SECRET:?...}` with a non-empty required-error message that names the variable and explains its purpose (webhook signature verification).
- **FR-002** — `docker-compose.yml` `app` service environment block declares `MEDIA_SIGN_SECRET: ${MEDIA_SIGN_SECRET:?...}` with a non-empty required-error message that names the variable and explains its purpose (signed-URL HMAC for video + PDF proxy).
- **FR-003** — `docker-compose.yml` `caddy` service environment block declares `ACME_EMAIL: ${ACME_EMAIL:?...}` with a non-empty required-error message that names the variable and explains its purpose (Let's Encrypt registration contact).
- **FR-004** — All three new entries MUST use the strict-fail `${VAR:?message}` form, not the soft-default `${VAR:-fallback}` form. The audit's whole point is that silent fallbacks are the failure mode — operators have to be forced to confront the missing value at boot.
- **FR-005** — `.env.example` contains `WHATSAPP_APP_SECRET=` with a placeholder value and a comment indicating the source (Meta App Settings → Basic).
- **FR-006** — `.env.example` contains `MEDIA_SIGN_SECRET=` with a placeholder generation hint (`openssl rand -base64 32`) matching the style used for `AUTH_SECRET`.
- **FR-007** — `.env.example` contains `ACME_EMAIL=` with a sensible default value (`lms-admin@example.org`) and a comment marking it REQUIRED in production.
- **FR-008** — The 3 new `.env.example` entries are grouped under existing section headers (WhatsApp section for `WHATSAPP_APP_SECRET`; a new "Media signed-URL minting" section for `MEDIA_SIGN_SECRET`; Deployment section for `ACME_EMAIL`) — no orphan keys appended at file end.
- **FR-009** — `docker-compose.yml` continues to parse cleanly (`docker compose config -q` would pass) — i.e., no broken YAML indentation around the inserted lines.
- **FR-010** — No application source code is touched. The three vars are already consumed by code shipped in earlier specs (036+ for media, 040+ for WhatsApp webhook, 002 for Caddyfile); this spec is exclusively a deployment-surface fix.

## Acceptance Criteria

| Behaviour | Verification |
| --- | --- |
| `.env` missing `WHATSAPP_APP_SECRET` | `docker compose up` aborts with "WHATSAPP_APP_SECRET must be set in .env" before any container starts |
| `.env` missing `MEDIA_SIGN_SECRET` | `docker compose up` aborts with "MEDIA_SIGN_SECRET must be set in .env" before any container starts |
| `.env` missing `ACME_EMAIL` | `docker compose up` aborts with "ACME_EMAIL must be set in .env" before any container starts |
| `.env` has all three set | `docker compose up` proceeds normally; `docker exec app printenv WHATSAPP_APP_SECRET` returns the value |
| Fresh operator copies `.env.example -> .env` | All three keys are present with clear placeholder/comment guidance |

## Audit hooks (SM-9)

None. This spec touches deployment YAML, not application code, so no `audit_log` rows are written by anything in this change.

## Out of scope

- Rotating the placeholders in `.env.example` to real default values. Real values come from the operator's own Meta dashboard / `openssl rand` / domain WHOIS — placeholders are correct here.
- Removing the `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN` soft-default form. Those three are already documented as REQUIRED in `README-IT.md`; tightening them to strict-fail is a separate, larger surface to coordinate with the WhatsApp onboarding doc (deferred to a future Tier-B run).
- Changing the Caddyfile default. The `{$ACME_EMAIL:lms-admin@example.org}` fallback inside the Caddyfile is fine — the strict-fail check at the compose layer means Caddy will never actually see the fallback in production. Defence-in-depth.
- Adding a CI / pre-commit lint that all `process.env.X` reads in `apps/web/` are mirrored in `docker-compose.yml`. Worth doing, but a Tier-2 lift; this Tier-A spec only fixes the 3 known-flagged vars.

## Design deviations

None. The strict-fail compose form matches the pattern already used by `POSTGRES_PASSWORD`, `AUTH_SECRET`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `SUPER_ADMIN_EMAIL`, and `SUPER_ADMIN_INITIAL_PASSWORD` in spec 002.
