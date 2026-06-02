# Quickstart 131 — Prior-response prefill + top-right saved indicator

Manual smoke (3 minutes):

1. Boot the stack: `pnpm dev` (web) + `pnpm --filter @gml/worker
   dev` (transcode worker) + the docker-compose db/redis/minio.

2. Sign in as a teacher with a known mentor pairing (the seed
   user from spec 102's bootstrap if you're on a fresh DB).

3. From `/inbox`, click a feedback form for the first time.
   Confirm:
   - The form opens blank.
   - In the top-right of the form card you see
     `Not saved yet` (mono font, muted color).
   - Type a few characters in any field. After ~1 s the
     indicator flips to `Saving…`, then `Saved 0s ago`,
     then ticks `1s`, `2s`, `3s` — one per second.

4. Fill the form fully and press Submit. You're redirected
   to `/forms/[slug]/thanks`.

5. From `/inbox` again, click the **same** form (same
   pairingId in the URL). Confirm:
   - The form is pre-filled with your prior answers — every
     field, every value.
   - In the top-right you see `Not saved yet` (no draft has
     been touched yet for this fresh session).
   - Change a single answer. After ~1 s the indicator
     becomes `Saved 0s ago` and you have a new draft on
     top of the prior response.

6. Now refresh the page. The draft you just wrote takes
   precedence over the prior response, so you see your
   one-character edit applied to the otherwise-prior
   values. Confirm the indicator reads `Not saved yet`
   on the fresh page load (drafts are loaded into form
   state but `lastSavedAt` is not seeded until the next
   debounced save fires).

## Error-state smoke

Open dev-tools → Network → block the `/api/form-drafts/*`
URL pattern. Type into a field. Within 1–2 s the indicator
flips to `Save failed — retrying…` in `var(--rust)` color
(rusty red). Unblock the URL, type again — the indicator
flips back to `Saved 0s ago`.

## Autosave-disabled smoke

A caller mounting `<FormRenderer>` without a `draftKey`
prop (or with one missing both `templateId` and
`observationCycleId`) gets no indicator at all — the
top-of-card row is not rendered. Verify by editing
`forms/[slug]/page.tsx` locally to drop the
`draftKey={...}` prop and reload the page: the indicator
disappears.
