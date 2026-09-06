import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DbStore } from "./db";

/**
 * Bulk tag management: merging two tags into one, and the rewrite it performs
 * on every item that carried the loser.
 *
 * This cannot be a unit test. The merge is a single `UPDATE` whose whole job is
 * to rebuild a `text[]` in place: map the old name to the new one, drop the
 * duplicate that mapping creates on an item that carried both, and put the
 * array back in the order its author left it. Every one of those is Postgres
 * behaviour (`unnest … WITH ORDINALITY`, `DISTINCT ON`, `array_agg … ORDER BY`)
 * and none of it is exercised by anything a mock could stand in for.
 *
 * The store connects as a non-owner role, so RLS is live and a merge that
 * silently matched zero rows would fail here rather than in production.
 *
 * Needs a migrated Postgres at DATABASE_URL; skips itself when unset.
 */

const OWNER_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const APP_ROLE = "rls_int_app";
const APP_PASSWORD = "rls-int-only-not-a-real-secret";

function appUrlFrom(ownerUrl: string): string {
  const url = new URL(ownerUrl);
  url.username = APP_ROLE;
  url.password = APP_PASSWORD;
  return url.toString();
}

const ws = randomUUID();
const otherWs = randomUUID();
const ownerId = randomUUID();
const product = randomUUID();
const suffix = randomUUID().slice(0, 8);

const asOwner = { userId: ownerId, workspaceId: ws };

