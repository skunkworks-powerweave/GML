// Stands in for `next/headers` (see ../_ui.ts): serves the fake request the
// test prepared.
//
// cookies().set() / .delete() write back into the same jar, as a Route Handler
// or Server Action's cookie store does, and every write is also recorded with
// its options in `cookieWrites` -- the attributes a session cookie is written
// with (Secure, Max-Age) are what the auth tests assert on.

type CookieWrite = { name: string; value: string; options: Record<string, unknown> };
type State = {
  cookies: Record<string, string>;
  headers: Record<string, string>;
  cookieWrites?: CookieWrite[];
};
const state = () =>
  ((globalThis as Record<string, unknown>).__gmlTestRequest ?? { cookies: {}, headers: {} }) as State;

export async function cookies() {
  const s = state();
  const jar = s.cookies;
  const record = (w: CookieWrite) => (s.cookieWrites ??= []).push(w);
  return {
    get: (name: string) => (name in jar ? { name, value: jar[name] } : undefined),
    has: (name: string) => name in jar,
    getAll: () => Object.entries(jar).map(([name, value]) => ({ name, value })),
    set: (name: string, value: string, options: Record<string, unknown> = {}) => {
      record({ name, value, options });
      if (options.maxAge === 0 || value === "") delete jar[name];
      else jar[name] = value;
    },
    delete: (name: string) => {
      record({ name, value: "", options: { maxAge: 0 } });
      delete jar[name];
    },
  };
}

export async function headers() {
  const map = state().headers;
  return {
    get: (name: string) => map[name.toLowerCase()] ?? null,
    has: (name: string) => name.toLowerCase() in map,
  };
}
