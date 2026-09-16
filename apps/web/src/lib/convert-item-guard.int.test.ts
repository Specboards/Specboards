import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Converting an item while somebody else changes its neighbourhood.
 *
 * AR-04. `buildPlan` decides against a snapshot (the item, its parent, its
 * children, whether a spec is attached, the workflow and its gates), and the
 * write then changed the item's level and parent having re-read almost none
 * of it. `convertFeatureLevel`'s own comment says "the rules are NOT
 * re-derived here", which was true and was the problem: nothing checked that
 * the rules still held.
 *
 * ── Why the interference is applied by hand ──────────────────────────────
 * The window is between the plan and the write, inside one `convertItem`
 * call, and it is milliseconds wide. Racing it with concurrent callers would
 * be the mistake the run-lifecycle tests made: a timing-dependent test that
 * passes against a broken build because the two callers did not happen to
 * overlap. Instead these take the fingerprint the way the service does, then
 * change the world, then call the write directly with that fingerprint. That
 * is the race held still, and it fails on any build that does not carry the
 * precondition into the write.
 *
 * Needs a migrated Postgres at DATABASE_URL; skips itself when unset.
 */

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const sfx = randomUUID().slice(0, 8);
const ws = randomUUID();
const owner = randomUUID();
const product = randomUUID();
const asOwner = { userId: owner, workspaceId: ws };

