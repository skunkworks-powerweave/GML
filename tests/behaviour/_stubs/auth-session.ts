// Stands in for apps/web/src/auth.ts in tests/behaviour/quizzes.test.ts, which
// renders quiz pages and calls the quiz server actions as a signed-in user.
// The session is whatever the test last put on globalThis.__gmlTestSession;
// everything the pages and actions do after reading it is the real code.

export async function auth() {
  return (globalThis as Record<string, unknown>).__gmlTestSession ?? null;
}

export async function signOut(): Promise<never> {
  throw new Error("signOut is not callable from a quiz test");
}

export async function signInWithPassword(): Promise<never> {
  throw new Error("signInWithPassword is not callable from a quiz test");
}
