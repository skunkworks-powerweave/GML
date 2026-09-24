// Stands in for `next/cache` (see ../_ui.ts). revalidatePath() throws
// "static generation store missing" outside a Next request, which would stop a
// server action at its last line, after the behaviour under test has already
// happened. The calls are recorded so a test can still see them.

type State = { revalidated?: string[] };
const state = () => ((globalThis as Record<string, unknown>).__gmlTestRequest ?? {}) as State;

export function revalidatePath(path: string): void {
  (state().revalidated ??= []).push(path);
}

export function revalidateTag(tag: string): void {
  (state().revalidated ??= []).push(`tag:${tag}`);
}
