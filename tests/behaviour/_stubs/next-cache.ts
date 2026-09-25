// Stands in for `next/cache` (see ../_server-actions.ts and ../_ui.ts).
// revalidatePath() needs the request's static-generation store and throws
// outside Next; the calls are recorded so a test can see which paths an action
// revalidated.

export const revalidated: string[] = ((globalThis as Record<string, unknown>).__gmlRevalidated ??= []) as string[];

export function revalidatePath(path: string): void {
  revalidated.push(path);
}

export function revalidateTag(tag: string): void {
  revalidated.push(`tag:${tag}`);
}

export function unstable_noStore(): void {}
