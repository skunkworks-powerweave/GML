# Research 088

## D-001 — Three layers, no DRM

Investigated EME / MediaSource encrypted playback; rejected as out of scope (Widevine licensing, kiosk targets without certified CDM, opaque on Android low-bandwidth devices). Kept honest: deterrence-only via CSS + keydown + DevTools-heuristic. The JSDoc and README-IT.md sign-in copy explicitly enumerate the bypass paths (DevTools / OS screen capture / proxy interception) so we don't drift into security theatre.

## D-002 — DevTools detector is a weak signal, audited as such

The `outerHeight - innerHeight > 200` heuristic only fires on docked panels and false-positives on browsers with permanent toolbars (some Linux DEs). We audit the *event* with metadata `weak_signal: true` and throttle to one per session — operators reviewing the audit log treat it as a hint, not proof.
