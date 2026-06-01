# Quickstart 121 — QuickFind ⌘K / Ctrl+K overlay

Manual smoke (2 minutes): boot the app, sign in, then anywhere in the
authenticated shell press `Cmd+K` (mac) or `Ctrl+K` (Windows / Linux).
A search modal appears, centered, with an input pre-focused. On first
open the modal shows an empty-state `Recently viewed · Start typing to
search across the repository.`

Type at least 2 characters of a teacher name, school code, subject,
class teacher, observation-cycle code, outline name, or session topic.
After ~180ms the result list populates. Use `↓` and `↑` to move the
selection highlight, `Enter` to navigate to the result, or click a row
directly. Both keyboard and mouse selection close the modal and write
the selected row to localStorage at `gml.quickfind.recent.<your-userId>`
— next time you open the modal without typing, the recents card shows
your most-recent five selections.

Verify the close affordances:
- Press `Esc` while typing → modal closes, query is discarded.
- Click anywhere outside the white card → modal closes.
- Hit `Cmd+K` again → modal toggles closed.

Audit verification (1 query):

```sql
SELECT created_at, metadata
FROM audit_log
WHERE action = 'quickfind.query'
ORDER BY created_at DESC
LIMIT 10;
```

You should see one row per debounced fetch, with `metadata.q` set to
the trimmed query text and `metadata.resultCount` set to the count
returned (post-`HARD_CAP=20` cap).

Negative path (no auth):

```bash
curl -i http://localhost:3000/api/quickfind?q=test
# → HTTP/1.1 401 Unauthorized
# {"error":"unauthenticated"}
```

POST / PUT / DELETE / PATCH against the same URL return 405
`method_not_allowed` to keep the method matrix tidy.
