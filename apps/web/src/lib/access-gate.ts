import { and, eq, invitations, sql, users, type Database } from "@specboards/db";

/**
 * Pre-v1 the hosted service is invite-only: public sign-up is closed and access
 * is granted by sending an org invitation (see invitations-service). This gate
 * enforces that at the auth layer so someone can't bypass the marketing site's
 * "Request access" flow by navigating straight to /sign-up.
 *
 * Enabled on the hosted SaaS via `SPECBOARDS_INVITE_ONLY`; off by default so
 * self-host deployments keep open sign-up. Independent of
 * `SPECBOARDS_BLOCK_PUBLIC_EMAIL_DOMAINS` (which only restricts *which* domains).
 */
export function inviteOnlyEnabled(): boolean {
  const value = process.env.SPECBOARDS_INVITE_ONLY?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

/**
 * True when `email` has at least one invitation that is still redeemable: status
 * `pending` and not past its expiry. Matches the redemption rules in
 * invitations-service so the gate and the redeem path agree. Emails are stored
 * lowercased, so we compare case-insensitively.
 */
export async function hasValidPendingInvitation(
  db: Database,
  email: string,
): Promise<boolean> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;
  const [row] = await db
    .select({ id: invitations.id })
    .from(invitations)
    .where(
      and(
        sql`lower(${invitations.email}) = ${normalized}`,
        eq(invitations.status, "pending"),
        sql`${invitations.expiresAt} > now()`,
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Pre-v1 sign-up-code gate. Only the *first* person from a company (email
 * domain) needs a code to open the door; every teammate after them signs up as
 * a basic member without one (see `isFirstUserForDomain`). This supersedes the
 * older pending-invitation-only gate: a live invitation still lets someone in,
 * but is no longer the only way.
 *
 * Enabled on the hosted SaaS via `SPECBOARDS_SIGNUP_CODE_REQUIRED`; off by
 * default so self-host deployments keep open sign-up. Independent of
 * `SPECBOARDS_BLOCK_PUBLIC_EMAIL_DOMAINS` (which only restricts *which* domains).
 */
export function signUpCodeRequired(): boolean {
  const value = process.env.SPECBOARDS_SIGNUP_CODE_REQUIRED?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

/**
 * The code the first user of a domain must present. Hardcoded for the
 * early-access launch; override per-deployment with `SPECBOARDS_SIGNUP_CODE`
 * (e.g. to rotate it) without a code change.
 */
export function expectedSignUpCode(): string {
  return process.env.SPECBOARDS_SIGNUP_CODE?.trim() || "SPECBUILDER2026";
}

/** True when `provided` matches the expected code, trimmed and case-insensitive. */
export function signUpCodeMatches(provided: string): boolean {
  return provided.trim().toLowerCase() === expectedSignUpCode().toLowerCase();
}

/** The lowercased domain of an email (the part after the last `@`), or "". */
function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).trim().toLowerCase();
}

/**
 * True when no account yet exists for this email's domain: the requester is the
 * first person from their company, so a sign-up code is required. Once one
 * account exists on the domain, teammates join without a code. A blank or
 * unparseable domain is treated as "first" (fail closed: require the code).
 */
export async function isFirstUserForDomain(
  db: Database,
  email: string,
): Promise<boolean> {
  const domain = emailDomain(email);
  if (!domain) return true;
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(split_part(${users.email}, '@', 2)) = ${domain}`)
    .limit(1);
  return !row;
}
