#!/usr/bin/env node
// PostToolUse (Edit|Write|MultiEdit) — MIGRATION HYGIENE.
//
// What this replaces: a hook whose entire body was a comment reading
// "placeholder for future logic" followed by exit 0. It was wired into
// settings.json with a `pathGlob` that is not a config field, so it fired on
// every single Edit and Write in the project and then did nothing, twice over.
//
// What this can and cannot do: a PostToolUse hook runs AFTER the write has
// already hit the disk, so it cannot undo anything. Everything here is advisory
// by construction — it uses feedback() to put the problem in front of Claude
// while the migration is still the thing being worked on. The commit gate in
// pre-bash.mjs is the backstop for anything that matters; this hook exists so
// that a bad migration is caught at the moment it is written rather than at the
// moment someone tries to commit it.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { PROJECT_DIR, allow, feedback, readInput } from "./_lib.mjs";

const MIGRATIONS = "packages/db/src/migrations";

/** The edited path, relative to the repo, with forward slashes. */
function repoRelative(filePath) {
  if (!filePath) return "";
  const abs = isAbsolute(filePath) ? filePath : resolve(PROJECT_DIR, filePath);
  const rel = relative(PROJECT_DIR, abs);
  if (!rel || rel.startsWith("..")) return "";
  return rel.split(/[\\/]/).join("/");
}

