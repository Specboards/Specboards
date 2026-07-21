import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { mcp } from "better-auth/plugins";

import { isBlockedEmailDomain } from "@specboard/core";
import { createDb, schema } from "@specboard/db";

import { hasValidPendingInvitation, inviteOnlyEnabled } from "@/lib/access-gate";
import { getDb } from "@/lib/db";
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

/** Hosts that count as loopback for RFC 8252 native-app redirects. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Parse a redirect URI, returning it only if it's a plain-http loopback. */
function parseLoopbackRedirect(uri: unknown): URL | null {
  if (typeof uri !== "string") return null;
  try {
    const parsed = new URL(uri);
    return parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/**
 * RFC 8252 §7.3: a native client redirects to a loopback address with an
 * ephemeral port, and the authorization server must match that redirect URI
 * ignoring the port. Claude Code registers once (DCR) and then authorizes
 * with a fresh localhost port per sign-in; better-auth's mcp plugin matches
 * the registered URIs exactly, which rejects every attempt after the first.
 * Bridge the gap by swapping the client's stored loopback redirect (same
 * path, any loopback host) for the one requested, before the plugin checks.
 * Loopback-interception risk is covered by PKCE, which we require.
 */
async function allowLoopbackRedirectPort(ctx: {
  query?: Record<string, unknown>;
  context: {
    adapter: {
      findOne: <T>(args: {
        model: string;
        where: { field: string; value: string }[];
      }) => Promise<T | null>;
      update: <T>(args: {
        model: string;
        where: { field: string; value: string }[];
        update: Record<string, unknown>;
      }) => Promise<T | null>;
    };
  };
}): Promise<void> {
  const requested = typeof ctx.query?.redirect_uri === "string" ? ctx.query.redirect_uri : "";
  const clientId = typeof ctx.query?.client_id === "string" ? ctx.query.client_id : "";
  const loopback = parseLoopbackRedirect(requested);
  if (!loopback || !clientId) return;

  const client = await ctx.context.adapter.findOne<{ redirectUrls: string }>({
    model: "oauthApplication",
    where: [{ field: "clientId", value: clientId }],
  });
  if (!client) return;
  const urls = client.redirectUrls.split(",");
  if (urls.includes(requested)) return;

  const swapIndex = urls.findIndex((registered) => {
    const parsed = parseLoopbackRedirect(registered);
    return parsed !== null && parsed.pathname === loopback.pathname;
  });
  if (swapIndex === -1) return;

  urls[swapIndex] = requested;
  await ctx.context.adapter.update({
    model: "oauthApplication",
    where: [{ field: "clientId", value: clientId }],
    update: { redirectUrls: urls.join(","), updatedAt: new Date() },
  });
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
        rateLimit: schema.rateLimits,
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
            "Someone (probably you) just tried to sign up for Specboards with this email address, but it already has an account. Sign in instead; if you have forgotten your password, use \"Forgot password?\" on the sign-in page.",
          action: "Sign in",
          url: `${origin}/sign-in`,
          footer:
            "If this wasn't you, you can safely ignore this email. Your account is unchanged.",
        });
        await sendEmail({
          to: user.email,
          subject: "You already have a Specboards account",
          textBody,
          htmlBody,
        });
      },
      sendResetPassword: async ({ user, url }) => {
        const { textBody, htmlBody } = renderActionEmail({
          name: user.name,
          intro: "We received a request to reset your Specboards password. Click the button below to choose a new one.",
          action: "Reset password",
          url,
          footer: "If you didn't request this, you can safely ignore this email.",
        });
        await sendEmail({
          to: user.email,
          subject: "Reset your Specboards password",
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
            intro: `Confirm that you want to change your Specboards email address to ${newEmail}. The change takes effect once you click the button below.`,
            action: "Confirm email change",
            url,
            footer: "If you didn't request this, you can safely ignore this email and your address stays the same.",
          });
          await sendEmail({
            to: user.email,
            subject: "Confirm your Specboards email change",
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
          intro: "Confirm your email address to finish setting up your Specboards account.",
          action: "Verify email",
          url,
        });
        await sendEmail({
          to: user.email,
          subject: "Verify your Specboards email",
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
          // Native clients re-authorize with a fresh loopback port (RFC 8252);
          // reconcile the stored redirect before the plugin's exact match.
          await allowLoopbackRedirectPort(ctx);
          return { context: { query: { ...ctx.query, prompt: "consent" } } };
        }
        if (ctx.path !== "/sign-up/email") return;
        const email = typeof ctx.body?.email === "string" ? ctx.body.email : "";
        if (blockPublicEmailDomains() && isBlockedEmailDomain(email)) {
          throw new APIError("BAD_REQUEST", {
            message:
              "Please sign up with your work email address. Personal email providers are not supported on the hosted service.",
          });
        }
        // Pre-v1 invite-only gate: only emails with a live pending invitation may
        // create an account. Invited users still flow through /sign-up normally
        // (the invite email seeds a matching pending invitation); everyone else
        // is directed to the marketing site's "Request access" form.
        if (inviteOnlyEnabled()) {
          const db = getDb();
          const invited = db ? await hasValidPendingInvitation(db, email) : false;
          if (!invited) {
            throw new APIError("FORBIDDEN", {
              message:
                "Specboards is invite-only during the pre-release. Request access at https://www.specboard.ai/request-access and we'll be in touch.",
            });
          }
        }
      }),
    },
    // Throttle brute force against the auth surface. Defaults cover every
    // /api/auth/* route; the custom rules clamp the credential-guessing and
    // account-enumeration paths harder. Database-backed (the `rate_limits`
    // table) rather than process memory, so the limits hold consistently even
    // if the hosted app scales past one instance.
    rateLimit: {
      enabled: true,
      storage: "database",
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
