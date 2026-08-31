"use client";

import { createAuthClient } from "better-auth/react";
import { inferAdditionalFields } from "better-auth/client/plugins";

/**
 * Browser-side Better Auth client. baseURL defaults to the current origin,
 * which is correct for both the hosted apps and self-host. When the server
 * runs in local file mode (no DATABASE_URL) the auth routes return 501 and
 * these calls surface that as an error — the UI degrades to "auth disabled".
 *
 * `inferAdditionalFields` teaches the client about custom `user` columns (kept
 * in sync with `user.additionalFields` in auth.ts) so `updateUser` is typed to
 * accept them — e.g. the profile `timezone`.
 */
const authClient = createAuthClient({
  plugins: [
    inferAdditionalFields({
      user: { timezone: { type: "string", required: false } },
    }),
  ],
});

export const {
  signIn,
  signUp,
  signOut,
  useSession,
  sendVerificationEmail,
  requestPasswordReset,
  resetPassword,
  updateUser,
  changeEmail,
} = authClient;
