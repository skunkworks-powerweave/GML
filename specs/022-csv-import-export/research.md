# Research 022
papaparse handles both directions cleanly. Server-side: `Papa.unparse({fields, data})` for export, `Papa.parse(csv, {header: true})` for import. Zod schemas already in each entity validate row shape — no extra coercion needed beyond bool-string handling.
