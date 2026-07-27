import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb, eq, repositories, type Database } from "@specboards/db";

/**
 * Spec attachment + wrapper retirement (ADR 0003 D3), driven through a real
 * `syncRepository` against the in-memory GitHub fake, so this exercises the
 * actual sync loop rather than a stand-in.
 *
 * Covers: a spec whose frontmatter id names an existing work item attaches to
 * that row instead of creating a second one, preserving its status, assignee
 * and parent; a spec naming nothing still creates a work item; sync no longer
 * invents a Feature grouping for an import that matches none, leaving it
 * unparented; and an import DOES still home under a grouping that already
 * exists. A DB-native leaf item with no spec is untouched throughout.
 *
 * Needs a migrated Postgres at DATABASE_URL; skips itself when unset.
 */

const OWNER_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const ws = randomUUID();
const repoId = randomUUID();
const productId = randomUUID();
const userId = randomUUID();
const suffix = randomUUID().slice(0, 8);
const fixturePath = join(tmpdir(), `specboard-attach-${suffix}.json`);
const REPO_KEY = "acme/specs";

/** Write the fake repo's file set, replacing whatever was there. */
function seedRepo(files: Record<string, string>): void {
  writeFileSync(fixturePath, JSON.stringify({ [REPO_KEY]: files }, null, 2));
}

function specFile(id: string, title: string, feature?: string): string {
  const featureLine = feature ? `feature: ${feature}\n` : "";
  return `---\nid: ${id}\ntitle: ${JSON.stringify(title)}\nkind: feature\n${featureLine}---\n\n# ${title}\n\nBody.\n`;
}

