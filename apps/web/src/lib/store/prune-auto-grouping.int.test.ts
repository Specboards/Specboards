import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DbStore } from "./db";

/**
 * pruneAutoGrouping integration suite.
 *
 * This is the only code path in the app that deletes a card the user did not
 * ask to delete, so the tests are weighted towards proving it *refuses*. The
 * one case it must accept is the reported bug: `create_spec` writes each spec
 * to its own folder, sync homes it under a folder-keyed Feature grouping, and
 * the documented `update_item(parentSpecId)` follow-up then re-parents the spec
 * away, stranding a same-named, empty grouping on the board.
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
const user = { owner: randomUUID(), alice: randomUUID() };
const product = randomUUID();
const repo = randomUUID();
const suffix = randomUUID().slice(0, 8);

const asOwner = { userId: user.owner, workspaceId: ws };

describe.skipIf(!OWNER_URL)("pruneAutoGrouping (store + RLS)", () => {
  let owner: postgres.Sql;
  let store: DbStore;

  /**
   * Insert a Feature grouping exactly as github-sync creates one: no repoId
   * (DB-native), an externalKey holding the grouping key, a title generated
   * from that key, and every other column left at its default.
   */
  async function seedGrouping(
    folder: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const id = randomUUID();
    const key = `path:specs/${folder}`;
    const title =
      (overrides.title as string | undefined) ??
      folder.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    await owner`insert into features
      (id, workspace_id, repo_id, product_id, spec_id, level, external_key, title)
      values (${id}, ${ws}, null, ${product}, ${id}, 'epic', ${key}, ${title})`;
    return id;
  }

  /** A spec-backed leaf item homed under `parentId`, as sync would leave it. */
  async function seedSpec(parentId: string | null): Promise<string> {
    const id = randomUUID();
    await owner`insert into features
      (id, workspace_id, repo_id, product_id, spec_id, level, title, parent_id, parent_set_by)
      values (${id}, ${ws}, ${repo}, ${product}, ${id}, 'story', 'A spec',
              ${parentId}, ${parentId ? "system" : null})`;
    return id;
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
      (${ws}, 'Prune', ${"prune-int-" + suffix})`;
    await owner`insert into users (id, name, email) values
      (${user.owner}, 'Owner', ${`owner-${suffix}@prune.test`}),
      (${user.alice}, 'Alice', ${`alice-${suffix}@prune.test`})`;
    await owner`insert into members (workspace_id, user_id, role) values
      (${ws}, ${user.owner}, 'owner'),
      (${ws}, ${user.alice}, 'member')`;
    await owner`insert into products (id, workspace_id, key, name) values
      (${product}, ${ws}, 'alpha', 'Alpha')`;
    await owner`insert into workspace_levels (workspace_id, key, label, position, is_leaf) values
      (${ws}, 'epic', 'Epics', 0, false),
      (${ws}, 'story', 'Stories', 1, true)`;
    await owner`insert into repositories
      (id, workspace_id, github_installation_id, owner, name, default_branch)
      values (${repo}, ${ws}, ${"prune-install-" + suffix}, 'acme', 'widgets', 'main')`;

    store = new DbStore(appUrlFrom(OWNER_URL!));
  });

  afterAll(async () => {
    await owner`delete from workspaces where id = ${ws}`;
    await owner`delete from users where id in (${user.owner}, ${user.alice})`;
    await owner.end({ timeout: 5 });
  });

  async function stillExists(id: string): Promise<boolean> {
    const rows = await owner`select 1 from features where id = ${id}`;
    return rows.length > 0;
  }

  it("prunes an untouched grouping once its last child leaves", async () => {
    const grouping = await seedGrouping("per-scope-checkboxes");
    const spec = await seedSpec(grouping);
    // The re-parent that strands it: the spec moves under a real card.
    await owner`update features set parent_id = null, parent_set_by = 'user'
      where id = ${spec}`;

    expect(await store.pruneAutoGrouping(grouping, asOwner)).toBe(true);
    expect(await stillExists(grouping)).toBe(false);
  });

  it("keeps a grouping that still has a child", async () => {
    const grouping = await seedGrouping("checkout");
    await seedSpec(grouping);

    expect(await store.pruneAutoGrouping(grouping, asOwner)).toBe(false);
    expect(await stillExists(grouping)).toBe(true);
  });

  it("keeps a grouping the user renamed", async () => {
    const grouping = await seedGrouping("search", { title: "Search (Q3)" });

    expect(await store.pruneAutoGrouping(grouping, asOwner)).toBe(false);
    expect(await stillExists(grouping)).toBe(true);
  });

  it("keeps a hand-made card that was never sync-created", async () => {
    // No externalKey: a card a person added on the board. Even when empty and
    // childless it must never be swept up.
    const id = randomUUID();
    await owner`insert into features
      (id, workspace_id, repo_id, product_id, spec_id, level, title)
      values (${id}, ${ws}, null, ${product}, ${id}, 'epic', 'My epic')`;

    expect(await store.pruneAutoGrouping(id, asOwner)).toBe(false);
    expect(await stillExists(id)).toBe(true);
  });

  it("keeps a grouping carrying any user-set field", async () => {
    const cases: Record<string, unknown>[] = [
      { assignee_id: user.alice },
      { details: "Notes I wrote" },
      { tags: ["keep"] },
      { status: "in_progress" },
      { rank: "a0" },
      { rice_reach: 100 },
      { custom_fields: { risk: "high" } },
    ];
    for (const [i, patch] of cases.entries()) {
      const grouping = await seedGrouping(`field-case-${i}`);
      const [column] = Object.keys(patch);
      const value = patch[column!];
      await owner.unsafe(
        `update features set ${column} = $1 where id = $2`,
        [
          column === "custom_fields" ? JSON.stringify(value) : (value as never),
          grouping,
        ] as never,
      );

      expect(
        await store.pruneAutoGrouping(grouping, asOwner),
        `expected the grouping to survive a set ${column}`,
      ).toBe(false);
      expect(await stillExists(grouping)).toBe(true);
    }
  });

  it("keeps a grouping scheduled into a release", async () => {
    const release = randomUUID();
    await owner`insert into releases (id, workspace_id, product_id, name, status)
      values (${release}, ${ws}, ${product}, 'v1', 'planned')`;
    const grouping = await seedGrouping("released");
    await owner`update features set release_id = ${release} where id = ${grouping}`;

    expect(await store.pruneAutoGrouping(grouping, asOwner)).toBe(false);
    expect(await stillExists(grouping)).toBe(true);
  });

  it("keeps a grouping that carries a comment", async () => {
    const grouping = await seedGrouping("commented");
    await owner`insert into comments (workspace_id, feature_id, author_id, body)
      values (${ws}, ${grouping}, ${user.alice}, 'why is this here?')`;

    expect(await store.pruneAutoGrouping(grouping, asOwner)).toBe(false);
    expect(await stillExists(grouping)).toBe(true);
  });

  it("keeps a grouping referenced by a relation, in either direction", async () => {
    const from = await seedGrouping("relates-from");
    const to = await seedGrouping("relates-to");
    await owner`insert into feature_links
      (workspace_id, from_feature_id, to_feature_id, type)
      values (${ws}, ${from}, ${to}, 'blocks')`;

    expect(await store.pruneAutoGrouping(from, asOwner)).toBe(false);
    expect(await store.pruneAutoGrouping(to, asOwner)).toBe(false);
    expect(await stillExists(from)).toBe(true);
    expect(await stillExists(to)).toBe(true);
  });

  it("keeps a grouping that carries a GitHub link", async () => {
    const grouping = await seedGrouping("gh-linked");
    await owner`insert into feature_github_links
      (workspace_id, feature_id, repo_id, kind, number, url)
      values (${ws}, ${grouping}, ${repo}, 'pull_request', 7, 'https://github.com/acme/widgets/pull/7')`;

    expect(await store.pruneAutoGrouping(grouping, asOwner)).toBe(false);
    expect(await stillExists(grouping)).toBe(true);
  });

  it("is a no-op for an unknown id and without a scope", async () => {
    expect(await store.pruneAutoGrouping(randomUUID(), asOwner)).toBe(false);
    expect(await store.pruneAutoGrouping(randomUUID())).toBe(false);
  });
});
