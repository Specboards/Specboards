import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The token in a "confirm your vote" link, and the cookie that saves the next
 * visitor from needing one.
 *
 * All three are HMACs keyed from `BETTER_AUTH_SECRET`, following
 * `lib/notifications/unsubscribe.ts`, and each mixes its OWN purpose label into
 * the signature so a token minted for one can never verify as another. That
 * matters more here than there, because four token kinds now share one secret
 * (these three plus the account unsubscribe) and the failure would be silent.
 *
 * The third kind, the portal unsubscribe, is defined further down and takes the
 * OPPOSITE decision on expiry to the vote token. Its own comment says why.
 *
 * ── Where this deliberately differs from the unsubscribe token ─────────────
 * That module explains at length why an unsubscribe link has NO expiry: mail
 * sits in an inbox for years, and "this link has expired, please sign in" is,
 * to the person reading it, a refusal to stop emailing them.
 *
 * A vote link is the opposite case and gets the opposite answer. Nobody is
 * harmed by a vote link that stops working; they can ask for another in one
 * click. And the token is worth more than an unsubscribe token, because
 * confirming it hands the holder a 30-day identity: whoever clicks it can vote
 * as that address on every other idea on the portal until the cookie expires.
 * A forwarded email, a shared support inbox, or a mailing list archive would
 * otherwise pass that around indefinitely.
 *
 * Thirty minutes is long enough for somebody to notice the mail and click it,
 * and short enough that a link found later is inert.
 *
 * ── What a replay can and cannot do ────────────────────────────────────────
 * Within its window a link can be clicked repeatedly. That records no second
 * vote: the insert is idempotent against `idea_votes_idea_email_uq`, the
 * partial unique index migration 0010 added for exactly this. The index is the
 * backstop rather than the only defence, which is what the expiry above is for.
 */

const VOTE_PURPOSE = "specboards.portal-vote-confirm.v1";
const VOTER_PURPOSE = "specboards.portal-voter-identity.v1";
const UNSUB_PURPOSE = "specboards.portal-email-unsubscribe.v1";

/** How long a confirmation link stays usable. */
export const VOTE_TOKEN_TTL_MS = 30 * 60 * 1000;

/** How long a confirmed voter stays confirmed in this browser. */
export const VOTER_COOKIE_TTL_SEC = 30 * 24 * 60 * 60;

/** The cookie a confirmed voter carries. */
export const VOTER_COOKIE = "sb_portal_voter";

/**
 * The signing secret, or null when it is unset.
 *
 * Null rather than a throw, for the reason `unsubscribe.ts` gives: both callers
 * are on paths where an exception is the wrong answer. Minting happens while
 * handling a visitor's vote, and verifying happens on a public page; a 500 in
 * front of somebody trying to vote is worse than the feature being unavailable
 * and saying so.
 */
function secret(): string | null {
  const value = process.env.BETTER_AUTH_SECRET;
  return value && value.length >= 32 ? value : null;
}

function sign(purpose: string, payload: string, key: string): string {
  return createHmac("sha256", key)
    .update(`${purpose}:${payload}`)
    .digest("base64url");
}

/** Constant-time compare of two signatures, length-safe. */
function signatureMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  // `timingSafeEqual` throws on a length mismatch, so the lengths are compared
  // first. That leaks the length of a signature, which is a constant.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * What a confirmation link authorises: one vote, on one idea, by one address.
 *
 * Not exported: callers take it as the return of `readVoteToken` and pass it as
 * an object literal to `mintVoteToken`, so the name is never written elsewhere.
 */
interface VoteClaim {
  ideaId: string;
  email: string;
}

interface VotePayload extends VoteClaim {
  /** Expiry, epoch milliseconds. */
  exp: number;
}

/**
 * Mint a confirmation token for `ideaId` and `email`, or null if we cannot
 * sign.
 *
 * The payload is base64url JSON rather than a delimited string, because an
 * email address can contain almost anything including the separators one would
 * reach for, and a parser that splits on the wrong dot is how a token for one
 * address gets read as a token for another.
 */
export function mintVoteToken(
  claim: VoteClaim,
  now: number = Date.now(),
): string | null {
  const key = secret();
  if (!key) return null;
  const payload: VotePayload = {
    ideaId: claim.ideaId,
    email: claim.email,
    exp: now + VOTE_TOKEN_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  return `${encoded}.${sign(VOTE_PURPOSE, encoded, key)}`;
}

/**
 * The vote a token authorises, or null if it does not verify or has expired.
 *
 * Every failure returns the same null. The caller cannot distinguish a forged
 * signature from an expired one, and neither can the visitor, which is
 * deliberate: "expired" and "invalid" render as the same message, so a token
 * cannot be probed for which half is wrong.
 */
export function readVoteToken(
  token: string,
  now: number = Date.now(),
): VoteClaim | null {
  const key = secret();
  if (!key) return null;

  const cut = token.lastIndexOf(".");
  if (cut <= 0) return null;
  const encoded = token.slice(0, cut);
  if (!signatureMatches(token.slice(cut + 1), sign(VOTE_PURPOSE, encoded, key)))
    return null;

  // Only parsed AFTER the signature verifies, so untrusted bytes never reach
  // `JSON.parse`. It is still wrapped, because a token signed by an older
  // version of this code could carry a shape this one does not expect.
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!isVotePayload(payload)) return null;
  if (payload.exp <= now) return null;
  return { ideaId: payload.ideaId, email: payload.email };
}

