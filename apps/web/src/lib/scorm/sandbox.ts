// The sandbox SCORM content runs under: the player's <iframe sandbox> and the
// content route's CSP `sandbox` directive (lib/csp.ts) carry the same flags,
// so content opened directly in a tab is no less confined than framed.
//
//   allow-scripts, allow-same-origin
//       Together they give the content back its script and its origin, which
//       a SCO needs: it finds the runtime by reading window.parent.API, a
//       same-origin access. That pairing is also why the sandbox is NOT the
//       security boundary for what a package's script can do on this origin
//       -- the upload is (super_admin only, lib/scorm/ingest.ts). What the
//       sandbox still removes is everything below.
//   allow-forms, allow-popups, allow-modals
//       Authoring tools post in-course forms, open resource windows and use
//       alert()/confirm() ("Leave the course?").
//
// Absent on purpose: allow-top-navigation (content must not navigate the app
// away or replace it with a look-alike), allow-downloads, allow-pointer-lock,
// allow-popups-to-escape-sandbox.

export const SCORM_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-modals";
