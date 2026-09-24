// Stands in for apps/web/src/app/(authenticated)/admin/quizzes/actions.ts in
// render tests (see ../quizzes.test.ts). That module is "use server" and opens
// the database pool at import time; in the app a client component receives a
// reference to the action, never the module. A static render never invokes it.

export type CreateQuizState = { error?: string } | undefined;

export async function createQuizAction(): Promise<CreateQuizState> {
  return undefined;
}
