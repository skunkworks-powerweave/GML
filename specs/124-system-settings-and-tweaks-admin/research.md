# Research 124

Three small decisions, each documented inline:

1. **Singleton enforcement at the DB layer.** The JSX prototype only ever
   needed one row of admin settings — there's no per-tenant scope yet.
   We pin the id to a well-known nil-uuid+1 sentinel via a CHECK
   constraint rather than the more elaborate single-row-table tricks
   (e.g. a one-row materialized view, or an enum-keyed table) because
   (a) the CHECK is one line of DDL and (b) Drizzle's snapshot format
   already supports CHECK constraints (see form_drafts_one_scope as
   precedent). When multi-tenant lands the CHECK becomes the unique
   constraint to drop, and the id column becomes a tenant_id FK.

2. **Server action instead of client fetch.** The JSX panel is a plain
   form with text inputs, a number input, a select, checkboxes — no
   client-side autosave or debounced PUT. Using an inline server
   action plus revalidatePath keeps the entire page on the server
   boundary with no client bundle cost for forms-of-fields. The
   /settings page (user_prefs) needed delta-PUT autosave because the
   UX target was "save as you toggle"; the admin surface is "click
   Save Changes" so the action model fits.

3. **Backup/restore status from audit_log, not from a separate table.**
   The spec offers a choice between "workspace files" and "audit
   log". The audit log is the durable, queryable source of truth for
   "did this thing happen and when" across the platform — using it
   means adding the backup-emission later is a one-line recordAudit
   call inside the script, not a new table+migration. The cost is
   that until the script is updated the status display shows "never"
   for both rows. The page surfaces that fact in plain text rather
   than fabricating a fallback from /backups/last-backup.txt, which
   the Next.js server would need shell access to read.

## Design deviations from the brief

- The brief permitted reading workspace files (last-backup.txt) for
  the status panel. We chose audit_log only because the Next.js
  server in production may not have a mount for /backups. Document
  this as a deferred enrichment: a follow-up spec can either land
  the backup-emit-audit step or add a server-side /admin/backups
  detail route that reads the host file via a privileged shell.

- The spec called for the migration index to be 0016 if both 120 and
  123 added migrations this run. Spec 123 (ftux-tour) added no
  migration, so 124 takes 0015 (sequentially next after 120's quizzes
  schema at 0014). The journal entry reflects this.
