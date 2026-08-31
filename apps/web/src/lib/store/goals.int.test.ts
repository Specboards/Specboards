import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DbStore } from "./db";
import { GoalError } from "./types";

/**
 * Goals integration suite: exercises goals, key results and the many-to-many
 * linkage against a migrated Postgres with RLS active, via a non-owner app role
 * (same provisioning as releases.int.test.ts).
 *
 * Covers the card's acceptance criteria: a goal links to items in more than one
 * product and a viewer sees only the linked items they can read while the goal
 * stays visible; deleting a feature removes its links and leaves the goal
 * intact; key-result progress is computed on read; a goal with no linked work
 * is valid; and the two progress figures (outcome vs delivery) stay separate.
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
const user = {
  owner: randomUUID(),
  contributor: randomUUID(),
  viewer: randomUUID(),
};
const product = { alpha: randomUUID(), beta: randomUUID() };
const suffix = randomUUID().slice(0, 8);

const asOwner = { userId: user.owner, workspaceId: ws };
const asContributor = { userId: user.contributor, workspaceId: ws };
const asViewer = { userId: user.viewer, workspaceId: ws };

describe.skipIf(!OWNER_URL)(
  "goals, key results and linkage (store + RLS)",
  () => {
    let owner: postgres.Sql;
    let store: DbStore;

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
      (${ws}, 'Goals', ${"goal-int-" + suffix})`;
      await owner`insert into users (id, name, email) values
      (${user.owner}, 'Owner', ${`owner-${suffix}@goal.test`}),
      (${user.contributor}, 'Contributor', ${`contrib-${suffix}@goal.test`}),
      (${user.viewer}, 'Viewer', ${`viewer-${suffix}@goal.test`})`;
      await owner`insert into members (workspace_id, user_id, role) values
      (${ws}, ${user.owner}, 'owner'),
      (${ws}, ${user.contributor}, 'member'),
      (${ws}, ${user.viewer}, 'member')`;
      // Both products are private, so a member sees only what they are granted.
      await owner`insert into products (id, workspace_id, key, name, visibility) values
      (${product.alpha}, ${ws}, 'alpha', 'Alpha', 'private'),
      (${product.beta}, ${ws}, 'beta', 'Beta', 'private')`;
      await owner`insert into product_members (workspace_id, product_id, user_id, role) values
      (${ws}, ${product.alpha}, ${user.contributor}, 'contributor'),
      (${ws}, ${product.alpha}, ${user.viewer}, 'viewer')`;
      await owner`insert into workspace_levels (workspace_id, key, label, position, is_leaf) values
      (${ws}, 'epic', 'Epics', 0, false),
      (${ws}, 'story', 'Stories', 1, true)`;

      store = new DbStore(appUrlFrom(OWNER_URL!));
    });

    afterAll(async () => {
      await owner`delete from workspaces where id = ${ws}`;
      await owner`delete from users where id in
      (${user.owner}, ${user.contributor}, ${user.viewer})`;
      await owner.end({ timeout: 5 });
    });

    it("creates a goal with no key results and reads as unmeasured, not 0%", async () => {
      const goal = await store.createGoal(
        { title: "Bare objective", productId: product.alpha },
        asOwner,
      );
      // A goal written before it is made measurable is a valid, useful state.
      expect(goal.progress).toBeNull();
      expect(goal.deliveryProgress).toBeNull();
      expect(goal.keyResults).toEqual([]);
      expect(goal.status).toBe("on_track");
    });

    it("computes key-result progress from start/current/target on read", async () => {
      const goal = await store.createGoal(
        { title: "Measured", productId: product.alpha },
        asOwner,
      );
      // Distance travelled, not distance to target: 40 of a 40→60 span is 0%.
      let updated = await store.createKeyResult(
        goal.id,
        { title: "Actives", startValue: 40, targetValue: 60, currentValue: 40 },
        asOwner,
      );
      expect(updated.keyResults[0]!.progress).toBe(0);
      expect(updated.progress).toBe(0);

      const krId = updated.keyResults[0]!.id;
      updated = await store.updateKeyResult(
        krId,
        { currentValue: 50 },
        asOwner,
      );
      expect(updated.keyResults[0]!.progress).toBe(50);
      expect(updated.progress).toBe(50);

      // Nothing is persisted: re-reading recomputes from the same inputs.
      const listed = (await store.listGoals(asOwner)).find(
        (g) => g.id === goal.id,
      );
      expect(listed!.progress).toBe(50);
    });

    it("rejects a key result whose target equals its start", async () => {
      const goal = await store.createGoal(
        { title: "Degenerate", productId: product.alpha },
        asOwner,
      );
      await expect(
        store.createKeyResult(
          goal.id,
          { title: "Nowhere", startValue: 5, targetValue: 5 },
          asOwner,
        ),
      ).rejects.toThrow(/must differ/);
    });

    it("refuses a patch that would leave start equal to target", async () => {
      // The create path has always rejected a degenerate span. The patch path
      // matters more now that the UI can edit these fields rather than only the
      // current value: the check lives in the store, which validates the measure
      // as it WILL be rather than the patch in isolation, so changing one side to
      // collide with the other is caught even though neither field is wrong
      // on its own.
      const goal = await store.createGoal(
        { title: "Editable", productId: product.alpha },
        asOwner,
      );
      const created = await store.createKeyResult(
        goal.id,
        { title: "Actives", startValue: 10, targetValue: 20 },
        asOwner,
      );
      const krId = created.keyResults[0]!.id;

      await expect(
        store.updateKeyResult(krId, { targetValue: 10 }, asOwner),
      ).rejects.toThrow(/must differ/);
      await expect(
        store.updateKeyResult(krId, { startValue: 20 }, asOwner),
      ).rejects.toThrow(/must differ/);

      // The original is untouched, so a refused edit does not half-apply.
      const after = (await store.listGoals(asOwner)).find(
        (g) => g.id === goal.id,
      );
      expect(after!.keyResults[0]!.startValue).toBe(10);
      expect(after!.keyResults[0]!.targetValue).toBe(20);

      // Switching to yes-no is allowed to collapse the span, because that kind
      // is exempt: its progress does not come from the distance.
      const asBoolean = await store.updateKeyResult(
        krId,
        { metricKind: "boolean", startValue: 0, targetValue: 1 },
        asOwner,
      );
      expect(asBoolean.keyResults[0]!.metricKind).toBe("boolean");
    });

    it("reads key results in position order, not insertion order", async () => {
      // `position` is assigned on insert and was read by nothing: both goal
      // queries selected key results with no ORDER BY, so display order was
      // whatever Postgres returned. Unstable, not merely arbitrary, since a row
      // can relocate on UPDATE: checking in one number could reshuffle the list
      // under the person doing it.
      //
      // Asserting that insertion order comes back is NOT a test of this: an
      // unordered scan over a handful of rows returns insertion order by luck,
      // and that version of this test duly passed against the unfixed code. So
      // the positions below are set to DISAGREE with insertion order, which is
      // the actual contract: `position` decides, not arrival.
      //
      // Worth knowing what this can and cannot promise. It pins the contract, and
      // it fails whenever the read returns a different order. It is not a
      // reliable reproduction of the bug, because the unfixed behaviour is
      // *nondeterministic* rather than wrong-in-a-fixed-way: with an unordered
      // query the answer depends on heap layout, and this row count happens to
      // come back correct fairly often. That unpredictability is the bug, not a
      // weakness of the test.
      const goal = await store.createGoal(
        { title: "Ordered measures", productId: product.alpha },
        asOwner,
      );
      const inserted = ["Alpha", "Bravo", "Charlie"];
      let created = goal;
      for (const title of inserted) {
        created = await store.createKeyResult(
          goal.id,
          { title, startValue: 0, targetValue: 100 },
          asOwner,
        );
      }
      expect(created.keyResults).toHaveLength(3);

      // Reverse the positions. Insertion order is now the wrong answer.
      const byTitle = new Map(created.keyResults.map((k) => [k.title, k.id]));
      await store.updateKeyResult(
        byTitle.get("Alpha")!,
        { position: 2 },
        asOwner,
      );
      await store.updateKeyResult(
        byTitle.get("Bravo")!,
        { position: 1 },
        asOwner,
      );
      const reordered = await store.updateKeyResult(
        byTitle.get("Charlie")!,
        { position: 0 },
        asOwner,
      );

      const expected = ["Charlie", "Bravo", "Alpha"];
      // hydrateGoal, the read behind an individual goal.
      expect(reordered.keyResults.map((k) => k.title)).toEqual(expected);

      // listGoals is the Goals page and reads key results with its own query, so
      // it needs asserting separately: fixing one and not the other would leave
      // the two surfaces disagreeing about the same goal.
      const listed = (await store.listGoals(asOwner)).find(
        (g) => g.id === goal.id,
      );
      expect(listed!.keyResults.map((k) => k.title)).toEqual(expected);

      // And a plain check-in still does not disturb that order.
      const afterCheckIn = await store.updateKeyResult(
        byTitle.get("Bravo")!,
        { currentValue: 42 },
        asOwner,
      );
      expect(afterCheckIn.keyResults.map((k) => k.title)).toEqual(expected);
    });

    it("averages several key results for the goal's progress", async () => {
      const goal = await store.createGoal(
        { title: "Two measures", productId: product.alpha },
        asOwner,
      );
      await store.createKeyResult(
        goal.id,
        { title: "Done", startValue: 0, targetValue: 100, currentValue: 100 },
        asOwner,
      );
      const updated = await store.createKeyResult(
        goal.id,
        {
          title: "Untouched",
          startValue: 0,
          targetValue: 100,
          currentValue: 0,
        },
        asOwner,
      );
      expect(updated.progress).toBe(50);
    });

    it("links work across products and keeps outcome and delivery separate", async () => {
      const goal = await store.createGoal(
        // Org-wide, so it can be served by both products' work.
        { title: "Cross-product", productId: null },
        asOwner,
      );
      await store.createKeyResult(
        goal.id,
        { title: "Metric", startValue: 0, targetValue: 100, currentValue: 0 },
        asOwner,
      );
      const alphaItem = await store.createFeature(
        { title: "Alpha work", level: "epic", productId: product.alpha },
        asOwner,
      );
      const betaItem = await store.createFeature(
        { title: "Beta work", level: "epic", productId: product.beta },
        asOwner,
      );
      await store.linkGoal(goal.id, alphaItem.specId, asOwner);
      await store.linkGoal(goal.id, betaItem.specId, asOwner);
      await store.updateFeature(alphaItem.specId, { status: "done" }, asOwner);
      await store.updateFeature(betaItem.specId, { status: "done" }, asOwner);

      const listed = (await store.listGoals(asOwner)).find(
        (g) => g.id === goal.id,
      );
      expect(listed!.linkedItemCount).toBe(2);
      // All the work shipped...
      expect(listed!.deliveryProgress).toBe(100);
      // ...and the metric did not move. This is the whole reason the two numbers
      // are never averaged into one.
      expect(listed!.progress).toBe(0);
    });

    it("is a no-op when the same link is made twice", async () => {
      const goal = await store.createGoal(
        { title: "Idempotent", productId: product.alpha },
        asOwner,
      );
      const item = await store.createFeature(
        { title: "Once", level: "epic", productId: product.alpha },
        asOwner,
      );
      await store.linkGoal(goal.id, item.specId, asOwner);
      await store.linkGoal(goal.id, item.specId, asOwner);
      expect(await store.listGoalContributions(goal.id, asOwner)).toHaveLength(
        1,
      );
    });

    it("shows a viewer the goal but only the linked work they can read", async () => {
      const goal = await store.createGoal(
        { title: "Partially visible", productId: null },
        asOwner,
      );
      const alphaItem = await store.createFeature(
        { title: "Visible to viewer", level: "epic", productId: product.alpha },
        asOwner,
      );
      const betaItem = await store.createFeature(
        { title: "Hidden from viewer", level: "epic", productId: product.beta },
        asOwner,
      );
      await store.linkGoal(goal.id, alphaItem.specId, asOwner);
      await store.linkGoal(goal.id, betaItem.specId, asOwner);

      // The owner sees both.
      expect(await store.listGoalContributions(goal.id, asOwner)).toHaveLength(
        2,
      );

      // The viewer has a grant on Alpha only. The goal itself stays visible:
      // hiding it because one contributor is out of reach would make org-wide
      // goals invisible to almost everyone.
      const asSeenByViewer = (await store.listGoals(asViewer)).find(
        (g) => g.id === goal.id,
      );
      expect(asSeenByViewer).toBeDefined();
      const visible = await store.listGoalContributions(goal.id, asViewer);
      expect(visible.map((c) => c.title)).toEqual(["Visible to viewer"]);
      // ...and its delivery figure is computed over the readable set only, so it
      // never advertises progress from work the caller cannot see.
      expect(asSeenByViewer!.linkedItemCount).toBe(1);
    });

    it("returns the whole link graph in one call, filtered the same way", async () => {
      // The roadmap's goal swimlanes need every edge at once; it must obey the
      // same visibility rule as the per-goal read, or a lane would draw work the
      // caller is not allowed to see.
      const alphaGoal = await store.createGoal(
        { title: "Graph alpha", productId: product.alpha },
        asOwner,
      );
      const orgGoal = await store.createGoal(
        { title: "Graph org-wide", productId: null },
        asOwner,
      );
      const alphaItem = await store.createFeature(
        { title: "Graph readable", level: "epic", productId: product.alpha },
        asOwner,
      );
      const betaItem = await store.createFeature(
        { title: "Graph unreadable", level: "epic", productId: product.beta },
        asOwner,
      );
      // One item serving two goals: the many-to-many case the swimlanes rest on.
      await store.linkGoal(alphaGoal.id, alphaItem.specId, asOwner);
      await store.linkGoal(orgGoal.id, alphaItem.specId, asOwner);
      await store.linkGoal(orgGoal.id, betaItem.specId, asOwner);

      const forOwner = (await store.listGoalLinks(asOwner)).filter((l) =>
        [alphaGoal.id, orgGoal.id].includes(l.goalId),
      );
      expect(forOwner).toHaveLength(3);
      expect(
        forOwner
          .filter((l) => l.specId === alphaItem.specId)
          .map((l) => l.goalId)
          .sort(),
      ).toEqual([alphaGoal.id, orgGoal.id].sort());

      // The viewer has a grant on Alpha only, so the Beta edge is gone.
      const forViewer = (await store.listGoalLinks(asViewer)).filter((l) =>
        [alphaGoal.id, orgGoal.id].includes(l.goalId),
      );
      expect(forViewer).toHaveLength(2);
      expect(forViewer.every((l) => l.specId === alphaItem.specId)).toBe(true);
    });

    it("removes a deleted feature's links and leaves the goal intact", async () => {
      const goal = await store.createGoal(
        { title: "Survives", productId: product.alpha },
        asOwner,
      );
      const item = await store.createFeature(
        { title: "Doomed", level: "epic", productId: product.alpha },
        asOwner,
      );
      await store.linkGoal(goal.id, item.specId, asOwner);
      expect(await store.listGoalContributions(goal.id, asOwner)).toHaveLength(
        1,
      );

      await store.deleteFeature(item.specId, asOwner);

      const listed = (await store.listGoals(asOwner)).find(
        (g) => g.id === goal.id,
      );
      expect(listed).toBeDefined();
      expect(listed!.linkedItemCount).toBe(0);
      expect(await store.listGoalContributions(goal.id, asOwner)).toHaveLength(
        0,
      );
    });

    it("reports an item's goals from any level, many-to-many", async () => {
      const goalA = await store.createGoal(
        { title: "Goal A", productId: product.alpha },
        asOwner,
      );
      const goalB = await store.createGoal(
        { title: "Goal B", productId: product.alpha },
        asOwner,
      );
      const item = await store.createFeature(
        { title: "Serves two", level: "epic", productId: product.alpha },
        asOwner,
      );
      await store.linkGoal(goalA.id, item.specId, asOwner);
      await store.linkGoal(goalB.id, item.specId, asOwner);

      const goals = await store.listItemGoals(item.specId, asOwner);
      expect(goals.map((g) => g.title).sort()).toEqual(["Goal A", "Goal B"]);
    });

    it("makes org-wide goals owner-only and product goals product-scoped", async () => {
      await expect(
        store.createGoal({ title: "Nope", productId: null }, asContributor),
      ).rejects.toThrow(/Only the workspace owner/);
      // The contributor can manage Alpha's goals...
      const mine = await store.createGoal(
        { title: "Contributor goal", productId: product.alpha },
        asContributor,
      );
      expect(mine.productId).toBe(product.alpha);
      // ...but not Beta's, and a viewer cannot write at all.
      await expect(
        store.createGoal(
          { title: "Not mine", productId: product.beta },
          asContributor,
        ),
      ).rejects.toThrow(GoalError);
      await expect(
        store.updateGoal(mine.id, { title: "Renamed" }, asViewer),
      ).rejects.toThrow(GoalError);
    });

    it("rejects a period that ends before it starts, including on a partial patch", async () => {
      await expect(
        store.createGoal(
          {
            title: "Backwards",
            productId: product.alpha,
            periodStart: "2026-12-31",
            periodEnd: "2026-01-01",
          },
          asOwner,
        ),
      ).rejects.toThrow(/cannot end before it starts/);

      const goal = await store.createGoal(
        {
          title: "Movable",
          productId: product.alpha,
          periodStart: "2026-01-01",
          periodEnd: "2026-03-31",
        },
        asOwner,
      );
      // Moving only the start, past the stored end.
      await expect(
        store.updateGoal(goal.id, { periodStart: "2026-06-01" }, asOwner),
      ).rejects.toThrow(/cannot end before it starts/);
    });

    it("nests goals but refuses a cycle", async () => {
      const parent = await store.createGoal(
        { title: "Company objective", productId: product.alpha },
        asOwner,
      );
      const child = await store.createGoal(
        {
          title: "Product objective",
          productId: product.alpha,
          parentGoalId: parent.id,
        },
        asOwner,
      );
      expect(child.parentGoalId).toBe(parent.id);

      await expect(
        store.updateGoal(parent.id, { parentGoalId: child.id }, asOwner),
      ).rejects.toThrow(/cannot be nested under itself/);
      await expect(
        store.updateGoal(parent.id, { parentGoalId: parent.id }, asOwner),
      ).rejects.toThrow(/cannot be nested under itself/);
    });

    it("orphans child goals to the root rather than deleting them", async () => {
      const parent = await store.createGoal(
        { title: "Parent to delete", productId: product.alpha },
        asOwner,
      );
      const child = await store.createGoal(
        {
          title: "Orphan me",
          productId: product.alpha,
          parentGoalId: parent.id,
        },
        asOwner,
      );
      await store.deleteGoal(parent.id, asOwner);

      const listed = (await store.listGoals(asOwner)).find(
        (g) => g.id === child.id,
      );
      expect(listed).toBeDefined();
      expect(listed!.parentGoalId).toBeNull();
    });
  },
);
