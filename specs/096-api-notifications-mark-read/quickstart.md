# Quickstart 096
Sign in → /inbox → click "Mark all read" → endpoint flips `read_at` on every unread row for the user, fires `notifications.mark_read` audit, 303-redirects back to /inbox where the badge is now clear.
