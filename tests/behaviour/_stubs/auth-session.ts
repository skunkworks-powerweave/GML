// Stands in for apps/web/src/auth.ts in tests that EXECUTE server actions and
// server pages (see ../_server-actions.ts). auth() answers with whoever the
// test signed in; nobody is signed in by default.

type Session = { user: { id: string; role: string; name?: string | null; email?: string | null } };

const state = () => globalThis as { __gmlTestSession?: Session | null };

export async function auth(): Promise<Session | null> {
  return state().__gmlTestSession ?? null;
}

export async function signOut(): Promise<never> {
  throw new Error("signOut is not callable from a behaviour test");
}

export async function signInWithPassword(): Promise<never> {
  throw new Error("signInWithPassword is not callable from a behaviour test");
}
