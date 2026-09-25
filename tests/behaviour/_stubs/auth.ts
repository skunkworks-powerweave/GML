// Stands in for apps/web/src/auth.ts (see ../_ui.ts). The shells only hand
// signOut to a <form action>, which a static render never submits.
//
// auth() returns whatever session a test put in globalThis.__gmlTestSession
// (tests/behaviour/_mentorship.ts signIn()), and null otherwise -- so a test
// can execute a real page, route handler or server action AS a given user. The
// real auth() reads a Supabase JWT from the request cookies; the session shape
// it returns ({ user: { id, role, email, name, image } }) is what is faked
// here, and nothing downstream of it is.

export async function auth() {
  return ((globalThis as Record<string, unknown>).__gmlTestSession ?? null) as {
    user: { id: string; role: string; email: string | null; name: string | null; image: string | null };
  } | null;
}

export async function signOut(): Promise<never> {
  throw new Error("signOut is not callable from a render test");
}

export async function signInWithPassword(): Promise<never> {
  throw new Error("signInWithPassword is not callable from a render test");
}
