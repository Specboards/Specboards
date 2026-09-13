import { createDb, ideaVotes, isNotNull } from "@specboards/db";
import { describe, expect, it } from "vitest";

/**
 * What the member vote statement actually compiles to.
 *
 * Migration 0010 made `idea_votes_idea_user_uq` a PARTIAL unique index, because
 * external portal voters now share this table and a nullable `user_id` cannot
 * carry a plain unique constraint (NULLs do not conflict in Postgres, so every
 * anonymous vote would be accepted by one). Partial indexes change the contract
 * of every `ON CONFLICT` that targeted the old constraint: Postgres matches a
 * statement to a partial index only when the statement restates the predicate,
 * and raises `there is no unique or exclusion constraint matching the ON
 * CONFLICT specification` when it does not.
 *
 * That failure is loud, which is the good case, but it lands on the ORDINARY
 * member vote path, several layers from the portal work that caused it, and
 * only against real Postgres. A type error would have caught a missing option;
 * nothing catches an option that exists on the overload and means something
 * else. `onConflictDoUpdate` splits the predicate into `targetWhere` (the index
 * predicate) and `setWhere` (a filter on the update), so `where` on the
 * `onConflictDoNothing` overload is the one that has to be read carefully.
 *
 * So this asserts the rendered SQL rather than trusting the reading: the
 * predicate must sit inside `on conflict (...) where ...`, and not become a
 * filter appended to the statement.
 *
 * No connection is opened. `postgres-js` is lazy, so a client built on an
 * unreachable string compiles queries perfectly well and never dials.
 */
describe("member vote ON CONFLICT targets the partial index", () => {
  const db = createDb("postgres://localhost:1/never-connected");

  const sql = db
    .insert(ideaVotes)
    .values({
      workspaceId: "00000000-0000-0000-0000-000000000001",
      ideaId: "00000000-0000-0000-0000-000000000002",
      userId: "00000000-0000-0000-0000-000000000003",
    })
    .onConflictDoNothing({
      target: [ideaVotes.ideaId, ideaVotes.userId],
      where: isNotNull(ideaVotes.userId),
    })
    .toSQL().sql;

  it("names both columns of the index as the conflict target", () => {
    expect(sql).toContain('on conflict ("idea_id","user_id")');
  });

  it("restates the index predicate, so the partial index matches", () => {
    // The predicate must fall between the target list and `do nothing`. Placed
    // anywhere else it is a different statement: Postgres would either fail to
    // match the index or, worse, apply it as a filter.
    expect(sql).toMatch(
      /on conflict \("idea_id","user_id"\)\s+where\s+"idea_votes"\."user_id" is not null\s+do nothing/i,
    );
  });

  it("does not append the predicate as a statement-level filter", () => {
    // An INSERT has no WHERE of its own, so a predicate that escaped the
    // conflict clause would have to appear after `do nothing`. Nothing may.
    expect(sql.split(/do nothing/i)[1]?.trim() ?? "").toBe("");
  });
});