describe.skipIf(!OWNER_URL)("bulk tag management (store)", () => {
  let owner: postgres.Sql;
  let store: DbStore;

  /** Insert one item carrying `tags`, and return its row id. */
  async function itemWith(tags: string[], workspaceId = ws): Promise<string> {
    const id = randomUUID();
    await owner`insert into features
      (id, workspace_id, product_id, spec_id, level, title, status, tags) values
      (${id}, ${workspaceId}, ${workspaceId === ws ? product : null},
       ${randomUUID()}, 'feature', 'Item', 'backlog', ${tags})`;
    return id;
  }

  async function tagsOn(id: string): Promise<string[]> {
    const [row] = await owner<{ tags: string[] }[]>`
      select tags from features where id = ${id}`;
    return row!.tags;
  }

  /** Names in the registry, in display order. */
  async function names(): Promise<string[]> {
    return (await store.listTags(asOwner)).map((t) => t.name);
  }

  beforeAll(async () => {
    owner = postgres(OWNER_URL!, { prepare: false, max: 2 });
    await owner.unsafe(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = '${APP_ROLE}') then
          create role ${APP_ROLE} login password '${APP_PASSWORD}';
        end if;
      end $$;
      grant usage on schema public to ${APP_ROLE};
      grant select, insert, update, delete on all tables in schema public to ${APP_ROLE};
      grant usage, select on all sequences in schema public to ${APP_ROLE};
      grant execute on all functions in schema public to ${APP_ROLE};
    `);

    await owner`insert into workspaces (id, name, slug) values
      (${ws}, 'Tags', ${"tags-int-" + suffix}),
      (${otherWs}, 'Other', ${"tags-other-" + suffix})`;
    await owner`insert into users (id, name, email) values
      (${ownerId}, 'Owner', ${`owner-${suffix}@t.test`})`;
    await owner`insert into members (workspace_id, user_id, role) values
      (${ws}, ${ownerId}, 'owner')`;
    await owner`insert into products (id, workspace_id, key, name) values
      (${product}, ${ws}, 'alpha', 'Alpha')`;
    // Both workspaces get the level, because the cross-workspace test needs a
    // real item sitting in the other one.
    await owner`insert into workspace_levels (workspace_id, key, label, position, is_leaf)
      values (${ws}, 'feature', 'Feature', 0, true),
             (${otherWs}, 'feature', 'Feature', 0, true)`;

    store = new DbStore(appUrlFrom(OWNER_URL!));
  });

  beforeEach(async () => {
    await owner`delete from features where workspace_id in (${ws}, ${otherWs})`;
    await owner`delete from workspace_tags where workspace_id in (${ws}, ${otherWs})`;
  });

  afterAll(async () => {
    await owner`delete from workspaces where id in (${ws}, ${otherWs})`;
    await owner`delete from users where id = ${ownerId}`;
    await owner.end({ timeout: 5 });
  });

  describe("mergeTags", () => {
    it("re-tags every item that carried the loser", async () => {
      await store.ensureTags(["SF", "Salesforce"], asOwner);
      const [sf, salesforce] = await store.listTags(asOwner);
      const item = await itemWith(["SF", "tier-1"]);

      await store.mergeTags(sf!.id, salesforce!.id, asOwner);

      expect(await tagsOn(item)).toEqual(["Salesforce", "tier-1"]);
      expect(await names()).toEqual(["Salesforce"]);
    });

    it("does not leave the survivor on an item twice", async () => {
      // An item already carrying both spellings is the case a naive
      // find-and-replace gets wrong.
      await store.ensureTags(["SF", "Salesforce"], asOwner);
      const [sf, salesforce] = await store.listTags(asOwner);
      const item = await itemWith(["SF", "tier-1", "Salesforce"]);

      await store.mergeTags(sf!.id, salesforce!.id, asOwner);

      expect(await tagsOn(item)).toEqual(["Salesforce", "tier-1"]);
    });

    it("keeps the order the item's author left", async () => {
      await store.ensureTags(["SF", "Salesforce"], asOwner);
      const [sf, salesforce] = await store.listTags(asOwner);
      const item = await itemWith(["zeta", "SF", "alpha"]);

      await store.mergeTags(sf!.id, salesforce!.id, asOwner);

      expect(await tagsOn(item)).toEqual(["zeta", "Salesforce", "alpha"]);
    });

    it("picks up a legacy casing that predates the registry", async () => {
      await store.ensureTags(["SF", "Salesforce"], asOwner);
      const [sf, salesforce] = await store.listTags(asOwner);
      const item = await itemWith(["sf"]);

      await store.mergeTags(sf!.id, salesforce!.id, asOwner);

      expect(await tagsOn(item)).toEqual(["Salesforce"]);
    });

    it("leaves items that carried neither tag alone", async () => {
      await store.ensureTags(["SF", "Salesforce"], asOwner);
      const [sf, salesforce] = await store.listTags(asOwner);
      const untouched = await itemWith(["tier-1"]);
      const empty = await itemWith([]);

      await store.mergeTags(sf!.id, salesforce!.id, asOwner);

      expect(await tagsOn(untouched)).toEqual(["tier-1"]);
      expect(await tagsOn(empty)).toEqual([]);
    });

    it("does not reach into another workspace's items", async () => {
      await store.ensureTags(["SF", "Salesforce"], asOwner);
      const [sf, salesforce] = await store.listTags(asOwner);
      const foreign = await itemWith(["SF"], otherWs);

      await store.mergeTags(sf!.id, salesforce!.id, asOwner);

      expect(await tagsOn(foreign)).toEqual(["SF"]);
    });

    it("refuses to merge a tag into itself", async () => {
      await store.ensureTags(["SF"], asOwner);
      const [sf] = await store.listTags(asOwner);
      await expect(
        store.mergeTags(sf!.id, sf!.id, asOwner),
      ).rejects.toThrow(/itself/);
    });

    it("refuses an unknown tag rather than reporting a silent success", async () => {
      await store.ensureTags(["SF"], asOwner);
      const [sf] = await store.listTags(asOwner);
      await expect(
        store.mergeTags(sf!.id, randomUUID(), asOwner),
      ).rejects.toThrow(/Unknown tag/);
      await expect(
        store.mergeTags(randomUUID(), sf!.id, asOwner),
      ).rejects.toThrow(/Unknown tag/);
    });
  });

  describe("renameTag", () => {
    it("still refuses to rename onto a name that exists", async () => {
      // The merge above is the deliberate way to do this; the single rename
      // must not start doing it by accident.
      await store.ensureTags(["SF", "Salesforce"], asOwner);
      const [sf] = await store.listTags(asOwner);
      await expect(
        store.renameTag(sf!.id, "Salesforce", asOwner),
      ).rejects.toThrow(/already exists/);
    });
  });

  describe("deleteTag", () => {
    it("takes the tag off the items that carry it", async () => {
      // This used to leave item values alone. It cascades now: a tag deleted
      // from the registry must not stay drawn on a card with nowhere left to
      // manage it. Bulk delete is a loop over this, so it inherits the same.
      await store.ensureTags(["retired"], asOwner);
      const [retired] = await store.listTags(asOwner);
      const item = await itemWith(["retired", "tier-1"]);

      const changed = await store.deleteTag(retired!.id, asOwner);

      expect(changed).toBe(1);
      expect(await names()).toEqual([]);
      expect(await tagsOn(item)).toEqual(["tier-1"]);
    });

    it("leaves an item with no tags rather than a null array", async () => {
      // COALESCE in the rebuild: array_agg over an empty filter returns NULL,
      // and a null tags column breaks every reader downstream.
      await store.ensureTags(["only"], asOwner);
      const [only] = await store.listTags(asOwner);
      const item = await itemWith(["only"]);

      await store.deleteTag(only!.id, asOwner);

      expect(await tagsOn(item)).toEqual([]);
    });

    it("strips a legacy casing along with the registry's spelling", async () => {
      await store.ensureTags(["Retired"], asOwner);
      const [retired] = await store.listTags(asOwner);
      const item = await itemWith(["RETIRED", "tier-1"]);

      await store.deleteTag(retired!.id, asOwner);

      expect(await tagsOn(item)).toEqual(["tier-1"]);
    });

    it("keeps the order of the tags it leaves behind", async () => {
      await store.ensureTags(["mid"], asOwner);
      const [mid] = await store.listTags(asOwner);
      const item = await itemWith(["zeta", "mid", "alpha"]);

      await store.deleteTag(mid!.id, asOwner);

      expect(await tagsOn(item)).toEqual(["zeta", "alpha"]);
    });

    it("does not reach into another workspace's items", async () => {
      await store.ensureTags(["shared"], asOwner);
      const [shared] = await store.listTags(asOwner);
      const foreign = await itemWith(["shared"], otherWs);

      const changed = await store.deleteTag(shared!.id, asOwner);

      expect(changed).toBe(0);
      expect(await tagsOn(foreign)).toEqual(["shared"]);
    });

    it("reports how many items it changed", async () => {
      await store.ensureTags(["wide"], asOwner);
      const [wide] = await store.listTags(asOwner);
      await itemWith(["wide"]);
      await itemWith(["wide", "other"]);
      await itemWith(["untouched"]);

      expect(await store.deleteTag(wide!.id, asOwner)).toBe(2);
    });

    it("refuses an unknown tag", async () => {
      await expect(store.deleteTag(randomUUID(), asOwner)).rejects.toThrow(
        /Unknown tag/,
      );
    });
  });

  describe("tagUsageCounts", () => {
    it("counts items per tag, keyed case-insensitively", async () => {
      await store.ensureTags(["area:web", "unused"], asOwner);
      await itemWith(["area:web", "tier-1"]);
      await itemWith(["AREA:WEB"]);

      const counts = await store.tagUsageCounts(asOwner);

      expect(counts["area:web"]).toBe(2);
      expect(counts["tier-1"]).toBe(1);
      // A tag nobody uses is absent, not zero; the caller reads that as none.
      expect(counts["unused"]).toBeUndefined();
    });

    it("counts an item once however many casings it carries", async () => {
      await itemWith(["dup", "DUP"]);
      expect((await store.tagUsageCounts(asOwner))["dup"]).toBe(1);
    });

    it("does not count another workspace's items", async () => {
      await itemWith(["mine"]);
      await itemWith(["mine"], otherWs);
      expect((await store.tagUsageCounts(asOwner))["mine"]).toBe(1);
    });
  });
});
