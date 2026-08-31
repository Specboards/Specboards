import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DbStore } from "./db";
import { FeatureError } from "./types";

/**
 * ADR 0003 ("a spec is an attachment, not an identity") integration suite:
 * exercises leaf-level work items against a migrated Postgres with RLS active,
 * via a non-owner app role (same provisioning as releases.int.test.ts).
 *
 * Covers the card's acceptance criteria: a leaf item can be created without a
 * spec and counts in its parent's rollup; a Feature mixing human and agent
 * children rolls up honestly; `isDbNative` is derived from spec_index presence
 * rather than repo_id, so a spec-backed leaf keeps its git-owned title while a
 * spec-less one can be renamed and deleted; and deleting a spec-backed item
 * needs the caller to have removed its file first.
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
const user = { owner: randomUUID(), viewer: randomUUID() };
const productId = randomUUID();
const repoId = randomUUID();
const suffix = randomUUID().slice(0, 8);

const asOwner = { userId: user.owner, workspaceId: ws };
const asViewer = { userId: user.viewer, workspaceId: ws };

/** Insert a spec-backed leaf row the way GitHub sync does: a features row with
 * a repo + frontmatter id, plus the spec_index row that *is* the attachment. */
async function insertSpecBackedItem(
  owner: postgres.Sql,
  opts: { specId: string; title: string; parentId: string; path: string },
) {
  const id = randomUUID();
  await owner`insert into features
    (id, workspace_id, repo_id, product_id, spec_id, level, title, parent_id, parent_set_by)
    values (${id}, ${ws}, ${repoId}, ${productId}, ${opts.specId}, 'work',
            ${opts.title}, ${opts.parentId}, 'system')`;
  await owner`insert into spec_index (feature_id, path, blob_sha, content)
    values (${id}, ${opts.path}, ${"sha-" + opts.specId.slice(0, 8)},
            ${"# " + opts.title})`;
  return id;
}

