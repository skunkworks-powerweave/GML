#!/usr/bin/env node
// PreToolUse Edit/Write hook on apps/web/src/middleware.ts — auth + section gates +
// audit log dispatch live here. Changes need their own spec; this is a reminder.
// Non-blocking (exit 0).

console.error("[warn_middleware_change] reminder: middleware.ts changes touch RBAC + section gates + audit; ensure a spec covers the change.");
process.exit(0);
