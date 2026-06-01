# Plan 104

CREATED: `packages/db/src/scripts/seed_all.ts`, `specs/104-form-catalog-seed-runner/{spec,plan,research,quickstart,tasks}.md`, `tests/governance/test_104_form_catalog_seed_runner.test.mjs`
EDITED: `packages/db/package.json` (add `seed:all` script), `packages/db/src/scripts/seed.ts` + `seed_forms_mentor.ts` + `seed_forms_mentee.ts` + `seed_forms_observation.ts` + `seed_forms_misc.ts` (`async function main()` → `export async function main()` and guard auto-run with `import.meta.url === pathToFileURL(process.argv[1]).href`)
MIGRATED: none
