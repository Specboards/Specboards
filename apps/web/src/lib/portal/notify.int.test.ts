import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createDb } from "@specboards/db";

import { portalRecipients } from "./notify";

/**
 * Who hears about an idea, and who has asked not to.
 *
 * The recipient set is the whole risk in this feature. Getting it too small
 * means the addresses were collected for nothing; getting it too large means
 * emailing somebody who told us to stop, which is the one mistake that turns
 * "unsubscribe" into "mark as spam" and costs the deployment its sending
 * reputation rather than costing us one recipient.
 *
 * Needs a migrated Postgres at DATABASE_URL; skips itself when unset.
 */

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const ws = randomUUID();
const otherWs = randomUUID();
const product = randomUUID();
const idea = randomUUID();
const otherIdea = randomUUID();
const suffix = randomUUID().slice(0, 8);

const submitter = `submitter-${suffix}@example.com`;
const voterA = `voter-a-${suffix}@example.com`;
const voterB = `voter-b-${suffix}@example.com`;

describe.skipIf(!DB_URL)("portal notification recipients", () => {
  let sql: postgres.Sql;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    sql = postgres(DB_URL!, { prepare: false, max: 2 });
    db = createDb(DB_URL!);

    await sql`insert into workspaces (id, name, slug) values
      (${ws}, 'Notify Co', ${`notify-${suffix}`}),
      (${otherWs}, 'Other Co', ${`other-${suffix}`})`;
    await sql`insert into products (id, workspace_id, key, name)
      values (${product}, ${ws}, ${`p-${suffix}`}, 'Product')`;
    await sql`insert into ideas (id, workspace_id, product_id, title, status, submitter_email) values
      (${idea}, ${ws}, ${product}, 'Notified idea', 'planned', ${submitter}),
      (${otherIdea}, ${ws}, ${product}, 'Another idea', 'planned', null)`;
    await sql`insert into idea_votes (workspace_id, idea_id, voter_email) values
      (${ws}, ${idea}, ${voterA}),
      (${ws}, ${idea}, ${voterB}),
      (${ws}, ${otherIdea}, ${`elsewhere-${suffix}@example.com`})`;
  });

  beforeEach(async () => {
    await sql`delete from portal_email_opt_outs where workspace_id in ${sql([ws, otherWs])}`;
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await sql`delete from portal_email_opt_outs where workspace_id in ${sql([ws, otherWs])}`;
    await sql`delete from idea_votes where workspace_id = ${ws}`;
    await sql`delete from ideas where workspace_id = ${ws}`;
    await sql`delete from products where workspace_id = ${ws}`;
    await sql`delete from workspaces where id in ${sql([ws, otherWs])}`;
    await sql.end({ timeout: 5 });
  });

  it("tells the submitter and every voter", async () => {
    const got = await portalRecipients(db, ws, idea);
    expect(got.sort()).toEqual([submitter, voterA, voterB].sort());
  });

  it("does not reach into another idea's voters", async () => {
    const got = await portalRecipients(db, ws, otherIdea);
    expect(got).toEqual([`elsewhere-${suffix}@example.com`]);
  });

  it("counts a submitter who also voted once", async () => {
    // One person, one email. The two columns are populated independently, so
    // without the de-duplication this is the common case that double-sends:
    // people vote for their own suggestion.
    await sql`insert into idea_votes (workspace_id, idea_id, voter_email)
      values (${ws}, ${idea}, ${submitter})`;
    try {
      const got = await portalRecipients(db, ws, idea);
      expect(got.filter((e) => e === submitter)).toHaveLength(1);
      expect(got).toHaveLength(3);
    } finally {
      await sql`delete from idea_votes
        where idea_id = ${idea} and voter_email = ${submitter}`;
    }
  });

  it("drops anybody who has unsubscribed", async () => {
    await sql`insert into portal_email_opt_outs (workspace_id, email)
      values (${ws}, ${voterA})`;
    const got = await portalRecipients(db, ws, idea);
    expect(got).not.toContain(voterA);
    expect(got.sort()).toEqual([submitter, voterB].sort());
  });

  it("honours an opt-out whatever case it was recorded in", async () => {
    // The address in the vote row and the address in the opt-out row are
    // written by different paths. If either is trusted as typed, somebody who
    // unsubscribed as `Voter-A@` keeps receiving mail addressed to `voter-a@`,
    // which reads as ignoring them.
    await sql`insert into portal_email_opt_outs (workspace_id, email)
      values (${ws}, ${voterA.toUpperCase()})`;
    const got = await portalRecipients(db, ws, idea);
    expect(got).not.toContain(voterA);
  });

  it("does not let one workspace's opt-out silence another's mail", async () => {
    // Opt-outs are per workspace on purpose: asking Acme to stop is not asking
    // Acme's competitor anything. This is that scoping, from the other side.
    await sql`insert into portal_email_opt_outs (workspace_id, email)
      values (${otherWs}, ${voterA})`;
    const got = await portalRecipients(db, ws, idea);
    expect(got).toContain(voterA);
  });

  it("returns nobody for an idea in another workspace", async () => {
    expect(await portalRecipients(db, otherWs, idea)).toEqual([]);
  });
});