describe.skipIf(!DB_URL)("converting an item", () => {
  let sql: postgres.Sql;
  let store: Awaited<ReturnType<typeof import("@/lib/store").getStore>>;
  let convert: typeof import("./convert-item-service");
  let precondition: typeof import("@/lib/store/precondition");

  /** The item under conversion: an epic with one feature under it. */
  let epicId: string;
  let childId: string;
  let grandparentId: string;
  let otherParentId: string;
  /** An epic with no children and no parent: freely convertible. */
  let loneId: string;

  beforeAll(async () => {
    sql = postgres(DB_URL!, { prepare: false, max: 4 });
    const { getStore } = await import("@/lib/store");
    store = await getStore();
    convert = await import("./convert-item-service");
    precondition = await import("@/lib/store/precondition");

    await sql`insert into workspaces (id, name, slug) values
      (${ws}, 'Convert', ${"conv-int-" + sfx})`;
    await sql`insert into users (id, name, email) values
      (${owner}, 'Owner', ${`owner-${sfx}@cv.test`})`;
    await sql`insert into members (workspace_id, user_id, role) values
      (${ws}, ${owner}, 'owner')`;
    await sql`insert into products (id, workspace_id, key, name, visibility)
      values (${product}, ${ws}, 'alpha', 'Alpha', 'org')`;
    // Three levels, so a conversion has somewhere to go and a parent to be
    // illegal under.
    await sql`insert into workspace_levels (workspace_id, key, label, position, is_leaf)
      values (${ws}, 'initiative', 'Initiatives', 0, false),
             (${ws}, 'epic', 'Epics', 1, false),
             (${ws}, 'work', 'Work Items', 2, true)`;
  });

  afterAll(async () => {
    await sql`delete from workspaces where id = ${ws}`;
    await sql`delete from users where id = ${owner}`;
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await sql`delete from features where workspace_id = ${ws}`;
    grandparentId = randomUUID();
    otherParentId = randomUUID();
    epicId = randomUUID();
    childId = randomUUID();
    loneId = randomUUID();
    await sql`insert into features (id, workspace_id, product_id, spec_id, level, title, status) values
      (${grandparentId}, ${ws}, ${product}, ${grandparentId}, 'initiative', 'An initiative', 'backlog'),
      (${otherParentId}, ${ws}, ${product}, ${otherParentId}, 'initiative', 'Another initiative', 'backlog'),
      (${epicId}, ${ws}, ${product}, ${epicId}, 'epic', 'An epic', 'backlog'),
      (${childId}, ${ws}, ${product}, ${childId}, 'work', 'A work item', 'backlog'),
      (${loneId}, ${ws}, ${product}, ${loneId}, 'epic', 'A lone epic', 'backlog')`;
    await sql`update features set parent_id = ${grandparentId} where id = ${epicId}`;
    await sql`update features set parent_id = ${epicId} where id = ${childId}`;
  });

  const levelOf = async (id: string) =>
    (
      await sql<{ level: string }[]>`
        select level from features where id = ${id}`
    )[0]!.level;

  /**
   * The write, driven exactly as `convertItem` drives it: fingerprint first,
   * then whatever the caller does in `interfere`, then the write.
   */
  async function convertWithInterference(
    to: string,
    interfere: () => Promise<void>,
  ) {
    const expect0 = await store.conversionPrecondition(epicId, asOwner);
    await interfere();
    return store.convertFeatureLevel(
      epicId,
      { level: to, detachParent: false },
      asOwner,
      undefined,
      expect0 ?? undefined,
    );
  }

  describe("when the neighbourhood moves between the plan and the write", () => {
    it("refuses when a child was added", async () => {
      // A level that was legal for one child may not be legal for two, or for
      // a child of a different level. The plan saw neither.
      await expect(
        convertWithInterference("work", async () => {
          const extra = randomUUID();
          await sql`insert into features (id, workspace_id, product_id, spec_id, level, title, status, parent_id)
            values (${extra}, ${ws}, ${product}, ${extra}, 'work', 'Another child', 'backlog', ${epicId})`;
        }),
      ).rejects.toBeInstanceOf(precondition.StaleWriteError);
      expect(await levelOf(epicId)).toBe("epic");
    });

    it("refuses when a child's level changed underneath it", async () => {
      await expect(
        convertWithInterference("work", async () => {
          await sql`update features set level = 'epic' where id = ${childId}`;
        }),
      ).rejects.toBeInstanceOf(precondition.StaleWriteError);
      expect(await levelOf(epicId)).toBe("epic");
    });

    it("refuses when a spec was attached", async () => {
      // A spec-backed item cannot leave the leaf level, which is a blocker
      // the plan checks and the write never re-read.
      await expect(
        convertWithInterference("initiative", async () => {
          await sql`insert into spec_index (feature_id, path, blob_sha, content)
            values (${epicId}, ${`specs/${sfx}.md`}, 'deadbeef', 'A spec')`;
        }),
      ).rejects.toBeInstanceOf(precondition.StaleWriteError);
      expect(await levelOf(epicId)).toBe("epic");
    });

    it("refuses when the parent was replaced", async () => {
      await expect(
        convertWithInterference("work", async () => {
          await sql`update features set parent_id = ${otherParentId}
                    where id = ${epicId}`;
        }),
      ).rejects.toBeInstanceOf(precondition.StaleWriteError);
      expect(await levelOf(epicId)).toBe("epic");
    });

    it("refuses when the parent's own level changed", async () => {
      // Which parents are legal depends on the parent's level, not its id, so
      // watching only the id would miss this.
      await expect(
        convertWithInterference("work", async () => {
          await sql`update features set level = 'epic' where id = ${grandparentId}`;
        }),
      ).rejects.toBeInstanceOf(precondition.StaleWriteError);
      expect(await levelOf(epicId)).toBe("epic");
    });

    it("refuses when the item was converted by somebody else first", async () => {
      await expect(
        convertWithInterference("work", async () => {
          await sql`update features set level = 'initiative' where id = ${epicId}`;
        }),
      ).rejects.toBeInstanceOf(precondition.StaleWriteError);
      expect(await levelOf(epicId)).toBe("initiative");
    });
  });

  describe("when nothing moved", () => {
    it("writes the conversion", async () => {
      // The refusals above have to be about the race, not about conversion
      // being broken.
      await convertWithInterference("work", async () => {});
      expect(await levelOf(epicId)).toBe("work");
    });

    it("is not disturbed by a change somewhere else entirely", async () => {
      // The fingerprint watches this item's neighbourhood, not the workspace.
      // A sibling moving is two people not colliding.
      await convertWithInterference("work", async () => {
        await sql`update features set title = 'Renamed' where id = ${otherParentId}`;
      });
      expect(await levelOf(epicId)).toBe("work");
    });

    it("does not care what order the children came back in", async () => {
      // `stable` sorts array members before hashing. Without that, two reads
      // of the same unordered query could disagree and every conversion of an
      // item with more than one child would refuse.
      const second = randomUUID();
      await sql`insert into features (id, workspace_id, product_id, spec_id, level, title, status, parent_id)
        values (${second}, ${ws}, ${product}, ${second}, 'work', 'Second child', 'backlog', ${epicId})`;
      const a = await store.conversionPrecondition(epicId, asOwner);
      const b = await store.conversionPrecondition(epicId, asOwner);
      expect(a).toBe(b);
      expect(a).not.toBeNull();
    });
  });

  describe("through the service", () => {
    it("converts cleanly when nobody interferes", async () => {
      // A lone epic, because converting one that still has a child down to the
      // leaf is a blocker the planner raises on its own. That refusal is the
      // planner working and would mask whether the precondition let the write
      // through.
      const updated = await convert.convertItem(loneId, "work", asOwner);
      expect(updated.level).toBe("work");
    });

    it("reports a vanished item as missing rather than as stale", async () => {
      // "Gone" and "moved" are different answers and the caller acts on them
      // differently. A null fingerprint must not be passed on as a mismatch.
      await sql`delete from features where id = ${loneId}`;
      await expect(convert.convertItem(loneId, "work", asOwner)).rejects.toThrow(
        /unknown|not found/i,
      );
    });
  });
});
