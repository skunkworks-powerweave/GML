#!/usr/bin/env node
// PreToolUse Edit/Write hook on packages/db/src/schema/** — reminds the operator that
// schema changes need a matching `drizzle-kit generate` migration file before they're
// committed. Non-blocking (exit 0); just prints a warning.

console.error("[warn_schema_change] reminder: run `pnpm --filter @gml/db generate` after editing schema.");
process.exit(0);
