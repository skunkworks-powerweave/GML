// Stands in for apps/web/src/auth.ts (see ../_ui.ts). The shells only hand
// signOut to a <form action>, which a static render never submits.
//
// auth() answers with whatever session a test signed in, and null otherwise --
// so a test can execute a real page, route handler or server action AS a given
// user, and the guards in front of it (requireRole, requireApiRole) run
// unmodified. Two helpers sign in, and both are honoured:
//   - ../_ui.ts signIn() puts the session on the shared fake request
//     (`request.session`);
//   - ../_mentorship.ts signIn() puts it in globalThis.__gmlTestSession.
// The real auth() reads a Supabase JWT from the request cookies; the session
// shape it returns ({ user: { id, role, email, name, image } }) is what is
// faked here, and nothing downstream of it is.

type Session = {
  user: { id: string; role: string; email: string | null; name: string | null; image: string | null };
};

type State = { session?: Session | null };
const g = () => globalThis as Record<string, unknown>;
const state = () => (g().__gmlTestRequest ?? {}) as State;

export async function auth(): Promise<Session | null> {
  return state().session ?? (g().__gmlTestSession as Session | null | undefined) ?? null;
}

export async function signOut(): Promise<never> {
  throw new Error("signOut is not callable from a render test");
}

export async function signInWithPassword(): Promise<never> {
  throw new Error("signInWithPassword is not callable from a render test");
}
