// Stands in for `next/cache` (see ../_ui.ts and ../_server-actions.ts).
// revalidatePath() needs the request's static-generation store and throws
// "static generation store missing" outside a Next request, which would stop a
// server action at its last line, after the behaviour under test has already
// happened. The calls are recorded so a test can still see which paths an
// action revalidated: in the process-wide `revalidated` list, and in the fake
// request's `revalidated` (reset by _ui.ts's resetRequest()).

type State = { revalidated?: string[] };
const state = () => ((globalThis as Record<string, unknown>).__gmlTestRequest ?? {}) as State;

export const revalidated: string[] = ((globalThis as Record<string, unknown>).__gmlRevalidated ??= []) as string[];

function record(entry: string): void {
  revalidated.push(entry);
  (state().revalidated ??= []).push(entry);
}

export function revalidatePath(path: string): void {
  record(path);
}

export function revalidateTag(tag: string): void {
  record(`tag:${tag}`);
}
