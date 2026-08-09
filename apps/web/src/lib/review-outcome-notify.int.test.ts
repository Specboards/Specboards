import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb, type Database } from "@specboards/db";

import { notifyReviewOutcome } from "./review-outcome-notify";

/**
 * Raising an inbox notification when a proposed spec change is resolved.
 *
 * The author asked for the review through Specboards and will not go looking
 * for the answer on GitHub, so if this does not fire they are simply never
 * told. Two rules matter beyond "a row appeared":
 *
 * - only proposals opened through the app are announced. A pull request
 *   somebody hand-linked to a card belongs to whoever opened it on GitHub, who
 *   is already being told by GitHub, and claiming it as "your change" would be
 *   telling the wrong person about work they did not do.
 * - the same pull request can be linked from more than one workspace, and each
 *   of those authors is a separate person to tell.
 *
 * Pull request numbers here are deliberately high and suite-specific: the
 * lookup spans workspaces by design, so a number another suite also uses would
 * make this test read its rows.
 *
 * Needs a migrated Postgres at DATABASE_URL; skips itself when unset.
 */

const OWNER_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const wsId = randomUUID();
const otherWsId = randomUUID();
const productId = randomUUID();
const otherProductId = randomUUID();
const repoId = randomUUID();
const otherRepoId = randomUUID();
const featureId = randomUUID();
const otherFeatureId = randomUUID();
const author = randomUUID();
const otherAuthor = randomUUID();
const suffix = randomUUID().slice(0, 8);

const PR = { merged: 900_101, closed: 900_102, handLinked: 900_103, shared: 900_104, open: 900_105 };

function event(number: number, state: string, title: string | null = "Update the refund policy") {
  return { owner: "acme", name: "specs", kind: "pull_request" as const, number, state, title };
}

describe.skipIf(!OWNER_URL)("notifyReviewOutcome", () => {
  let owner: postgres.Sql;
  let db: Database;

  async function link(over: {
    number: number;
    state: string;
    authorId?: string | null;
    featureId?: string;
    workspaceId?: string;
    repoId?: string;
  }) {
    await owner`insert into feature_github_links
      (workspace_id, feature_id, repo_id, kind, number, url, title, state, head_branch, author_id)
      values (
        ${over.workspaceId ?? wsId}, ${over.featureId ?? featureId}, ${over.repoId ?? repoId},
        'pull_request', ${over.number},
        ${`https://github.com/acme/specs/pull/${over.number}-${over.workspaceId ?? wsId}`},
        'Update the refund policy', ${over.state},
        ${over.authorId === null ? null : `specboards/spec-${over.number}`},
        ${over.authorId === undefined ? author : over.authorId}
      )`;
  }

  async function inbox(recipient: string) {
    return owner`select type, snippet, comment_id, actor_id, feature_id
      from notifications where recipient_id = ${recipient} order by created_at`;
  }

  beforeAll(async () => {
    owner = postgres(OWNER_URL!, { prepare: false, max: 2 });
    db = createDb(OWNER_URL!);
    await owner`insert into workspaces (id, name, slug) values
      (${wsId}, 'Notify', ${"notify-int-" + suffix}),
      (${otherWsId}, 'Notify Two', ${"notify2-int-" + suffix})`;
    await owner`insert into products (id, workspace_id, key, name) values
      (${productId}, ${wsId}, 'default', 'General'),
      (${otherProductId}, ${otherWsId}, 'default', 'General')`;
    await owner`insert into repositories (id, workspace_id, github_installation_id, owner, name, default_branch) values
      (${repoId}, ${wsId}, ${"notify-install-" + suffix}, 'acme', 'specs', 'main'),
      (${otherRepoId}, ${otherWsId}, ${"notify2-install-" + suffix}, 'acme', 'specs', 'main')`;
    await owner`insert into workspace_levels (workspace_id, key, label, position, is_leaf) values
      (${wsId}, 'work', 'Work Items', 0, true),
      (${otherWsId}, 'work', 'Work Items', 0, true)`;
    await owner`insert into features (id, workspace_id, product_id, spec_id, title, level, status) values
      (${featureId}, ${wsId}, ${productId}, ${randomUUID()}, 'Refund policy', 'work', 'in_review'),
      (${otherFeatureId}, ${otherWsId}, ${otherProductId}, ${randomUUID()}, 'Refund policy', 'work', 'in_review')`;
  });

  afterAll(async () => {
    await owner`delete from workspaces where id in (${wsId}, ${otherWsId})`;
    await owner.end({ timeout: 5 });
  });

  it("tells the author their change is live", async () => {
    await link({ number: PR.merged, state: "merged" });
    expect(await notifyReviewOutcome(db, event(PR.merged, "merged"))).toBe(1);

    const rows = await inbox(author);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.type).toBe("spec_change_merged");
    expect(row.snippet).toContain("is now live");
    // No comment behind it, and no actor: an outcome is not something a person
    // did to the author.
    expect(row.comment_id).toBeNull();
    expect(row.actor_id).toBeNull();
    // Deep-links to the item, which is the whole point of telling them.
    expect(row.feature_id).toBe(featureId);
  });

  it("says out loud when a change was closed without merging", async () => {
    await link({ number: PR.closed, state: "closed" });
    expect(await notifyReviewOutcome(db, event(PR.closed, "closed"))).toBe(1);

    const rows = await inbox(author);
    const closed = rows.find((r) => r.type === "spec_change_closed");
    // The case that matters most: silence here leaves the author believing
    // their words are live when the document still says the old thing.
    expect(closed).toBeDefined();
    expect(closed!.snippet).toContain("closed without being merged");
  });

  it("says nothing about a pull request somebody linked by hand", async () => {
    await link({ number: PR.handLinked, state: "merged", authorId: null });
    expect(await notifyReviewOutcome(db, event(PR.handLinked, "merged"))).toBe(0);
  });

  it("says nothing while a review is still open", async () => {
    await link({ number: PR.open, state: "open" });
    expect(await notifyReviewOutcome(db, event(PR.open, "open"))).toBe(0);
  });

  it("tells every workspace's author, not just the first", async () => {
    await link({ number: PR.shared, state: "merged" });
    await link({
      number: PR.shared,
      state: "merged",
      workspaceId: otherWsId,
      featureId: otherFeatureId,
      repoId: otherRepoId,
      authorId: otherAuthor,
    });
    expect(await notifyReviewOutcome(db, event(PR.shared, "merged"))).toBe(2);
    expect(await inbox(otherAuthor)).toHaveLength(1);
  });
});
