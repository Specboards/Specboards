import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The token in an unsubscribe link.
 *
 * Somebody unsubscribing is by definition not in the app: they are in a mail
 * client, possibly on a device that has never signed in, quite possibly
 * months after the session that would have authorized them expired. A link
 * that bounces them to a sign-in page is the reason people click "spam"
 * instead, which costs the whole deployment its deliverability rather than
 * costing us one recipient.
 *
 * So the link carries its own authorization: the user id, and an HMAC over it
 * keyed from `BETTER_AUTH_SECRET`. Anybody holding the token can turn that
 * person's notification email off and on again, and can do nothing else at
 * all. That is the whole scope, deliberately: the same secret signs sessions,
 * and a token that could be traded for one would put an account in every
 * mailbox we have ever sent to.
 *
 * ── Why there is no expiry ─────────────────────────────────────────────────
 * An unsubscribe link has to work whenever it is found. Mail sits in an inbox
 * for years, and a link that answers "this has expired, please sign in" is,
 * to the person reading it, a refusal to stop emailing them. The exposure it
 * buys is bounded by what the token can do, which is the one reversible
 * setting it names.
 *
 * The purpose label is mixed into the signature so a token minted here can
 * never verify anywhere else, however the secret is reused later.
 */

const PURPOSE = "specboards.notification-email-unsubscribe.v1";

/** The signature half of a token, as url-safe base64. */
function sign(userId: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${PURPOSE}:${userId}`)
    .digest("base64url");
}

/**
 * The signing secret.
 *
 * Returns null rather than throwing when it is unset, unlike `lib/crypto.ts`,
 * because both callers are on paths where a thrown error is the wrong answer:
 * minting happens inside the relay, where an exception would cost an event its
 * notifications, and verifying happens on a public page, where it would be a
 * 500 in front of somebody trying to unsubscribe. Without a secret the feature
 * is simply unavailable, and both callers say so in their own terms.
 */
function secret(): string | null {
  const value = process.env.BETTER_AUTH_SECRET;
  return value && value.length >= 32 ? value : null;
}

/** Mint the token for a user's unsubscribe link, or null if we cannot sign. */
export function unsubscribeToken(userId: string): string | null {
  const key = secret();
  if (!key) return null;
  return `${userId}.${sign(userId, key)}`;
}

/**
 * The user a token names, or null if it does not verify.
 *
 * Compared in constant time. The comparison is against a signature derived
 * from the id in the token itself, so a caller cannot learn anything by
 * varying it; the constant-time compare is there because a leaking comparison
 * on an HMAC is the one that lets somebody forge one a byte at a time.
 */
export function userIdFromUnsubscribeToken(token: string): string | null {
  const key = secret();
  if (!key) return null;

  // rsplit: a user id has no dots today, but reading the signature off the end
  // means this keeps working if that ever stops being true.
  const cut = token.lastIndexOf(".");
  if (cut <= 0) return null;
  const userId = token.slice(0, cut);
  const provided = Buffer.from(token.slice(cut + 1), "utf8");
  const expected = Buffer.from(sign(userId, key), "utf8");
  if (provided.length !== expected.length) return null;
  return timingSafeEqual(provided, expected) ? userId : null;
}