/** The tags drizzle-kit has recorded. Missing/!JSON journal yields null. */
function journalTags() {
  const p = resolve(PROJECT_DIR, MIGRATIONS, "meta", "_journal.json");
  try {
    if (!existsSync(p)) return null;
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    if (!Array.isArray(parsed?.entries)) return null;
    return parsed.entries.map((e) => e?.tag).filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * The file's SQL with comments removed.
 *
 * Every check below scans for SQL constructs, and a comment that mentions one
 * must not trip it — a migration whose header explains "we deliberately avoid
 * CREATE INDEX CONCURRENTLY here" is correct code, not a defect, and a hook
 * that scolded it would be wrong on its very first true-negative and get
 * switched off. Line comments and block comments both go.
 */
function strippedSql(rel) {
  const raw = readFileSync(resolve(PROJECT_DIR, rel), "utf8");
  return {
    raw,
    sql: raw.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " "),
  };
}

/** Index and table names a raw SQL file creates, unqualified and unquoted. */
function declaredObjects(sql) {
  const names = new Set();
  const patterns = [
    /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([\w."]+)/gi,
    /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w."]+)/gi,
  ];
  for (const re of patterns) {
    for (const m of sql.matchAll(re)) {
      const bare = m[1].replace(/"/g, "").split(".").pop();
      // Drop the generic bookkeeping table migrate.ts creates itself, and
      // anything too short to be a meaningful search term.
      if (bare && bare.length > 2 && bare !== "_post_migrations_applied") {
        names.add(bare);
      }
    }
  }
  return [...names];
}

/** The schema file that also declares `name`, or "" — the drift check. */
function schemaFileDeclaring(name) {
  const dir = resolve(PROJECT_DIR, "packages", "db", "src", "schema");
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
  } catch {
    return "";
  }
  // Matched as a quoted literal, because that is how drizzle names an object:
  // index("widgets_name_idx"), pgTable("widgets", ...). A bare substring search
  // would fire on any identifier that merely contains the name.
  const needle = new RegExp(`["'\`]${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]`);
  for (const f of files) {
    try {
      if (needle.test(readFileSync(resolve(dir, f), "utf8"))) {
        return `packages/db/src/schema/${f}`;
      }
    } catch {
      // An unreadable schema file is not this hook's problem to report.
    }
  }
  return "";
}

function main() {
  const input = readInput();
  const tool = input.tool_name;
  // Defensive: settings.json is supposed to scope this to the edit tools, but
  // the last generation of hooks proved that the scoping field can be fiction.
  if (tool && !["Edit", "Write", "MultiEdit"].includes(tool)) allow();

  const rel = repoRelative(input.tool_input?.file_path);
  if (!rel.startsWith(`${MIGRATIONS}/`)) allow();

  const notes = [];
  const numbered = rel.match(new RegExp(`^${MIGRATIONS}/(\\d{4}_[^/]*)\\.sql$`));

  if (numbered) {
    const tag = numbered[1];
    const { raw, sql } = strippedSql(rel);

    // A DROP is the one migration that cannot be walked back by writing another
    // migration: the data is gone. The rule is not "don't drop" — it is "say why
    // in the file", so that whoever reads it during an incident knows whether
    // the loss was intended and whether a backup was taken first. The `raw`
    // text is searched here rather than `sql`, because the marker IS a comment.
    const drops = [];
    if (/\bDROP\s+TABLE\b/i.test(sql)) drops.push("DROP TABLE");
    if (/\bDROP\s+COLUMN\b/i.test(sql)) drops.push("DROP COLUMN");
    if (drops.length && !/^[ \t]*--[ \t]*irreversible:/im.test(raw)) {
      notes.push(
        `${rel} contains ${drops.join(" and ")} but carries no justification. ` +
          `Way forward: add a line starting \`-- irreversible:\` to the file ` +
          `saying what is being destroyed, why it is safe, and what was done ` +
          `about the existing rows (backfilled, exported, or accepted as lost).`,
      );
    }

    // packages/db/scripts/migrate.ts hands each file to drizzle's migrator,
    // which runs it inside BEGIN/COMMIT. CREATE INDEX CONCURRENTLY cannot run
    // in a transaction block — Postgres rejects it outright — so this fails at
    // deploy time, on the `migrate` container, against the real database, long
    // after anyone could have caught it cheaply.
    if (/\bCREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i.test(sql)) {
      notes.push(
        `${rel} contains CREATE INDEX CONCURRENTLY. The migration runner wraps ` +
          `every file in a BEGIN/COMMIT transaction (packages/db/scripts/migrate.ts), ` +
          `and Postgres refuses CONCURRENTLY inside a transaction block, so this ` +
          `will fail at deploy time rather than here. Way forward: drop ` +
          `CONCURRENTLY for a plain CREATE INDEX, or move the statement to a file ` +
          `under ${MIGRATIONS}/_post/ if the table is large enough that the lock ` +
          `matters — note that _post files are transaction-wrapped too, so a truly ` +
          `concurrent build has to be run by hand against the database.`,
      );
    }

    const tags = journalTags();
    // A migration file drizzle-kit never recorded is invisible to the runner:
    // `migrate()` walks _journal.json, not the directory listing, so the file
    // silently never runs and the schema drifts from the code that assumes it.
    if (tags && !tags.includes(tag)) {
      notes.push(
        `${rel} is not listed in ${MIGRATIONS}/meta/_journal.json, so drizzle's ` +
          `migrator will never run it — it walks the journal, not the directory. ` +
          `Way forward: regenerate with \`pnpm --filter @gml/db generate\`, or add ` +
          `an entry with tag "${tag}" to the journal's "entries" array.`,
      );
    }
  }

  // The _post lane is deliberately exempt from the rules above: its files are
  // not journalled (migrate.ts tracks them in _post_migrations_applied instead)
  // and dropping things is most of what they are for — 003_supabase_identity.sql
  // alone drops four tables. What they must not do is duplicate the drizzle lane.
  if (rel.startsWith(`${MIGRATIONS}/_post/`) && rel.endsWith(".sql")) {
    const { sql } = strippedSql(rel);
    for (const name of declaredObjects(sql)) {
      const owner = schemaFileDeclaring(name);
      // Drizzle generates from the schema files; it does not know a _post file
      // already created the object. The next `drizzle-kit generate` therefore
      // emits a bare CREATE INDEX for it, which fails on every database where
      // the _post file has already run — and passes on a fresh one, so the
      // break only shows up in the environment that matters.
      if (owner) {
        notes.push(
          `${rel} declares "${name}", which is also declared in ${owner}. ` +
            `Those are two lanes for one object: drizzle-kit generates from the ` +
            `schema without knowing the _post file already created it, so the ` +
            `next generated migration emits a bare CREATE for "${name}" that ` +
            `fails wherever ${rel} has run and passes on a fresh database. ` +
            `Way forward: pick one lane — drop the declaration from ${owner} if ` +
            `the _post file owns it, or delete it from ${rel} and let drizzle ` +
            `generate it.`,
        );
      }
    }
  }

  if (notes.length) feedback(`[migration hygiene] ${notes.join("\n\n")}`);
  allow();
}

// A hook must never crash: a thrown error here would surface as a broken hook
// on every edit in the repo, and the fix would be to delete the hook.
try {
  main();
} catch {
  allow();
}
