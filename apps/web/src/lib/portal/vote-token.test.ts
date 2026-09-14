import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { unsubscribeToken } from "@/lib/notifications/unsubscribe";
import {
  mintPortalUnsubscribeToken,
  mintVoteToken,
  mintVoterCookie,
  readPortalUnsubscribeToken,
  readVoteToken,
  readVoterCookie,
  VOTE_TOKEN_TTL_MS,
} from "@/lib/portal/vote-token";

/**
 * The two portal tokens: what they authorise, and what they refuse.
 *
 * These are the only credentials in the product held by somebody with no
 * account, so the cases worth writing are the forgeries. A token that works is
 * demonstrated by the feature; a token that should NOT work is demonstrated
 * only here.
 */

const SECRET = "test-secret-at-least-thirty-two-characters-long";
const IDEA = "11111111-1111-1111-1111-111111111111";
const WS = "22222222-2222-2222-2222-222222222222";

describe("portal vote tokens", () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = SECRET;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = saved;
  });

  it("round-trips the idea and the address", () => {
    const token = mintVoteToken({ ideaId: IDEA, email: "ada@example.com" })!;
    expect(readVoteToken(token)).toEqual({
      ideaId: IDEA,
      email: "ada@example.com",
    });
  });

  it("survives an address full of the characters a parser would split on", () => {
    // The reason the payload is base64url JSON rather than a delimited string.
    // Every one of these is legal in an address, and a token that split on the
    // wrong dot would read a token for one person as a token for another.
    const email = 'a.b+tag."c.d"@sub.example.co.uk';
    const token = mintVoteToken({ ideaId: IDEA, email })!;
    expect(readVoteToken(token)?.email).toBe(email);
  });

  it("expires, unlike an unsubscribe token", () => {
    const now = Date.now();
    const token = mintVoteToken({ ideaId: IDEA, email: "a@example.com" }, now)!;
    // Alive a minute before the deadline, dead a second after it.
    expect(readVoteToken(token, now + VOTE_TOKEN_TTL_MS - 60_000)).not.toBeNull();
    expect(readVoteToken(token, now + VOTE_TOKEN_TTL_MS + 1_000)).toBeNull();
  });

  it("refuses a tampered payload", () => {
    // The attack this exists to stop: vote as somebody else by editing the
    // address, or vote on a different idea by editing the id.
    const token = mintVoteToken({ ideaId: IDEA, email: "ada@example.com" })!;
    const [encoded, sig] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        ideaId: IDEA,
        email: "victim@example.com",
        exp: Date.now() + 60_000,
      }),
      "utf8",
    ).toString("base64url");
    expect(encoded).not.toBe(forged);
    expect(readVoteToken(`${forged}.${sig}`)).toBeNull();
  });

  it("refuses a token signed with a different secret", () => {
    const token = mintVoteToken({ ideaId: IDEA, email: "a@example.com" })!;
    process.env.BETTER_AUTH_SECRET = `${SECRET}-rotated`;
    expect(readVoteToken(token)).toBeNull();
  });

  it.each([
    ["empty", ""],
    ["no separator", "abcdef"],
    ["signature only", ".abcdef"],
    ["payload only", "abcdef."],
    ["not base64", "!!!.???"],
  ])("refuses a malformed token (%s)", (_label, token) => {
    expect(readVoteToken(token)).toBeNull();
  });

  it("is unavailable rather than throwing when there is no secret", () => {
    // A 500 in front of somebody trying to vote is worse than the feature
    // being off and saying so. Same call the unsubscribe module makes.
    delete process.env.BETTER_AUTH_SECRET;
    expect(mintVoteToken({ ideaId: IDEA, email: "a@example.com" })).toBeNull();
    expect(readVoteToken("anything.atall")).toBeNull();
  });

  it("refuses a secret too short to be one", () => {
    process.env.BETTER_AUTH_SECRET = "short";
    expect(mintVoteToken({ ideaId: IDEA, email: "a@example.com" })).toBeNull();
  });
});

