import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Who is allowed to vote twice, asked of the database rather than of the code.
 *
 * `idea_votes` holds two kinds of voter since migration 0010: an internal
 * member (`user_id`) and an external portal visitor who confirmed an emailed
 * link (`voter_email`). "One vote each" has to hold for both, independently,
 * and the interesting failures are all ones where the table still LOOKS
 * constrained:
 *
 * - Keeping `unique (idea_id, user_id)` and letting `user_id` be null accepts
 *   unlimited anonymous votes, because two NULLs do not conflict in Postgres.
 *   Nothing errors, nothing warns, and the vote count is fiction.
 * - Making it `NULLS NOT DISTINCT` (PG15+) fixes that and merges the two
 *   identity kinds into one key, so a member and an external voter collide on
 *   a column neither populates.
 * - A case-varying address is two voters unless the key is case-folded.
 *
 * None of those are visible in a schema diff at a glance, and the symptom of
 * each is a wrong number on a public page rather than an exception. So they are
 * asserted here, against real Postgres, where `NULLS DISTINCT` semantics
 * actually apply. A unit test could not ask this question of anything.
 *
 * Needs a migrated Postgres at DATABASE_URL; skips itself when unset.
 */

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const ws = randomUUID();
const product = randomUUID();
const idea = randomUUID();
const otherIdea = randomUUID();
const member = randomUUID();
const suffix = randomUUID().slice(0, 8);

describe.skipIf(!DB_URL)("one vote each, per identity kind", () => {
  let sql: postgres.Sql;

  /** Cast a vote, returning nothing; rejects if the database refuses it. */
  const vote = (
    ideaId: string,
    identity: { userId: string } | { email: string },
  ) =>
    "userId" in identity
      ? sql`insert into idea_votes (workspace_id, idea_id, user_id)
             values (${ws}, ${ideaId}, ${identity.userId})`
      : sql`insert into idea_votes (workspace_id, idea_id, voter_email)
             values (${ws}, ${ideaId}, ${identity.email})`;

  const countVotes = async (ideaId: string) => {
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from idea_votes where idea_id = ${ideaId}`;
    return Number(row?.n ?? 0);
  };

  beforeAll(async () => {
    sql = postgres(DB_URL!, { prepare: false, max: 2 });
    await sql`insert into workspaces (id, name, slug)
      values (${ws}, 'Votes Co', ${`votes-${suffix}`})`;
    await sql`insert into products (id, workspace_id, key, name)
      values (${product}, ${ws}, ${`votes-${suffix}`}, 'Product')`;
    await sql`insert into ideas (id, workspace_id, product_id, title, status) values
      (${idea}, ${ws}, ${product}, 'Voted idea', 'planned'),
      (${otherIdea}, ${ws}, ${product}, 'Another idea', 'planned')`;
  });

  afterAll(async () => {
    await sql`delete from idea_votes where workspace_id = ${ws}`;
    await sql`delete from ideas where workspace_id = ${ws}`;
    await sql`delete from products where workspace_id = ${ws}`;
    await sql`delete from workspaces where id = ${ws}`;
    await sql.end({ timeout: 5 });
  });

  it("lets a member and an external voter each vote on the same idea", async () => {
    // The case a single merged key would break. Neither row populates the
    // other's identity column, so a key spanning both would see two rows
    // agreeing on (idea, null, null) and reject the second.
    await vote(idea, { userId: member });
    await vote(idea, { email: `ada-${suffix}@example.com` });
    expect(await countVotes(idea)).toBe(2);
  });

  it("refuses a second vote from the same member", async () => {
    await expect(vote(idea, { userId: member })).rejects.toThrow(
      /idea_votes_idea_user_uq/,
    );
  });

  it("refuses a second vote from the same external voter", async () => {
    // The one a nullable column with a plain unique index would wave through,
    // silently, forever.
    await expect(
      vote(idea, { email: `ada-${suffix}@example.com` }),
    ).rejects.toThrow(/idea_votes_idea_email_uq/);
  });

  it("treats a case-varying address as the same voter", async () => {
    // The index is on `lower(voter_email)`. The intake normalises too, so this
    // should never be the thing that stops a duplicate; it is here so that the
    // guarantee does not rest on one `.toLowerCase()` in application code.
    await expect(
      vote(idea, { email: `ADA-${suffix.toUpperCase()}@Example.COM` }),
    ).rejects.toThrow(/idea_votes_idea_email_uq/);
  });

  it("scopes uniqueness to the idea, not the voter", async () => {
    // Both identities vote again on a different idea. A key that forgot
    // `idea_id` would pass every case above and fail only here.
    await vote(otherIdea, { userId: member });
    await vote(otherIdea, { email: `ada-${suffix}@example.com` });
    expect(await countVotes(otherIdea)).toBe(2);
  });

  it("refuses a row carrying both identities, or neither", async () => {
    // A row with two identities counts once and occupies both indexes; a row
    // with none is an unattributable vote that neither index constrains, so it
    // could be inserted without limit. `idea_votes_one_identity_chk` is the
    // reason neither is representable.
    await expect(
      sql`insert into idea_votes (workspace_id, idea_id, user_id, voter_email)
          values (${ws}, ${idea}, ${randomUUID()}, ${`both-${suffix}@example.com`})`,
    ).rejects.toThrow(/idea_votes_one_identity_chk/);

    await expect(
      sql`insert into idea_votes (workspace_id, idea_id)
          values (${ws}, ${idea})`,
    ).rejects.toThrow(/idea_votes_one_identity_chk/);
  });
});