describe.skipIf(!OWNER_URL)("spec attachment and sync grouping", () => {
  let owner: postgres.Sql;
  let db: Database;
  let syncRepository: typeof import("./github-sync").syncRepository;
  let repo: typeof repositories.$inferSelect;

  beforeAll(async () => {
    // The fake repo client stands in for GitHub only when the E2E seam is on
    // and the app is configured for localhost (see lib/e2e.ts).
    process.env.SPECBOARDS_E2E = "1";
    process.env.APP_URL = "http://localhost:3000";
    process.env.SPECBOARDS_E2E_GITHUB_FIXTURE = fixturePath;
    seedRepo({});
    ({ syncRepository } = await import("./github-sync"));

    owner = postgres(OWNER_URL!, { prepare: false, max: 2 });
    db = createDb(OWNER_URL!);
    await owner`insert into workspaces (id, name, slug) values
      (${ws}, 'Attach', ${"attach-int-" + suffix})`;
    await owner`insert into users (id, name, email) values
      (${userId}, 'Dev', ${`dev-${suffix}@attach.test`})`;
    await owner`insert into members (workspace_id, user_id, role) values
      (${ws}, ${userId}, 'owner')`;
    await owner`insert into products (id, workspace_id, key, name) values
      (${productId}, ${ws}, 'default', 'General')`;
    await owner`insert into repositories
      (id, workspace_id, github_installation_id, owner, name, default_branch) values
      (${repoId}, ${ws}, ${"attach-install-" + suffix}, 'acme', 'specs', 'main')`;
    await owner`insert into workspace_levels (workspace_id, key, label, position, is_leaf) values
      (${ws}, 'feature', 'Features', 0, false),
      (${ws}, 'work', 'Work Items', 1, true)`;

    // Read the repo back through drizzle: syncRepository takes the camelCased
    // RepoRecord, not the raw snake_case row.
    const [row] = await db
      .select()
      .from(repositories)
      .where(eq(repositories.id, repoId));
    repo = row!;
  });

  afterAll(async () => {
    await owner`delete from workspaces where id = ${ws}`;
    await owner`delete from users where id = ${userId}`;
    await owner.end({ timeout: 5 });
    delete process.env.SPECBOARDS_E2E;
    delete process.env.SPECBOARDS_E2E_GITHUB_FIXTURE;
  });

  it("attaches a spec to the work item whose id it carries", async () => {
    // A work item created in the app: no repo, no spec, but real metadata.
    const itemId = randomUUID();
    const specId = randomUUID();
    await owner`insert into features
      (id, workspace_id, product_id, spec_id, level, title, status, assignee_id)
      values (${itemId}, ${ws}, ${productId}, ${specId}, 'work',
              'Tracked first', 'in_progress', ${userId})`;

    seedRepo({ "specs/tracked/spec.md": specFile(specId, "Tracked first") });
    const summary = await syncRepository(db, repo);

    expect(summary.attached).toBe(1);
    // One row, not two: the spec joined the item rather than cloning it.
    const rows = await owner`select id, repo_id, status, assignee_id, level
      from features where workspace_id = ${ws} and spec_id = ${specId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(itemId);
    expect(rows[0]!.repo_id).toBe(repoId);
    // Planning metadata is the item's and survives the attachment (ADR 0003 D1).
    expect(rows[0]!.status).toBe("in_progress");
    expect(rows[0]!.assignee_id).toBe(userId);

    const index = await owner`select path from spec_index where feature_id = ${itemId}`;
    expect(index[0]!.path).toBe("specs/tracked/spec.md");
  });

  it("creates a work item for a spec that names no existing item", async () => {
    const specId = randomUUID();
    seedRepo({ "specs/brand-new/spec.md": specFile(specId, "Brand new") });
    await syncRepository(db, repo);

    const rows = await owner`select title, repo_id from features
      where workspace_id = ${ws} and spec_id = ${specId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe("Brand new");
  });

  it("does not invent a Feature grouping for an unmatched import", async () => {
    const specId = randomUUID();
    seedRepo({ "specs/lonely/spec.md": specFile(specId, "Lonely") });
    const summary = await syncRepository(db, repo);

    expect(summary.unparented).toBeGreaterThanOrEqual(1);
    const rows = await owner`select parent_id, synced_feature_key from features
      where workspace_id = ${ws} and spec_id = ${specId}`;
    // Unparented, waiting in the Unassigned view rather than under a wrapper.
    expect(rows[0]!.parent_id).toBeNull();
    // The key is still recorded, so creating that grouping later is not read as
    // a frontmatter change.
    expect(rows[0]!.synced_feature_key).toBe("path:specs/lonely");

    // No grouping row was created for the folder key.
    const groupings = await owner`select id from features
      where workspace_id = ${ws} and level = 'feature'
        and external_key = ${"path:specs/lonely"}`;
    expect(groupings).toHaveLength(0);
  });

  it("still homes an import under a grouping that already exists", async () => {
    const groupingId = randomUUID();
    await owner`insert into features
      (id, workspace_id, product_id, spec_id, level, title, external_key)
      values (${groupingId}, ${ws}, ${productId}, ${groupingId}, 'feature',
              'Checkout', 'feature:checkout')`;

    const specId = randomUUID();
    seedRepo({
      "specs/pay/spec.md": specFile(specId, "Pay", "checkout"),
    });
    await syncRepository(db, repo);

    const rows = await owner`select parent_id, parent_set_by from features
      where workspace_id = ${ws} and spec_id = ${specId}`;
    expect(rows[0]!.parent_id).toBe(groupingId);
    expect(rows[0]!.parent_set_by).toBe("system");
  });

  it("leaves a spec-less work item untouched across a re-sync", async () => {
    const itemId = randomUUID();
    const specId = randomUUID();
    await owner`insert into features
      (id, workspace_id, product_id, spec_id, level, title, status)
      values (${itemId}, ${ws}, ${productId}, ${specId}, 'work',
              'Human only', 'in_progress')`;

    seedRepo({ "specs/unrelated/spec.md": specFile(randomUUID(), "Unrelated") });
    await syncRepository(db, repo);

    const rows = await owner`select repo_id, status, title, parent_id
      from features where id = ${itemId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.repo_id).toBeNull();
    expect(rows[0]!.status).toBe("in_progress");
    expect(rows[0]!.title).toBe("Human only");
    expect(rows[0]!.parent_id).toBeNull();
    // Still has no spec, so it is still the item's own to rename and delete.
    const index = await owner`select 1 from spec_index where feature_id = ${itemId}`;
    expect(index).toHaveLength(0);
  });
});