describe("the voter cookie", () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = SECRET;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = saved;
  });

  it("round-trips the confirmed address for its own workspace", () => {
    const cookie = mintVoterCookie(WS, "ada@example.com")!;
    expect(readVoterCookie(cookie, WS)).toBe("ada@example.com");
  });

  it("does not identify anybody on a different portal", () => {
    // Every portal shares the app's origin, so one cookie reaches all of them.
    // Confirming an address to one customer is not consent to be identified to
    // the next, and this is the line that keeps it from happening.
    const cookie = mintVoterCookie(WS, "ada@example.com")!;
    expect(readVoterCookie(cookie, "33333333-3333-3333-3333-333333333333"))
      .toBeNull();
  });

  it("refuses a cookie with the workspace edited", () => {
    // The same attack as above, done deliberately rather than by sharing a
    // browser: re-point a legitimate cookie at another workspace.
    const cookie = mintVoterCookie(WS, "ada@example.com")!;
    const sig = cookie.slice(cookie.lastIndexOf(".") + 1);
    const forged = Buffer.from(
      JSON.stringify({ w: "33333333-3333-3333-3333-333333333333", e: "ada@example.com" }),
      "utf8",
    ).toString("base64url");
    expect(
      readVoterCookie(`${forged}.${sig}`, "33333333-3333-3333-3333-333333333333"),
    ).toBeNull();
  });
});

describe("the portal unsubscribe token", () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = SECRET;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = saved;
  });

  it("round-trips the workspace and the address", () => {
    const t = mintPortalUnsubscribeToken(WS, "ada@example.com")!;
    expect(readPortalUnsubscribeToken(t)).toEqual({
      workspaceId: WS,
      email: "ada@example.com",
    });
  });

  it("does not expire, unlike the vote token", () => {
    // The opposite call to `readVoteToken`, deliberately. Mail sits in an inbox
    // for years, and a link that answers "this has expired" is, to the person
    // reading it, a refusal to stop emailing them. There is no clock in this
    // token to advance, so the assertion is that the payload carries none.
    const t = mintPortalUnsubscribeToken(WS, "ada@example.com")!;
    const payload = JSON.parse(
      Buffer.from(t.split(".")[0]!, "base64url").toString("utf8"),
    );
    expect(Object.keys(payload).sort()).toEqual(["e", "w"]);
  });

  it("refuses a tampered address", () => {
    // Unsubscribing somebody else is the whole attack on this token, and it is
    // a nuisance rather than a disclosure, which is why the token has no expiry
    // and why it can do nothing but add one row.
    const t = mintPortalUnsubscribeToken(WS, "ada@example.com")!;
    const sig = t.slice(t.lastIndexOf(".") + 1);
    const forged = Buffer.from(
      JSON.stringify({ w: WS, e: "victim@example.com" }),
      "utf8",
    ).toString("base64url");
    expect(readPortalUnsubscribeToken(`${forged}.${sig}`)).toBeNull();
  });
});

describe("the four token kinds cannot be traded for each other", () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = SECRET;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = saved;
  });

  it("keeps a vote token from verifying as a voter cookie", () => {
    // One secret now signs three things. Without a purpose label mixed into
    // each signature, a vote token (30 minutes, one idea) would verify as a
    // voter cookie (30 days, every idea), which is a privilege escalation
    // hiding inside a shared HMAC key.
    const vote = mintVoteToken({ ideaId: IDEA, email: "a@example.com" })!;
    expect(readVoterCookie(vote, WS)).toBeNull();
  });

  it("keeps a voter cookie from verifying as a vote token", () => {
    const cookie = mintVoterCookie(WS, "a@example.com")!;
    expect(readVoteToken(cookie)).toBeNull();
  });

  it("keeps a portal unsubscribe token from voting", () => {
    // The one that would matter most: an unsubscribe link has no expiry and
    // goes to everybody, so a token that could be replayed as a vote or as an
    // identity would be the longest-lived credential in the product.
    const unsub = mintPortalUnsubscribeToken(WS, "a@example.com")!;
    expect(readVoteToken(unsub)).toBeNull();
    expect(readVoterCookie(unsub, WS)).toBeNull();
  });

  it("keeps a vote token and a voter cookie from unsubscribing", () => {
    const vote = mintVoteToken({ ideaId: IDEA, email: "a@example.com" })!;
    const cookie = mintVoterCookie(WS, "a@example.com")!;
    expect(readPortalUnsubscribeToken(vote)).toBeNull();
    expect(readPortalUnsubscribeToken(cookie)).toBeNull();
  });

  it("keeps an unsubscribe token out of both", () => {
    // The token kind that existed first, and the one whose module warned that
    // the purpose label is there so "a token minted here can never verify
    // anywhere else, however the secret is reused later". This is later.
    const unsub = unsubscribeToken("some-user-id")!;
    expect(readVoteToken(unsub)).toBeNull();
    expect(readVoterCookie(unsub, WS)).toBeNull();
    expect(readPortalUnsubscribeToken(unsub)).toBeNull();
  });
});
