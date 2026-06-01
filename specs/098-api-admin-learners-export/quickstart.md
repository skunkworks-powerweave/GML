# Quickstart 098

Log in as `super_admin` → visit `/repo/students` → click "Export CSV" in the page header → browser downloads `learners-YYYYMMDD.csv` (columns: id, name, age, grade, school_code, class_label, guardian, attendance_pct) and an `audit_log` row appears with `action='learners.bulk_export'`, `entity_type='all'`, `metadata.piiAudited=true`, `metadata.rowCount=<actual>`. Log in as `programme_admin` instead → the Export CSV button is hidden on /repo/students, and a direct GET to `/api/admin/learners/export` returns 403 `{error: "forbidden"}`.
