// Stands in for apps/web/src/app/login/actions.ts and email-actions.ts (see
// ../_ui.ts). The login shells pass these to useActionState / <form action>;
// a static render never invokes them.

export type LoginState = { error?: string };
export type EmailActionState = { ok?: boolean; error?: string; message?: string };

export async function loginAction(): Promise<LoginState> {
  return {};
}

export async function sendMagicLinkAction(): Promise<EmailActionState> {
  return {};
}

export async function requestPasswordResetAction(): Promise<EmailActionState> {
  return {};
}
