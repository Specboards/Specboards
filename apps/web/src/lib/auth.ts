import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { mcp } from "better-auth/plugins";

import { isBlockedEmailDomain } from "@specboard/core";
import { createDb, schema } from "@specboard/db";

import { isE2E } from "@/lib/e2e";
import { renderActionEmail, sendEmail } from "@/lib/email";

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
  // The MCP OAuth provider needs an explicit issuer for its discovery
  // metadata; everywhere else Better Auth can infer the URL per request.
  const appUrl = (process.env.APP_URL ?? process.env.BETTER_AUTH_URL)?.trim();
  return betterAuth({
    ...(appUrl ? { baseURL: appUrl } : {}),
    database: drizzleAdapter(createDb(url), {
      provider: "pg",
      schema: {
        user: schema.users,
        session: schema.sessions,
        account: schema.accounts,
        verification: schema.verifications,
        oauthApplication: schema.oauthApplications,
        oauthAccessToken: schema.oauthAccessTokens,
        oauthConsent: schema.oauthConsents,
      },
    }),
    // OAuth 2.1 provider for the hosted MCP endpoint (/api/mcp): MCP clients
    // discover it via /.well-known/oauth-*, self-register (DCR), send the user
    // through sign-in + consent, and call /api/mcp with the minted bearer
    // token. The sb_ API key path stays as the non-interactive alternative.
    plugins: [
      mcp({
        loginPage: "/sign-in",
        oidcConfig: {
          // OIDCOptions requires loginPage too; the plugin overrides it with
          // the top-level value, so keep them identical.
          loginPage: "/sign-in",
          consentPage: "/oauth/consent",
          // OAuth 2.1: every client must use PKCE, public or confidential.
          requirePKCE: true,
        },
      }),
    ],
    emailAndPassword: {
      enabled: true,
      // Block sign-in until the address is confirmed. Combined with
      // `sendOnSignUp` below this closes the gap where a fresh deployment's
      // first-user admin slot could be claimed without mailbox control.
      // Relaxed only under SPECBOARD_E2E so tests can sign in without a mailbox.
      requireEmailVerification: !isE2E(),
      // With requireEmailVerification on, Better Auth answers sign-up attempts
      // for an existing email with a generic success (enumeration protection),
      // so the attempter learns nothing and no verification email goes out.
      // Notify the account's real owner instead: without this the legitimate
      // user who forgot they have an account just waits on an email that never
      // comes. Signing in resolves both cases (an unverified address gets the
      // verification email re-sent on the failed sign-in).
      onExistingUserSignUp: async ({ user }) => {
        const origin =
          (process.env.APP_URL ?? process.env.BETTER_AUTH_URL)?.trim() ?? "";
        const { textBody, htmlBody } = renderActionEmail({
          name: user.name,
          intro:
            "Someone (probably you) just tried to sign up for Specboard with this email address, but it already has an account. Sign in instead; if you have forgotten your password, use \"Forgot password?\" on the sign-in page.",
          action: "Sign in",
          url: `${origin}/sign-in`,
          footer:
            "If this wasn't you, you can safely ignore this email. Your account is unchanged.",
        });
        await sendEmail({
          to: user.email,
          subject: "You already have a Specboard account",
          textBody,
          htmlBody,
        });
      },
      sendResetPassword: async ({ user, url }) => {
        const { textBody, htmlBody } = renderActionEmail({
          name: user.name,
          intro: "We received a request to reset your Specboard password. Click the button below to choose a new one.",
          action: "Reset password",
          url,
          footer: "If you didn't request this, you can safely ignore this email.",
        });
        await sendEmail({
          to: user.email,
          subject: "Reset your Specboard password",
          textBody,
          htmlBody,
        });
      },
    },
    user: {
      // Extra profile columns beyond Better Auth's defaults. `timezone` is the
      // user's IANA zone, edited on Settings → Profile (kept in sync with the
      // client's inferAdditionalFields in auth-client.ts and the users schema).
      additionalFields: {
        timezone: { type: "string", required: false, input: true },
      },
      // Let users change their email from the account page. Because their
      // current address is verified, Better Auth sends a confirmation link to
      // the *existing* inbox; the change only takes effect once that's clicked.
      changeEmail: {
        enabled: true,
        sendChangeEmailVerification: async ({
          user,
          newEmail,
          url,
        }: {
          user: { name: string; email: string };
          newEmail: string;
          url: string;
        }) => {
          const { textBody, htmlBody } = renderActionEmail({
            name: user.name,
            intro: `Confirm that you want to change your Specboard email address to ${newEmail}. The change takes effect once you click the button below.`,
            action: "Confirm email change",
            url,
            footer: "If you didn't request this, you can safely ignore this email and your address stays the same.",
          });
          await sendEmail({
            to: user.email,
            subject: "Confirm your Specboard email change",
            textBody,
            htmlBody,
          });
        },
      },
    },
    emailVerification: {
      // Delivered via Postmark when POSTMARK_SERVER_TOKEN is set. Sign-in is
      // gated on verification (see requireEmailVerification above); a failed
      // sign-in by an unverified user re-sends this email automatically.
      // Suppressed under SPECBOARD_E2E (no mailbox in tests).
      sendOnSignUp: !isE2E(),
      // Land verified users back in the app rather than on a bare API 200.
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        const { textBody, htmlBody } = renderActionEmail({
          name: user.name,
          intro: "Confirm your email address to finish setting up your Specboard account.",
          action: "Verify email",
          url,
        });
        await sendEmail({
          to: user.email,
          subject: "Verify your Specboard email",
          textBody,
          htmlBody,
        });
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // Force every MCP authorize request through the consent screen. The
        // mcp plugin only shows consent when the request carries
        // prompt=consent, and MCP clients don't send it; without this, any
        // dynamically-registered client could silently obtain an
        // authorization code from a signed-in user's browser.
        if (ctx.path === "/mcp/authorize") {
          return { context: { query: { ...ctx.query, prompt: "consent" } } };
        }
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
    // Throttle brute force against the auth surface. Defaults cover every
    // /api/auth/* route; the custom rules clamp the credential-guessing and
    // account-enumeration paths harder. Memory-backed (per instance), which is
    // a reasonable floor; a shared store can come later if we scale out.
    rateLimit: {
      enabled: true,
      window: 60,
      max: 120,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 3600, max: 10 },
        "/forget-password": { window: 3600, max: 5 },
        "/reset-password": { window: 3600, max: 10 },
        // Dynamic Client Registration is unauthenticated and writes a row per
        // call; a client registers once, so a low ceiling costs nothing.
        "/mcp/register": { window: 3600, max: 10 },
      },
    },
    advanced: {
      // Postgres mints UUID ids (see schema) instead of Better Auth's
      // default text ids.
      database: { generateId: false },
      // Behind Fly's proxy the socket peer is the edge, not the client, so
      // without this the rate limiter can't key on IP and collapses to ONE
      // shared bucket per path for all visitors (observed on prod). Fly
      // overwrites Fly-Client-IP at its edge, so it is trustworthy here.
      ipAddress: { ipAddressHeaders: ["fly-client-ip", "x-forwarded-for"] },
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
