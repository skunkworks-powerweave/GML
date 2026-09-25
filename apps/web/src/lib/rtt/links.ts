// An RTT session's meeting link or recording, as something safe to put in an
// href (F44).
//
// rtt_sessions.link_or_recording was any string, rendered straight into
// "Join" / "Watch". Meet and Calendar display a meeting as
// "meet.google.com/abc-defg-hij" -- no scheme -- and pasted like that it
// resolved relative to the page, so Join opened an in-app 404 at session time;
// a `javascript:` value went into the href as well. The admin grid now stores
// only http(s) links (admin/entities/rtt-sessions.ts), normalising a bare host
// through this function; the pages use it too, for rows stored before that.

// A bare host, optionally with a port, then a path or nothing:
// "meet.google.com/abc", "zoom.us:443/j/1". Needs a dot, so "javascript:x",
// "mailto:x" and a relative "/path" are not hosts.
const BARE_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?([/?#]|$)/i;

/** An http(s) URL for `raw`, or null when it is not a web link. */
export function webLink(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  const candidate = /^https?:\/\//i.test(value) ? value : BARE_HOST.test(value) ? `https://${value}` : null;
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? candidate : null;
  } catch {
    return null;
  }
}
