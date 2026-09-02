"use client";

import type { useRouter } from "next/navigation";

import { AuthRequiredError } from "@/lib/api-client/request";

/**
 * What the browser does when a session turns out to have expired.
 *
 * One policy, in one place, because the alternative was eighty of them. Every
 * caller that writes to the API can be told its session is gone, and each one
 * used to decide for itself what that meant: most pushed to sign-in with the
 * current path, some hard-assigned `window.location`, and fifteen sent the
 * user to a bare `/sign-in` that had forgotten where they were. That last group
 * is the reason this exists. Losing a session mid-edit is annoying; being
 * returned to the top of the app afterwards, with no way back to what you were
 * doing, is the part people actually complain about.
 *
 * Navigation goes through the App Router rather than `window.location`. A hard
 * assignment reloads the whole application to reach a route Next can push to,
 * which is slower, loses client state that did not need losing, and is what the
 * navigation lint rule is objecting to in `ProductsManager` and
 * `AssistantPanel`.
 */

type Router = ReturnType<typeof useRouter>;

/**
 * Sign-in, carrying where the user was so they can be returned there.
 *
 * The path only, deliberately: `from` is echoed back into a redirect after
 * authenticating, so it must not be something a caller could point at another
 * origin.
 */
export function signInHref(pathname: string): string {
  return `/sign-in?from=${encodeURIComponent(pathname)}`;
}

/**
 * Send the user to sign in if `err` is an expired session, and report whether
 * it was. Reads as a guard at the top of a catch block:
 *
 * ```ts
 * catch (err) {
 *   if (redirectOnAuthExpiry(err, router)) return;
 *   toast.error(...);
 * }
 * ```
 *
 * Returning a boolean rather than throwing or swallowing keeps the decision
 * with the caller: a surface that would rather explain itself in place than
 * navigate away, such as a background poll or a read-only panel, simply does
 * not call this and handles `AuthRequiredError` on its own terms.
 */
export function redirectOnAuthExpiry(err: unknown, router: Router): boolean {
  if (!(err instanceof AuthRequiredError)) return false;
  router.push(signInHref(window.location.pathname));
  return true;
}
