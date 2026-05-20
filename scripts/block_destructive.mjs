#!/usr/bin/env node
// PreToolUse Bash hook — refuses to let destructive commands run without explicit
// override. Pattern-matches on the raw Bash command string passed via $TOOL_INPUT.

const input = process.argv[2] ?? "";
const denyPatterns = [
  /\brm\s+-rf\b/i,
  /\bDROP\s+TABLE\b/i,
  /\bDROP\s+DATABASE\b/i,
  /\bdocker\s+compose\s+down\s+-v\b/i,
  /\bdocker\s+volume\s+rm\b/i,
  /\bgit\s+push\s+(--force|-f)\b/i,
  /\bgit\s+reset\s+--hard\b/i,
];

for (const re of denyPatterns) {
  if (re.test(input)) {
    console.error(`[block_destructive] refusing: matches ${re}. Explicitly override if intentional.`);
    process.exit(2);
  }
}
process.exit(0);