function isVotePayload(v: unknown): v is VotePayload {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.ideaId === "string" &&
    o.ideaId.length > 0 &&
    typeof o.email === "string" &&
    o.email.length > 0 &&
    typeof o.exp === "number" &&
    Number.isFinite(o.exp)
  );
}

/**
 * Mint the token in a portal unsubscribe link, or null.
 *
 * ── This one has NO expiry, unlike the vote token above ────────────────────
 * Which is the opposite call, made for the reason `unsubscribe.ts` gives about
 * the token it mints: "an unsubscribe link has to work whenever it is found.
 * Mail sits in an inbox for years, and a link that answers 'this has expired,
 * please sign in' is, to the person reading it, a refusal to stop emailing
 * them." A refused unsubscribe is what turns "unsubscribe me" into "mark as
 * spam", which costs the whole deployment its sending reputation.
 *
 * The exposure that buys is bounded by what the token can do, which is add one
 * row to `portal_email_opt_outs` for one address on one portal. Somebody
 * holding a stranger's unsubscribe link can stop that person's mail and can do
 * nothing else at all: they cannot read it, cannot vote with it, and cannot
 * resubscribe anybody.
 */
export function mintPortalUnsubscribeToken(
  workspaceId: string,
  email: string,
): string | null {
  const key = secret();
  if (!key) return null;
  const encoded = Buffer.from(
    JSON.stringify({ w: workspaceId, e: email }),
    "utf8",
  ).toString("base64url");
  return `${encoded}.${sign(UNSUB_PURPOSE, encoded, key)}`;
}

/** The workspace and address an unsubscribe token names, or null. */
export function readPortalUnsubscribeToken(
  token: string,
): { workspaceId: string; email: string } | null {
  const key = secret();
  if (!key) return null;

  const cut = token.lastIndexOf(".");
  if (cut <= 0) return null;
  const encoded = token.slice(0, cut);
  if (!signatureMatches(token.slice(cut + 1), sign(UNSUB_PURPOSE, encoded, key)))
    return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const o = payload as Record<string, unknown>;
  if (typeof o.w !== "string" || typeof o.e !== "string") return null;
  return { workspaceId: o.w, email: o.e };
}

/**
 * Mint the cookie value that remembers a confirmed voter, or null.
 *
 * Scoped to ONE workspace on purpose. The cookie is set on the app's own
 * origin, which every portal shares, so an unscoped one would carry a
 * confirmation earned on one customer's portal across to every other
 * customer's. Nothing terrible follows from that (it is the same person and
 * the same address), but "I confirmed my email to Acme" is not consent to be
 * identified to Acme's competitor on the next tab, and the scoping costs one
 * field.
 */
export function mintVoterCookie(
  workspaceId: string,
  email: string,
): string | null {
  const key = secret();
  if (!key) return null;
  const encoded = Buffer.from(
    JSON.stringify({ w: workspaceId, e: email }),
    "utf8",
  ).toString("base64url");
  return `${encoded}.${sign(VOTER_PURPOSE, encoded, key)}`;
}

/**
 * The confirmed email a cookie carries for `workspaceId`, or null.
 *
 * No expiry inside the value: the cookie's own `Max-Age` is what expires it,
 * and unlike a link in a mailbox a cookie really is gone when the browser drops
 * it. A copied cookie value would outlive that, which is why it is `httpOnly`
 * at the call site and why the whole thing it grants is a vote.
 */
export function readVoterCookie(
  value: string,
  workspaceId: string,
): string | null {
  const key = secret();
  if (!key) return null;

  const cut = value.lastIndexOf(".");
  if (cut <= 0) return null;
  const encoded = value.slice(0, cut);
  if (
    !signatureMatches(value.slice(cut + 1), sign(VOTER_PURPOSE, encoded, key))
  ) {
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const o = payload as Record<string, unknown>;
  if (typeof o.w !== "string" || typeof o.e !== "string") return null;
  // A validly-signed cookie for a DIFFERENT workspace is not an error and is
  // not this portal's business: it simply does not identify anybody here.
  if (o.w !== workspaceId) return null;
  return o.e;
}
