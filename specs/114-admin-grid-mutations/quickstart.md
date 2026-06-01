# Quickstart 114
- Visit `/admin/data/schools` → see Edit + Delete buttons per row and a filter toolbar.
- Click "Edit" on any row → URL becomes `?edit=<id>`, form prefills, Submit calls `updateRowAction`.
- Click "Delete" → native confirm dialog; OK posts to `deleteRowAction` and writes audit `admin.row.delete`.
- Type into a filter input + Apply → URL becomes `?filter[name]=foo`; rows narrow via `ilike`. Clear strips filters. Pagination links preserve filters.
