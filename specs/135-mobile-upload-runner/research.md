# Research 135 — mobile upload runner

## JSX prototype reference

`LMS GML Frontend/mobile-runners.jsx` lines 181-294 (`MobUpload` component).

Three steps (`choose | uploading | done`) plus an implicit `failed`
state we add for production parity. The prototype simulates upload
progress with a `setInterval`; we wire it to real tus events instead.

The mobile-runners.jsx prototype actually shows THREE option cards in
the `choose` step (WhatsApp / Pick file / Record in app), where the
WhatsApp card is the lichen-tinted primary path. The task in this spec
explicitly asks for **two big tiles** (Record + Pick) with the
WhatsApp reminder relegated to a card *below* the tiles. This is a
deliberate deviation — the WhatsApp option lives in the lichen-soft
reminder card at the bottom because the production flow has
`/whatsapp-fallback` and the `wa.me/` href already, and the desktop
UploadModal (spec 132) handles the discoverability story.

## Why not extend `UploadProgress`?

`UploadProgress` (spec 045) is a desktop "tray" — a small panel that
sits inline in a page and accumulates a list of in-progress uploads.
The mobile flow is a full-screen state machine: one file at a time,
one big progress display, a Preview step, and a redirect on success.
Forking a sibling component is cleaner than forcing both UIs through
one component with five conditional branches and a "compact vs
full-screen" prop.

Crucially, `UploadProgress` keeps a *list* of uploads (so a user can
queue multiple); the mobile runner does not — touch input + 4G makes
queueing multiple uploads brittle, and the user is much better served
by being shepherded through one upload at a time.

## Why two file inputs?

iOS and Android browsers differ in how they handle `<input
type="file" capture="environment">`. iOS opens the *camera* directly;
Android opens a chooser asking "Camera vs Files". To get the
"definitely the camera" experience on the Record tile and the
"definitely the gallery" experience on the Pick tile, we mount two
separate `<input>` elements and toggle visibility off both. Each tile
button programmatically clicks the right one. This is the standard
PWA pattern (e.g. Google Drive's mobile uploader does this same dual-
input trick).

## Why extract the first frame for the thumbnail?

Two reasons:

1. **Trust** — teachers in Ladakh often take 5-10 attempts at recording
   before they get a usable take. Showing them the first frame on the
   preview screen lets them spot "wrong take" before they spend 40MB
   of mobile data uploading.
2. **No server cost** — we draw the frame on a hidden `<canvas>` and
   render the resulting data URL as an `<img>`. No upload happens
   until the user clicks Start. The thumbnail never leaves the device.

For codecs the browser can't decode (some 3GP variants on older
Android), `extractFirstFrame` returns null and we render a small
"Preview unavailable" placeholder. The upload still works — the
preview is a UX nicety, not a gate.

## Why redirect after success?

The desktop flow has the recent-uploads table directly under the
upload tray; the user sees the new row appear on the same page. On
mobile, the runner takes up the whole viewport, so after success we
need to take the user somewhere that confirms the upload landed. The
simplest answer is `/uploads` (where the recent-uploads table will
render as the only content after the runner unmounts), wrapped in a
1.2s "Uploaded" success screen so the user gets the visual
confirmation before the navigation.

## Why `getDeviceType()` server-side?

The `gml-device` cookie + UA fallback contract (apps/web/src/lib/device.ts,
spec 011) already exists for the chrome shell selection. Reading it
server-side in the page handler means we never ship the mobile JSX
to a desktop user (or vice-versa) — the wrong component literally
isn't in the DOM. This is the same pattern the `DesktopShell` /
`MobileShell` selection uses.

The client-side `useDeviceType` (spec 011) handles the "user resized
the window" case by updating the cookie, so the next navigation
picks up the new device. We don't need it inside this component —
the user is either on a phone or a desktop for the duration of an
upload, and the runner unmounts on success anyway.

## Touch target constants

- Apple HIG: 44pt minimum.
- Material Design: 48dp recommended.
- WCAG 2.5.5: 24×24 CSS px minimum, 44×44 enhanced.

We use 56px for the two primary tiles (well above all three rules)
and 48px for the secondary Back / Start / Cancel buttons. The
WhatsApp fallback link uses `min-height: 44` — the actual hit area
is the full card it sits inside, but the link itself stays comfy.

## Safe-area handling

Three `env(safe-area-inset-*)` sites:

1. `paddingTop: env(safe-area-inset-top, 0)` — for the notch.
2. `paddingBottom: calc(16px + env(safe-area-inset-bottom, 0))` —
   so the sticky Cancel CTA doesn't hide under the iOS home indicator.
3. `paddingLeft/Right: max(16px, env(safe-area-inset-left/right, 0))`
   — for landscape orientation on notched devices.
