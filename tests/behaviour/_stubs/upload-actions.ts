// Stands in for apps/web/src/app/(authenticated)/uploads/actions.ts when the
// upload UI components are driven by tests/behaviour/upload-confirm.test.ts.
//
// In the app those two functions are SERVER ACTIONS: from the component's side
// each is a network round-trip that can resolve, answer {ok:false}, or reject
// when the connection drops. The test scripts which of those happens; the
// components themselves are the real ones.

type Answer = unknown;
export type UploadScript = {
  begin: (input: unknown) => Promise<Answer>;
  complete: (submissionId: string, caption?: string) => Promise<Answer>;
  calls: string[];
};

export function uploadScript(): UploadScript {
  const g = globalThis as Record<string, unknown>;
  return (g.__gmlUploadScript ??= {
    begin: async () => ({ ok: false, error: "not scripted" }),
    complete: async () => ({ ok: false, error: "not scripted" }),
    calls: [],
  }) as UploadScript;
}

export async function beginUploadAction(input: unknown): Promise<Answer> {
  uploadScript().calls.push("begin");
  return uploadScript().begin(input);
}

export async function completeUploadAction(submissionId: string, caption?: string): Promise<Answer> {
  uploadScript().calls.push(`complete:${submissionId}`);
  return uploadScript().complete(submissionId, caption);
}
