import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb, type Database } from "@specboards/db";

import { importedSpecIds } from "./github-sync";

/**
 * Which specs the import scan considers already on the board.
 *
 * This is what the onboarding prompt counts. It used to count files in the
 * repository instead, so "Create 2 cards" could create none and then report
 * "Imported 1 spec" -- three numbers, no two of them the same.
 *
 * The predicate has to match the one `syncRepository` applies per spec, and
 * the part worth pinning down is its repo clause, which is not obvious from
 * either side: a work item with no repo still counts (it was created in the
 * app and the spec will attach to it), while one belonging to a *different*
 * connected repo does not (two repos holding a copy of the same spec file keep
 * their own rows, so this repo would still create one).
 *
 * Needs a migrated Postgres at DATABASE_URL; skips itself when unset.
 */

const OWNER_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const wsId = randomUUID();
const otherWsId = randomUUID();
const repoId = randomUUID();
const otherRepoId = randomUUID();
const productId = randomUUID();
const otherProductId = randomUUID();
const suffix = randomUUID().slice(0, 8);

/** Spec ids standing for each case the predicate has to separate. */
const spec = {
  synced: randomUUID(),
  appCreated: randomUUID(),
  otherRepo: randomUUID(),
  otherWorkspace: randomUUID(),
  unknown: randomUUID(),
};

describe.skipIf(!OWNER_URL)("importedSpecIds", () => {
  let owner: postgres.Sql;
  let db: Database;

  beforeAll(async () => {
    owner = postgres(OWNER_URL!, { prepare: false, max: 2 });
    db = createDb(OWNER_URL!);

    await owner`insert into workspaces (id, name, slug) values
      (${wsId}, 'Scan', ${"scan-int-" + suffix}),
      (${otherWsId}, 'Scan Other', ${"scan-other-int-" + suffix})`;
    // features.level is a foreign key into the workspace's hierarchy, so each
    // workspace needs its leaf level before it can hold a spec-backed item.
    await owner`insert into workspace_levels (workspace_id, key, label, position, is_leaf) values
      (${wsId}, 'work', 'Work Item', 0, true),
      (${otherWsId}, 'work', 'Work Item', 0, true)`;
    await owner`insert into products (id, workspace_id, key, name) values
      (${productId}, ${wsId}, 'default', 'General'),
      (${otherProductId}, ${otherWsId}, 'default', 'General')`;
    await owner`insert into repositories (id, workspace_id, github_installation_id, owner, name, default_branch) values
      (${repoId}, ${wsId}, ${"scan-install-" + suffix}, 'acme', 'specs', 'main'),
      (${otherRepoId}, ${wsId}, ${"scan-install-2-" + suffix}, 'acme', 'specs-fork', 'main')`;

    await owner`insert into features (id, workspace_id, repo_id, product_id, spec_id, title, level) values
      -- Previously synced from this repo.
      (${randomUUID()}, ${wsId}, ${repoId}, ${productId}, ${spec.synced}, 'Synced', 'work'),
      -- Created in the app, no repo: sync attaches the spec to this row.
      (${randomUUID()}, ${wsId}, null, ${productId}, ${spec.appCreated}, 'App created', 'work'),
      -- Belongs to a different connected repo in the same workspace.
      (${randomUUID()}, ${wsId}, ${otherRepoId}, ${productId}, ${spec.otherRepo}, 'Other repo', 'work'),
      -- Same spec id, someone else's workspace.
      (${randomUUID()}, ${otherWsId}, null, ${otherProductId}, ${spec.otherWorkspace}, 'Other workspace', 'work')`;
  });

  afterAll(async () => {
    await owner`delete from workspaces where id in (${wsId}, ${otherWsId})`;
    await owner.end({ timeout: 5 });
  });

  const repo = { id: repoId, workspaceId: wsId };

  it("counts a spec previously synced from this repo", async () => {
    const found = await importedSpecIds(db, repo, [spec.synced]);
    expect([...found]).toEqual([spec.synced]);
  });

  it("counts a work item created in the app, which the spec will attach to", async () => {
    // Importing this file updates the existing card rather than making a
    // second one, so offering to "create" it would be wrong.
    const found = await importedSpecIds(db, repo, [spec.appCreated]);
    expect([...found]).toEqual([spec.appCreated]);
  });

  it("does not count a row owned by another connected repo", async () => {
    // That row is the other repo's copy. This repo's sync would insert its own,
    // so this file really is a card waiting to be created.
    const found = await importedSpecIds(db, repo, [spec.otherRepo]);
    expect([...found]).toEqual([]);
  });

  it("does not count a row in another workspace", async () => {
    const found = await importedSpecIds(db, repo, [spec.otherWorkspace]);
    expect([...found]).toEqual([]);
  });

  it("does not count an id nothing on the board carries", async () => {
    const found = await importedSpecIds(db, repo, [spec.unknown]);
    expect([...found]).toEqual([]);
  });

  it("separates the cases in one call, which is how the scan uses it", async () => {
    const found = await importedSpecIds(db, repo, [
      spec.synced,
      spec.appCreated,
      spec.otherRepo,
      spec.otherWorkspace,
      spec.unknown,
    ]);
    expect([...found].sort()).toEqual([spec.synced, spec.appCreated].sort());
  });

  it("asks nothing of the database for an empty list", async () => {
    // Every spec in the repo is missing its id (a fresh repository), which is
    // the case the scan hits before anything has ever been imported.
    expect([...(await importedSpecIds(db, repo, []))]).toEqual([]);
  });
});
