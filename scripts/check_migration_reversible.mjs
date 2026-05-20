#!/usr/bin/env node
// PostToolUse Edit/Write hook on apps/web/src/db/migrations/** — placeholder for
// future logic that parses the migration and verifies it has a down() / rollback
// path. For now just prints a reminder. Non-blocking.

console.error("[check_migration_reversible] reminder: ensure migration has a tested rollback path.");
process.exit(0);
