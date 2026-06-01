# Tasks 126

- [x] T1 → write governance test (red) covering filename existence, role gate, source filter, action prefix join, resend action shape, button rewire → run the suite → red.
- [x] T2 → implement `/admin/whatsapp-log/page.tsx` (server component, requireRole, source='whatsapp' query, audit-log left join on entityId for sender phone, filter form, 100-row table with Resend column).
- [x] T3 → implement `/admin/whatsapp-log/actions.ts` (use server, requireRole, files+submission lookup, transcodeQueue.add, recordAudit('whatsapp.transcode.resent'), revalidatePath + redirect).
- [x] T4 → edit `/videos/page.tsx` to flip the "WhatsApp ingest log" Link href to /admin/whatsapp-log and gate visibility via hasAnyRole(programme_admin, super_admin).
- [x] T5 → author all five spec-kit files under specs/126-whatsapp-ingest-log-page/.
- [x] T6 → run `pnpm test -- --grep "spec 126"` (or the full suite scoped to test_126_*) and confirm green.
- [ ] T7 (future) → if the audit-log surface ever grows a `LIKE` filter, deprecate the JSX-prototype-era /admin/audit?action=whatsapp. URL and 301 it to /admin/whatsapp-log via middleware. Out of scope for spec 126 because the URL had zero callers other than the broken button this spec fixes.
