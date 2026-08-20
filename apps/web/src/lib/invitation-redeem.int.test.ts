import { createHash, randomBytes, randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * Redeeming an invitation, against a real database.
 *
 * `redeemInvitation` had no test of its own, which is part of why F27 sat
 * unnoticed: it compared `user.email` to the invited address and stopped there.
 * `changeEmail` is enabled, so that column can hold an address whose control the
 * holder has never proven.
 *
 * That does not steal an invitation by itself, because the token only ever
 * reaches the real invitee's mailbox. What it reaches is domain-based sign-up
 * gating: a deployment that decides who may join by email domain is trusting
 * this column, and an unverified address lets a person choose the domain they
 * are judged by.
 *
 * Runs against DATABASE_URL. Skips when no database is configured.
 */

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const suffix = randomUUID().slice(0, 8);
const ws = randomUUID();
const inviterId = randomUUID();
const inviteeId = randomUUID();
const inviteeEmail = `invitee-${suffix}@redeem.test`;

/** The service stores a sha-256 of the token; mint a matching pair here. */
function newToken(): { raw: string; hash: string } {
  const raw = randomBytes(24).toString("base64url");
  return { raw, hash: createHash("sha256").update(raw).digest("hex") };
}

describe.skipIf(!DB_URL)("redeeming an invitation", () => {
  let sql: postgres.Sql;
  let db: import("@specboards/db").Database;
  let svc: typeof import("./invitations-service");

  const invitee = { id: inviteeId, email: inviteeEmail, name: "Ivy" };

  beforeAll(async () => {
    const { createDb } = await import("@specboards/db");
    db = createDb(DB_URL!);
    svc = await import("./invitations-service");

    sql = postgres(DB_URL!, { prepare: false, max: 2 });
    await sql`insert into workspaces (id, name, slug)
      values (${ws}, 'Redeem', ${`rd-${suffix}`})`;
    await sql`insert into users (id, name, email, email_verified) values
      (${inviterId}, 'Ada', ${`ada-${suffix}@redeem.test`}, true),
      (${inviteeId}, 'Ivy', ${inviteeEmail}, false)`;
    await sql`insert into members (workspace_id, user_id, role)
      values (${ws}, ${inviterId}, 'owner')`;
  });

  afterEach(async () => {
    await sql`delete from invitations where workspace_id = ${ws}`;
    await sql`delete from members where workspace_id = ${ws} and user_id = ${inviteeId}`;
    await sql`update users set email_verified = false where id = ${inviteeId}`;
  });

  afterAll(async () => {
    await sql`delete from invitations where workspace_id = ${ws}`;
    await sql`delete from members where workspace_id = ${ws}`;
    await sql`delete from workspaces where id = ${ws}`;
    await sql`delete from users where id in ${sql([inviterId, inviteeId])}`;
    await sql.end({ timeout: 5 });
  });

  /** A live invitation for `inviteeEmail`, returning the raw token. */
  async function invite(): Promise<string> {
    const { raw, hash } = newToken();
    await sql`insert into invitations
        (id, workspace_id, email, role, token_hash, status, expires_at, invited_by)
      values (${randomUUID()}, ${ws}, ${inviteeEmail}, 'member', ${hash}, 'pending',
              ${new Date(Date.now() + 86_400_000)}, ${inviterId})`;
    return raw;
  }

  async function isMember(): Promise<boolean> {
    const rows = await sql`select 1 from members
      where workspace_id = ${ws} and user_id = ${inviteeId}`;
    return rows.length > 0;
  }

  it("refuses an unverified address, and joins nobody", async () => {
    const token = await invite();

    const result = await svc.redeemInvitation(db, token, invitee);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("email_unverified");
    expect(await isMember()).toBe(false);

    // The invitation is left usable rather than burned: the person has done
    // nothing wrong and will come back after verifying.
    const [row] = await sql<{ status: string }[]>`
      select status from invitations where workspace_id = ${ws}`;
    expect(row!.status).toBe("pending");
  });

  it("accepts once the address is verified", async () => {
    const token = await invite();
    await sql`update users set email_verified = true where id = ${inviteeId}`;

    const result = await svc.redeemInvitation(db, token, invitee);

    expect(result.ok).toBe(true);
    expect(await isMember()).toBe(true);
  });

  it("reads verification from the database, not from the caller's session", async () => {
    // The session is minted at sign-in and can predate verification, so taking
    // this from `SessionUser` would answer with whatever was true then. Here the
    // caller passes an ordinary session object and the column is what decides.
    const token = await invite();
    await sql`update users set email_verified = true where id = ${inviteeId}`;

    const result = await svc.redeemInvitation(db, token, {
      ...invitee,
      // Nothing on this object says anything about verification, which is the
      // point: there is no field here to get out of step.
      name: "Ivy from an older session",
    });

    expect(result.ok).toBe(true);
  });

  it("still refuses a mismatched address before it looks at verification", async () => {
    // Order matters for the message: telling a signed-in stranger to "verify
    // your email" when the real problem is that the invite was for somebody
    // else would send them down the wrong path.
    const token = await invite();
    await sql`update users set email_verified = true where id = ${inviteeId}`;

    const result = await svc.redeemInvitation(db, token, {
      ...invitee,
      email: `someone-else-${suffix}@redeem.test`,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("email_mismatch");
  });
});
