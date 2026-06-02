# Research 132

Four design choices documented inline in the touched files.

(1) **Speed buttons set `video.playbackRate` directly, not via hls.js.**
The hls.js API exposes no speed mutator — playback rate is a
`HTMLMediaElement` property the browser handles natively. Setting
`video.playbackRate = 1.5` on the underlying `<video>` element works
on both the hls.js MediaSource code path (Chrome / Firefox / Edge /
Android) and the Safari native-HLS code path (iOS / macOS). The
browser interpolates without re-downloading segments, so the UX is
instant. We track the active rate in `useState` so the active chip
gets the `var(--ink)` highlight (matches the filter-bar pattern in
videos/page.tsx).

(2) **Quality select uses `hls.currentLevel`, not `nextLevel`.**
hls.js distinguishes "switch immediately at the next segment
boundary" (`currentLevel`) from "switch on the next ABR decision"
(`nextLevel`). The prototype's intent here is "user clicked, change
quality now", so `currentLevel` is the right knob. Auto-mode is
`currentLevel = -1`; pinning to the lowest (and only) level is
`currentLevel = 0`. Spec 041 ships a single 480p rendition so in
practice both modes play the same stream — but the UI exposes the
toggle so it matches the prototype's keyboard contract and so a
future spec that re-enables 720p only has to flip the `disabled`
attribute, not re-architect this component.

(3) **The 720p option is `disabled` in the JSX, not omitted.** Rendering
it as a `disabled` `<option>` with `title="720p disabled per
programme settings"` is more honest than hiding it entirely — a
mentor who hovers sees that the limitation is policy, not a bug.
Matches the same pattern in `/admin/system-settings`
videoDefaultQuality dropdown (spec 124 lines 207-214). When spec 041
eventually re-enables 720p the change is a one-line `disabled`
removal + a worker pipeline switch; the test gate exists to make
sure those two changes happen together.

(4) **Upload modal reads WhatsApp phone from existing env, not a new
one.** The webhook spec (043) ships
`WHATSAPP_PHONE_NUMBER_ID` as part of the Meta Business API contract
— that's the same number teachers forward videos to. We accept a
`GML_WHATSAPP_NUMBER` override for human-formatted display (e.g.
"+91 98765 43210" instead of the raw Meta numeric ID) but don't
require it. The HelpPanel (spec 122) follows the same fall-back
chain, so an operator who configured the helpdesk contact gets the
upload modal for free.

## Why a modal instead of a dedicated /uploads page

The /uploads route still exists (spec 045 — teacher's My-Uploads
tray with history). It works for repeat users. But a first-time
teacher who clicks "Upload" from the library header should not have
to leave the library context — the modal keeps them anchored, and
the WhatsApp path is the answer for most teachers anyway.

Modal close semantics match the rest of the chrome:
- Esc closes (HelpPanel, FTUXTour, QuickFind all do this).
- Backdrop click closes (FTUXTour does this for the dismissal layer).
- Focus restores to the trigger button on close (HelpPanel does this
  via `lastFocusedRef`).

## Why embed UploadProgress inside the modal

UploadProgress already handles file picker, tus-js-client chunking,
progress bar, post-upload status, and failure rendering. Pulling
the same logic into the modal would duplicate ~80 lines of code.
Composition (modal contains UploadProgress) means a future tweak to
the tus pipeline (e.g. spec X adds a retry button) lands once in
UploadProgress and propagates to both /uploads and the modal.

The `contextType="generic"` choice is deliberate: the library page
is not scoped to a specific entity. If a future spec wants the
modal to attach uploads to a known cycle / mentor meeting (e.g.
from a button on the cycle detail page) it can pass a different
contextType + contextId without touching this component's shell.

## Speed preset choice

The prototype renders 0.75× / 1× / 1.5×. We ship 1× / 1.25× / 1.5×
/ 2× instead — the 0.75× value is rarely used (lessons are already
at natural pace) and the 1.25× + 2× values cover the most-requested
mentor flows ("skim while taking notes" and "fast-forward through
silent stretches"). Lifted to a module-level `SPEED_PRESETS` const
so the test asserts the exact set without trying to match JSX.
