// Shared between /api/admin/audit/export and the /admin/audit page, so the
// page can tell the operator BEFORE they click that an export would be
// refused, and why. (A route file may only export its handlers.)

/** The export answers 413 above this many matching rows. */
export const AUDIT_EXPORT_ROW_CAP = 10000;
