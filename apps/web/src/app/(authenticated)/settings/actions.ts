"use server";

// Shared sign-out server action.
//
// The settings page previously ended the session with a plain
// `<a href="/api/auth/signout">`, which had three problems:
//   1. it navigated to a page-like route with an <a>, which @next/next's
//      no-html-link-for-pages rejects;
//   2. it performed a state-changing operation over GET; and
//   3. it hard-coded an Auth.js route path, so it would 404 the moment the
//      auth provider changes.
//
// Routing it through a server action fixes all three and gives the settings
// page the same submit path the Topbar already uses, so there is exactly one
// sign-out implementation to keep working.

import { signOut } from "@/auth";

export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/login" });
}
