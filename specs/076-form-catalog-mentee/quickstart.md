# Quickstart 076

Run `DATABASE_URL=postgres://... npx tsx packages/db/src/scripts/seed_forms_mentee.ts` from the repo root; verify `SELECT count(*) FROM feedback_forms WHERE audience='mentee'` returns 4. Re-run the same command and confirm all 4 lines log `[skip]`.