describe.skipIf(!OWNER_URL)("leaf work items without specs (ADR 0003)", () => {
  let owner: postgres.Sql;
  let store: DbStore;
  let featureSpecId: string;

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
      (${ws}, 'Decouple', ${"dec-int-" + suffix})`;
    await owner`insert into users (id, name, email) values
      (${user.owner}, 'Owner', ${`owner-${suffix}@dec.test`}),
      (${user.viewer}, 'Viewer', ${`viewer-${suffix}@dec.test`})`;
    await owner`insert into members (workspace_id, user_id, role) values
      (${ws}, ${user.owner}, 'owner'),
      (${ws}, ${user.viewer}, 'member')`;
    await owner`insert into products (id, workspace_id, key, name) values
      (${productId}, ${ws}, 'alpha', 'Alpha')`;
    await owner`insert into product_members (workspace_id, product_id, user_id, role) values
      (${ws}, ${productId}, ${user.viewer}, 'viewer')`;
    await owner`insert into repositories
      (id, workspace_id, github_installation_id, owner, name) values
      (${repoId}, ${ws}, 'install-1', 'acme', 'specs')`;
    // Feature (grouping) over a leaf level, matching the shipped default shape.
    await owner`insert into workspace_levels (workspace_id, key, label, position, is_leaf) values
      (${ws}, 'feature', 'Features', 0, false),
      (${ws}, 'work', 'Work Items', 1, true)`;

    store = new DbStore(appUrlFrom(OWNER_URL!));

    const parent = await store.createFeature(
      { title: "Mixed feature", level: "feature", productId },
      asOwner,
    );
    featureSpecId = parent.specId;
  });

  afterAll(async () => {
    await owner`delete from workspaces where id = ${ws}`;
    await owner`delete from users where id in (${user.owner}, ${user.viewer})`;
    await owner.end({ timeout: 5 });
  });

  it("creates a leaf work item with no spec, under a Feature", async () => {
    const item = await store.createFeature(
      {
        title: "Human task",
        level: "work",
        productId,
        parentSpecId: featureSpecId,
      },
      asOwner,
    );
    expect(item.level).toBe("work");
    expect(item.parentSpecId).toBe(featureSpecId);
    // No spec attached, so it owns its own title and body.
    expect(item.isDbNative).toBe(true);
  });

  it("reports isDbNative from spec_index, not repo_id", async () => {
    const specId = randomUUID();
    const parentRow =
      await owner`select id from features where spec_id = ${featureSpecId}`;
    await insertSpecBackedItem(owner, {
      specId,
      title: "Agent spec",
      parentId: parentRow[0]!.id as string,
      path: "specs/agent-spec/spec.md",
    });

    const agent = await store.getFeature(specId, asOwner);
    expect(agent).not.toBeNull();
    // Has a spec_index row -> not "DB-native", and its path comes from the index.
    expect(agent!.isDbNative).toBe(false);
    expect(agent!.path).toBe("specs/agent-spec/spec.md");

    // The spec-less sibling created above is the other half of the contrast.
    const all = await store.listFeatures(asOwner);
    const human = all.find((f) => f.title === "Human task");
    expect(human!.isDbNative).toBe(true);
    expect(human!.path).toBe("");
  });

  it("rolls a Feature's human + agent children up together", async () => {
    const before = (await store.listFeatures(asOwner)).find(
      (f) => f.specId === featureSpecId,
    );
    expect(before!.childCount).toBe(2);
    expect(before!.childDoneCount).toBe(0);

    // Marking the *human* item done moves the rollup, which is the whole point:
    // work with no spec is not invisible to progress.
    const human = (await store.listFeatures(asOwner)).find(
      (f) => f.title === "Human task",
    )!;
    await store.updateFeature(human.specId, { status: "done" }, asOwner);

    const after = (await store.listFeatures(asOwner)).find(
      (f) => f.specId === featureSpecId,
    );
    expect(after!.childCount).toBe(2);
    expect(after!.childDoneCount).toBe(1);
  });

  it("renames and deletes a leaf item that has no spec", async () => {
    const item = await store.createFeature(
      {
        title: "Disposable",
        level: "work",
        productId,
        parentSpecId: featureSpecId,
      },
      asOwner,
    );
    await store.updateFeature(item.specId, { title: "Renamed" }, asOwner);
    expect((await store.getFeature(item.specId, asOwner))!.title).toBe(
      "Renamed",
    );

    await store.deleteFeature(item.specId, asOwner);
    expect(await store.getFeature(item.specId, asOwner)).toBeNull();
  });

  it("refuses to delete a spec-backed item until its file is gone", async () => {
    const specId = randomUUID();
    const parentRow =
      await owner`select id from features where spec_id = ${featureSpecId}`;
    await insertSpecBackedItem(owner, {
      specId,
      title: "Attached",
      parentId: parentRow[0]!.id as string,
      path: "specs/attached/spec.md",
    });

    // Without the opt-in: refused, and the message names the file, because a
    // surviving file would be re-imported by the next sync.
    await expect(store.deleteFeature(specId, asOwner)).rejects.toThrow(
      /specs\/attached\/spec\.md/,
    );
    expect(await store.getFeature(specId, asOwner)).not.toBeNull();

    // With it (the caller having removed the file), the row and its index go.
    await store.deleteFeature(specId, asOwner, undefined, {
      specRemoved: true,
    });
    expect(await store.getFeature(specId, asOwner)).toBeNull();
    const index = await owner`select 1 from spec_index si
      join features f on f.id = si.feature_id where f.spec_id = ${specId}`;
    expect(index).toHaveLength(0);
  });

  it("still enforces product-write access on a leaf create", async () => {
    await expect(
      store.createFeature(
        {
          title: "Not allowed",
          level: "work",
          productId,
          parentSpecId: featureSpecId,
        },
        asViewer,
      ),
    ).rejects.toThrow(FeatureError);
  });

  it("rejects a leaf item under a parent that is not one level up", async () => {
    const leaf = (await store.listFeatures(asOwner)).find(
      (f) => f.title === "Human task",
    )!;
    await expect(
      store.createFeature(
        {
          title: "Too deep",
          level: "work",
          productId,
          parentSpecId: leaf.specId,
        },
        asOwner,
      ),
    ).rejects.toThrow(FeatureError);
  });
});
