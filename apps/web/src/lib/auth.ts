import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";

import { isBlockedEmailDomain } from "@specboard/core";
import { createDb, schema } from "@specboard/db";

import { sendEmail } from "@/lib/email";

/**
 * Reject sign-ups from consumer email providers (gmail.com, outlook.com, …)
 * when `SPECBOARD_BLOCK_PUBLIC_EMAIL_DOMAINS` is truthy. On for the hosted
 * SaaS; off by default so self-host admins can test with personal addresses.
 */
function blockPublicEmailDomains(): boolean {
  const value = process.env.SPECBOARD_BLOCK_PUBLIC_EMAIL_DOMAINS?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function createAuth(url: string) {
  return betterAuth({
    database: drizzleAdapter(createDb(url), {
      provider: "pg",
      schema: {
        user: schema.users,
        session: schema.sessions,
        account: schema.accounts,
        verification: schema.verifications,
      },
    }),
    emailAndPassword: {
      enabled: true,
      // Block sign-in until the address is confirmed. Combined with
      // `sendOnSignUp` below this closes the gap where a fresh deployment's
      // first-user admin slot could be claimed without mailbox control.
      requireEmailVerification: true,
      sendResetPassword: async ({ user, url }) => {
        await sendEmail({
          to: user.email,
          subject: "Reset your SpecBoard password",
          textBody: `Hi ${user.name},\n\nReset your SpecBoard password here:\n${url}\n\nIf you didn't request this, you can ignore this email.`,
        });
      },
    },
    emailVerification: {
      // Delivered via Postmark when POSTMARK_SERVER_TOKEN is set. Sign-in is
      // gated on verification (see requireEmailVerification above); a failed
      // sign-in by an unverified user re-sends this email automatically.
      sendOnSignUp: true,
      // Land verified users back in the app rather than on a bare API 200.
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        await sendEmail({
          to: user.email,
          subject: "Verify your SpecBoard email",
          textBody: `Hi ${user.name},\n\nConfirm your email address to finish setting up SpecBoard:\n${url}`,
        });
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-up/email" || !blockPublicEmailDomains()) return;
        const email = typeof ctx.body?.email === "string" ? ctx.body.email : "";
        if (isBlockedEmailDomain(email)) {
          throw new APIError("BAD_REQUEST", {
            message:
              "Please sign up with your work email address. Personal email providers are not supported on the hosted service.",
          });
        }
      }),
    },
    advanced: {
      // Postgres mints UUID ids (see schema) instead of Better Auth's
      // default text ids.
      database: { generateId: false },
    },
  });
}

let auth: ReturnType<typeof createAuth> | null | undefined;

/**
 * Better Auth server instance, resolved once per process. Mirrors the
 * `getStore()` pattern: gated on `DATABASE_URL`, `null` in local file mode.
 */
export function getAuth() {
  if (auth === undefined) {
    const url = process.env.DATABASE_URL;
    auth = url ? createAuth(url) : null;
  }
  return auth;
}
