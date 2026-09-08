import { randomUUID } from "node:crypto";

import { hashPassword } from "better-auth/crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Changing your sign-in address is a double opt-in, end to end.
 *
 * This is asserted against Better Auth's own endpoints rather than against our
 * callbacks, because the bug it exists to catch was not in a callback. The
 * option Better Auth reads is `sendChangeEmailConfirmation`; ours was still
 * called `sendChangeEmailVerification`, the compiler had nothing to say about
 * it, and the effect was silent: `/change-email` skipped the confirmation step
 * altogether and mailed a verification link straight to the new address. The
 * account moved on one click, in one inbox, with the address being moved away
 * from never told anything happened.
 *
 * So what is checked here is the sequence a user actually experiences: which
 * inbox receives what, and, at each stage, what `users.email` still says. A
 * test of "our function was called" would have passed throughout the bug.
 *
 * Needs a migrated Postgres at DATABASE_URL; skips itself when unset.
 */

/** Every message that would have gone out, in order. */
const sent: { to: string; subject: string; textBody: string }[] = [];

/**
 * Mocked at the transport, not at `sendEmail`.
 *
 * `lib/email.ts` is the module under test as much as `auth.ts` is: the
 * rendering, the subject and the recipient are the observable behaviour here.
 * Stubbing `dispatchEmail` captures exactly what would have reached a relay
 * and leaves everything above it real.
 */
vi.mock("@/lib/mail/send", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mail/send")>()),
  dispatchEmail: async (message: {
    to: string;
    subject: string;
    textBody: string;
  }) => {
    sent.push(message);
  },
}));

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const tag = randomUUID().slice(0, 8);
const OLD_EMAIL = `old-${tag}@example.test`;
const NEW_EMAIL = `new-${tag}@example.test`;
const PASSWORD = "int-test-password-not-a-real-secret";

/** The state of the world after one step of the journey. */
interface Stage {
  /** Messages sent by that step alone. */
  mail: { to: string; subject: string; textBody: string }[];
  /** What the account's sign-in address is at that point. */
  email: string;
  verified: boolean;
}

describe.skipIf(!DB_URL)("changing your email address", () => {
  let sql: postgres.Sql;
  let userId: string;
  let requested: Stage;
  let confirmed: Stage;
  let verified: Stage;

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    process.env.BETTER_AUTH_SECRET ??= "email-change-int-test-secret-value";
    sql = postgres(DB_URL!, { prepare: false, max: 2 });

    // The account is seeded directly rather than through /sign-up/email. That
    // route runs the first-run and sign-up-code gates, which depend on what
    // else happens to be in this shared database; none of it is what this file
    // is about.
    const [row] = await sql`
      insert into users (name, email, email_verified)
      values ('Old Owner', ${OLD_EMAIL}, true)
      returning id`;
    userId = row!.id as string;
    await sql`
      insert into accounts (user_id, account_id, provider_id, password)
      values (${userId}, ${userId}, 'credential', ${await hashPassword(PASSWORD)})`;

    const { getAuth } = await import("./auth");
    const auth = getAuth()!;

    const signIn = await auth.api.signInEmail({
      body: { email: OLD_EMAIL, password: PASSWORD },
      asResponse: true,
    });
    const cookie = signIn.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    expect(cookie, "sign-in should have set a session cookie").toContain(
      "session_token",
    );
    const headers = new Headers({ cookie });

    async function stage(run: () => Promise<unknown>): Promise<Stage> {
      sent.length = 0;
      await run();
      const [account] = await sql`
        select email, email_verified from users where id = ${userId}`;
      return {
        mail: [...sent],
        email: account!.email as string,
        verified: account!.email_verified as boolean,
      };
    }

    // Step 1: ask for the change.
    requested = await stage(() =>
      auth.api.changeEmail({ body: { newEmail: NEW_EMAIL }, headers }),
    );

    /**
     * Open the link in the message the previous step sent.
     *
     * A step that sent nothing leaves the world where it was, rather than
     * throwing. A missing message is exactly what the regression looks like,
     * and it belongs in a named assertion below and not in a stack trace out
     * of `beforeAll` that fails every test at once.
     */
    async function openLinkFrom(previous: Stage): Promise<Stage> {
      const message = previous.mail[0];
      if (!message) {
        return { mail: [], email: previous.email, verified: previous.verified };
      }
      return stage(() =>
        auth.api.verifyEmail({
          query: { token: tokenIn(message.textBody) },
          headers,
          asResponse: true,
        }),
      );
    }

    // Step 2: open the link that arrived in the old inbox.
    confirmed = await openLinkFrom(requested);

    // Step 3: open the link that arrived in the new one.
    verified = await openLinkFrom(confirmed);
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from sessions where user_id = ${userId}`;
    await sql`delete from accounts where user_id = ${userId}`;
    await sql`delete from users where id = ${userId}`;
    await sql.end({ timeout: 5 });
  });

  it("asks the address on the account first, and only that one", () => {
    expect(requested.mail).toHaveLength(1);
    expect(requested.mail[0]!.to).toBe(OLD_EMAIL);
    expect(requested.mail[0]!.subject).toBe(
      "Confirm your Specboards email change",
    );
    // The regression in full: before the option was named correctly, this
    // single message went to NEW_EMAIL and the old inbox heard nothing.
    expect(requested.mail.map((m) => m.to)).not.toContain(NEW_EMAIL);
  });

  it("changes nothing when the request is made", () => {
    expect(requested.email).toBe(OLD_EMAIL);
  });

  it("asks the new address to prove itself once the old one confirms", () => {
    expect(confirmed.mail).toHaveLength(1);
    expect(confirmed.mail[0]!.to).toBe(NEW_EMAIL);
    expect(confirmed.mail[0]!.subject).toBe(
      "Confirm your new Specboards email address",
    );
  });

  it("still changes nothing when only the old address has confirmed", () => {
    // The heart of the feature. One click is a request, not a change: a
    // mistyped address gets no further than here.
    expect(confirmed.email).toBe(OLD_EMAIL);
  });

  it("does not tell the new address whose account it is", () => {
    // It may be a stranger's inbox, because the address may be a typo.
    expect(confirmed.mail[0]!.textBody).not.toContain(OLD_EMAIL);
  });

  it("does not greet somebody moving an account as a new signup", () => {
    expect(confirmed.mail[0]!.textBody).not.toContain("finish setting up");
  });

  it("moves the account once both addresses have confirmed", () => {
    expect(verified.email).toBe(NEW_EMAIL);
    expect(verified.verified).toBe(true);
  });

  it("sends nothing further once the change is done", () => {
    expect(verified.mail).toEqual([]);
  });
});

/** Pull the verification token out of the link in an email body. */
function tokenIn(textBody: string): string {
  const match = /verify-email\?token=([^&\s]+)/.exec(textBody);
  if (!match) throw new Error(`No verification link in email:\n${textBody}`);
  return decodeURIComponent(match[1]!);
}
