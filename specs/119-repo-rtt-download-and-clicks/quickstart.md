# Quickstart 119 — Tier H download/click fixes

Manual smoke (1 minute): boot the app, sign in, open any seeded
rtt-subject page. Confirm the header shows a "Resume" button; click
it and the page scrolls/anchors to the first module row (or the
modules card if the subject has no modules). Each session row's Date
and Session cells navigate to /repo/session/<id> on click, and the
right-most column shows a "Join" (upcoming) or "Watch" (past) button.
Readings with externalUrl still open externally; readings with a
fileKey but no externalUrl now render a "View" button pointing at
the in-browser PDF viewer. Below the readings card, an Assessment
card now shows Mid-unit Start and Endline Locked links; both will
404 until Run 10's quiz route lands, which is intentional.
