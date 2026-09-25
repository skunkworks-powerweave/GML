// Looking up a key that came from outside -- a ?error= code, a ?field= name,
// a route slug -- in a plain object literal.
//
// A literal inherits from Object.prototype, so `MAP["__proto__"]` is an
// object and `MAP["constructor"]` a function, and neither is caught by
// `?? fallback` or a truthiness check. Pages rendered what came back: an
// object as a React child throws ("Objects are not valid as a React child"),
// so /admin/whatsapp-log?error=__proto__ could not render for whoever opened
// the link, and a function renders nothing, so ?error=constructor showed an
// empty alert. /admin/data/__proto__ found an "entity" with no readRoles and
// threw inside requireRole instead of answering 404.
//
// Only the map's OWN keys count, and only a string key: a repeated
// ?error=a&error=b arrives as an array.

/** `map[key]` when `key` is one of the map's own keys, otherwise undefined. */
export function lookupOwn<T>(map: Readonly<Record<string, T>>, key: unknown): T | undefined {
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}
