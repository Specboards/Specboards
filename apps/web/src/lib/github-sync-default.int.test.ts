import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb, type Database } from "@specboard/db";

import { resolveRepoDefaultProduct } from "./github-sync";

/**
 * Repo default-product resolution (track B): sync assigns a repo's newly
 * discovered specs to its `product_repositories` default, falling back to the
 * workspace default product when the repo has no links. Also proves the
 * partial unique index (one default per repo) holds at the DB level.
 *
 * Needs a migrated Postgres at DATABASE_URL; skips itself when unset.
 */

const OWNER_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const wsId = randomUUID();
const repoId = randomUUID();
const productId = { def: randomUUID(), payments: randomUUID() };
const suffix = randomUUID().slice(0, 8);

describe.skipIf(!OWNER_URL)("resolveRepoDefaultProduct", () => {
  let owner: postgres.Sql;
  let db: Database;

  beforeAll(async () => {
    owner = postgres(OWNER_URL!, { prepare: false, max: 2 });
    db = createDb(OWNER_URL!);
    await owner`insert into workspaces (id, name, slug) values
      (${wsId}, 'Repo Links', ${"repolinks-int-" + suffix})`;
    // The workspace default product ensureDefaultProduct would resolve.
    await owner`insert into products (id, workspace_id, key, name) values
      (${productId.def}, ${wsId}, 'default', 'General'),
      (${productId.payments}, ${wsId}, 'payments', 'Payments')`;
    await owner`insert into repositories (id, workspace_id, github_installation_id, owner, name, default_branch) values
      (${repoId}, ${wsId}, ${"repolinks-install-" + suffix}, 'acme', 'payments-svc', 'main')`;
  });

  afterAll(async () => {
    await owner`delete from workspaces where id = ${wsId}`;
    await owner.end({ timeout: 5 });
  });

  const repo = { id: repoId, workspaceId: wsId };

  it("falls back to the workspace default product when the repo has no links", async () => {
    expect(await resolveRepoDefaultProduct(db, repo)).toBe(productId.def);
  });

  it("returns the linked product marked as default", async () => {
    await owner`insert into product_repositories (workspace_id, repo_id, product_id, is_default) values
      (${wsId}, ${repoId}, ${productId.payments}, true)`;
    expect(await resolveRepoDefaultProduct(db, repo)).toBe(productId.payments);
  });

  it("enforces at most one default per repo in the database", async () => {
    await expect(
      owner`insert into product_repositories (workspace_id, repo_id, product_id, is_default) values
        (${wsId}, ${repoId}, ${productId.def}, true)`,
    ).rejects.toThrow(/product_repositories_repo_default_uq/);
  });

  it("self-heals to the workspace default when the default product is deleted", async () => {
    // Deleting the product cascades its link row (and the default with it).
    await owner`delete from features where product_id = ${productId.payments}`;
    await owner`delete from products where id = ${productId.payments}`;
    expect(await resolveRepoDefaultProduct(db, repo)).toBe(productId.def);
  });
});
