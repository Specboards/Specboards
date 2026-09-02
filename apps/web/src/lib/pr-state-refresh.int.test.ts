import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb, type Database } from "@specboards/db";

import { selectStaleLinkedPullRequests } from "./pr-state-refresh";

/**
 * Which pending spec changes are due a re-check against GitHub.
 *
 * The webhook is the mechanism that keeps pull request state current; this
 * query only exists for the case where a delivery never arrived. So its job is
 * narrow and its failure modes are both real:
 *
 * - too eager, and every item view spends GitHub rate limit re-asking about
 *   pull requests that cannot have moved, or re-asking far more often than
 *   anyone would notice the answer changing
 * - too shy, and an author is left being told their change is still in review
 *   long after it merged, which is the exact confusion the authoring work is
 *   there to remove
 *
 * `now` is a parameter rather than the clock so staleness can be asserted
 * without sleeping.
 *
 * Needs a migrated Postgres at DATABASE_URL; skips itself when unset.
 */

const OWNER_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const wsId = randomUUID();
const repoId = randomUUID();
const productId = randomUUID();
const featureId = randomUUID();
const otherFeatureId = randomUUID();
const suffix = randomUUID().slice(0, 8);
const specId = randomUUID();
const otherSpecId = randomUUID();

const NOW = new Date("2026-08-08T12:00:00.000Z");
/** Comfortably past the 15 minute staleness threshold. */
const LONG_AGO = new Date("2026-08-08T10:00:00.000Z");
/** Inside it. */
const JUST_NOW = new Date("2026-08-08T11:56:00.000Z");

describe.skipIf(!OWNER_URL)("selectStaleLinkedPullRequests", () => {
  let owner: postgres.Sql;
  let db: Database;

  /** Insert a link and return its id. Defaults describe an eligible one. */
  async function link(over: {
    number: number;
    state?: string | null;
    headBranch?: string | null;
    checkedAt?: Date | null;
    featureId?: string;
  }): Promise<string> {
    const id = randomUUID();
    await owner`insert into feature_github_links
      (id, workspace_id, feature_id, repo_id, kind, number, url, title, state, head_branch, state_checked_at)
      values (
        ${id}, ${wsId}, ${over.featureId ?? featureId}, ${repoId}, 'pull_request',
        ${over.number}, ${`https://github.com/acme/specs/pull/${over.number}`},
        'Proposed change', ${over.state === undefined ? "open" : over.state},
        ${over.headBranch === undefined ? `specboards/spec-${over.number}` : over.headBranch},
        ${over.checkedAt === undefined ? null : over.checkedAt}
      )`;
    return id;
  }

  async function selected(): Promise<number[]> {
    const rows = await selectStaleLinkedPullRequests(db, specId, wsId, NOW);
    return rows.map((r) => r.number!).sort((a, b) => a - b);
  }

  beforeAll(async () => {
    owner = postgres(OWNER_URL!, { prepare: false, max: 2 });
    db = createDb(OWNER_URL!);
    await owner`insert into workspaces (id, name, slug) values
      (${wsId}, 'PR Refresh', ${"prrefresh-int-" + suffix})`;
    await owner`insert into products (id, workspace_id, key, name) values
      (${productId}, ${wsId}, 'default', 'General')`;
    await owner`insert into repositories (id, workspace_id, github_installation_id, owner, name, default_branch) values
      (${repoId}, ${wsId}, ${"prrefresh-install-" + suffix}, 'acme', 'specs', 'main')`;
    // features.level carries a composite FK to workspace_levels.
    await owner`insert into workspace_levels (workspace_id, key, label, position, is_leaf) values
      (${wsId}, 'work', 'Work Items', 0, true)`;
    await owner`insert into features (id, workspace_id, product_id, spec_id, title, level, status) values
      (${featureId}, ${wsId}, ${productId}, ${specId}, 'Item under test', 'work', 'in_progress'),
      (${otherFeatureId}, ${wsId}, ${productId}, ${otherSpecId}, 'Another item', 'work', 'in_progress')`;
  });

  afterAll(async () => {
    await owner`delete from workspaces where id = ${wsId}`;
    await owner.end({ timeout: 5 });
  });

  it("selects an open spec change that has never been confirmed", async () => {
    await link({ number: 1 });
    expect(await selected()).toEqual([1]);
  });

  it("leaves a recently confirmed change alone", async () => {
    await link({ number: 2, checkedAt: JUST_NOW });
    // Still just #1: a working webhook stamps this constantly, and re-asking
    // would make the reconcile cost something on every healthy installation.
    expect(await selected()).toEqual([1]);
  });

  it("selects one whose confirmation has gone stale", async () => {
    await link({ number: 3, checkedAt: LONG_AGO });
    expect(await selected()).toEqual([1, 3]);
  });

  it("selects a pull request somebody linked by hand", async () => {
    // No head branch means Specboards did not open this one for a spec edit.
    // It is still selected, because linking it cached its state and the item
    // view and `list_github_links` both display that state. Having made the
    // claim, we have to keep it true; the alternative is showing a merged
    // change as still in review, which is the failure this file exists to
    // prevent and does not care how the link got there.
    await link({ number: 4, headBranch: null });
    expect(await selected()).toEqual([1, 3, 4]);
  });

  it("ignores reviews that are already finished", async () => {
    await link({ number: 5, state: "merged" });
    await link({ number: 6, state: "closed" });
    expect(await selected()).toEqual([1, 3, 4]);
  });

  it("ignores links belonging to a different item", async () => {
    await link({ number: 7, featureId: otherFeatureId });
    expect(await selected()).toEqual([1, 3, 4]);
  });

  it("caps how many one view will re-check", async () => {
    await link({ number: 8 });
    await link({ number: 9 });
    await link({ number: 10 });
    // Six are now eligible. A page load must not turn into six sequential
    // GitHub calls; the rest are picked up on a later view.
    const rows = await selectStaleLinkedPullRequests(db, specId, wsId, NOW);
    expect(rows).toHaveLength(3);
  });
});
