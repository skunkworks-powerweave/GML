# Spec 006 — Auth.js Magic Link

**Status:** in_progress · **Constitution Check:** N/A

## Overview
Add email magic-link provider to the existing Auth.js config. Used by admin/mentor staff with reliable mail; teachers stay on credentials.

## User Stories
**US1**: From `/login`, an admin can enter their email, receive a one-time link via SMTP, click it, and be signed in.
**Independent Test**: POST `/api/auth/signin/email` with email → SMTP receives mail with link → click → session created.

## Functional Requirements
- **FR-001**: `apps/web/src/auth.ts` adds `next-auth/providers/nodemailer` provider, server reads SMTP_* env vars.
- **FR-002**: Magic links expire after 10 minutes (token stored in `verification_tokens`).
- **FR-003**: Login UI shows an "or sign in with email link" affordance below the password form.
- **FR-004**: Email subject/body is GML-branded plain HTML.
