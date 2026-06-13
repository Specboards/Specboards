"use client";

import { createAuthClient } from "better-auth/react";

/**
 * Browser-side Better Auth client. baseURL defaults to the current origin,
 * which is correct for both the hosted apps and self-host. When the server
 * runs in local file mode (no DATABASE_URL) the auth routes return 501 and
 * these calls surface that as an error — the UI degrades to "auth disabled".
 */
export const authClient = createAuthClient();

export const { signIn, signUp, signOut, useSession, sendVerificationEmail } = authClient;
