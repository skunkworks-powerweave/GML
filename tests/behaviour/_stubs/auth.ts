// Stands in for apps/web/src/auth.ts (see ../_ui.ts). The shells only hand
// signOut to a <form action>, which a static render never submits.

export async function auth() {
  return null;
}

export async function signOut(): Promise<never> {
  throw new Error("signOut is not callable from a render test");
}

export async function signInWithPassword(): Promise<never> {
  throw new Error("signInWithPassword is not callable from a render test");
}
