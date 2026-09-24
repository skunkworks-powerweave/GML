// Stands in for `next/headers` (see ../_ui.ts): serves the fake request the
// test prepared.

type State = { cookies: Record<string, string>; headers: Record<string, string> };
const state = () =>
  ((globalThis as Record<string, unknown>).__gmlTestRequest ?? { cookies: {}, headers: {} }) as State;

export async function cookies() {
  const jar = state().cookies;
  return {
    get: (name: string) => (name in jar ? { name, value: jar[name] } : undefined),
    has: (name: string) => name in jar,
    getAll: () => Object.entries(jar).map(([name, value]) => ({ name, value })),
  };
}

export async function headers() {
  const map = state().headers;
  return {
    get: (name: string) => map[name.toLowerCase()] ?? null,
    has: (name: string) => name.toLowerCase() in map,
  };
}
