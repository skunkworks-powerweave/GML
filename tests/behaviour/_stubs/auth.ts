// Stands in for apps/web/src/auth.ts (see ../_ui.ts). The shells only hand
// signOut to a <form action>, which a static render never submits.
//
// auth() answers with whatever session a test put on the shared fake request
// (`request.session` in ../_ui.ts), and null otherwise -- so a test can call a
// real route handler or server action AS a given role, and the guards in front
// of it (requireRole, requireApiRole) run unmodified.

type State = { session?: unknown };
const state = () => ((globalThis as Record<string, unknown>).__gmlTestRequest ?? {}) as State;

export async function auth() {
  return state().session ?? null;
}

export async function signOut(): Promise<never> {
  throw new Error("signOut is not callable from a render test");
}

export async function signInWithPassword(): Promise<never> {
  throw new Error("signInWithPassword is not callable from a render test");
}
