import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DbStore } from "./db";

/**
 * The rest of Settings > Cards, per product: stages, stage gates, custom
 * properties, detail templates, built-in field visibility, and per-level
 * templates.
 *
 * Two things under test, and the second is why this cannot be a unit test.
 *
 * 1. Resolution. A product inherits the workspace default until it defines its
 *    own set, then owns it outright, and reverting means owning nothing again.
 *
 * 2. That the database refuses the wrong writer. Before migration 0065 every
 *    one of these tables carried a single `specboards_is_member` FOR ALL
 *    policy, so any member of the workspace could rewrite the board's stages as
 *    far as Postgres was concerned and only `authorizeOrgAdmin` stood in the
 *    way. The store here connects as a non-owner role, so RLS is live: the
 *    write tests fail if the `..._write` policies are missing or keyed wrongly,
 *    and the refusal tests fail if they are too permissive.
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
const ownerId = randomUUID();
const alphaAdminId = randomUUID();
const memberId = randomUUID();
const alpha = randomUUID();
const beta = randomUUID();
const suffix = randomUUID().slice(0, 8);

const asOwner = { userId: ownerId, workspaceId: ws };
const asAlphaAdmin = { userId: alphaAdminId, workspaceId: ws };
const asMember = { userId: memberId, workspaceId: ws };

const DEFAULT_STAGES = [
  { key: "backlog", label: "Backlog" },
  { key: "doing", label: "Doing" },
  { key: "done", label: "Done" },
];

describe.skipIf(!OWNER_URL)("per-product Cards settings (store)", () => {
  let owner: postgres.Sql;
  let store: DbStore;

  /** Put every scope back to inheriting, so each test starts from the same place. */
  async function resetToInherited() {
    await owner`delete from workspace_statuses where workspace_id = ${ws}`;
    await owner`delete from workspace_stage_gates where workspace_id = ${ws}`;
    await owner`delete from workspace_properties where workspace_id = ${ws}`;
    await owner`delete from detail_templates where workspace_id = ${ws}`;
    await owner`update product_settings set card_fields = null, level_templates = null
      where workspace_id = ${ws}`;
    await store.replaceStatuses(DEFAULT_STAGES, asOwner);
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
      (${ws}, 'Cards', ${"cards-int-" + suffix})`;
    await owner`insert into users (id, name, email) values
      (${ownerId}, 'Owner', ${`owner-${suffix}@c.test`}),
      (${alphaAdminId}, 'Alpha admin', ${`alpha-${suffix}@c.test`}),
      (${memberId}, 'Member', ${`member-${suffix}@c.test`})`;
    await owner`insert into members (workspace_id, user_id, role) values
      (${ws}, ${ownerId}, 'owner'),
      (${ws}, ${alphaAdminId}, 'member'),
      (${ws}, ${memberId}, 'member')`;
    await owner`insert into products (id, workspace_id, key, name) values
      (${alpha}, ${ws}, 'alpha', 'Alpha'),
      (${beta}, ${ws}, 'beta', 'Beta')`;
    await owner`insert into product_members (workspace_id, product_id, user_id, role)
      values (${ws}, ${alpha}, ${alphaAdminId}, 'admin')`;
    await owner`insert into product_settings (workspace_id, product_id, transition_mode)
      values (${ws}, null, 'flexible')`;
    await owner`insert into workspace_levels (workspace_id, key, label, position, is_leaf)
      values (${ws}, 'epic', 'Epic', 0, false), (${ws}, 'feature', 'Feature', 1, true)`;

    store = new DbStore(appUrlFrom(OWNER_URL!));
    await resetToInherited();
  });

  afterAll(async () => {
    await owner`delete from workspaces where id = ${ws}`;
    await owner`delete from users where id in
      (${ownerId}, ${alphaAdminId}, ${memberId})`;
    await owner.end({ timeout: 5 });
  });

  // ── Stages ──────────────────────────────────────────────────────────────

  describe("stages", () => {
    it("lets two products run different stage sets at once", async () => {
      await resetToInherited();
      await store.replaceStatuses(
        [
          { key: "backlog", label: "Backlog" },
          { key: "triage", label: "Triage" },
          { key: "shipped", label: "Shipped" },
        ],
        asOwner,
        alpha,
      );

      expect((await store.listStatuses(asOwner, alpha)).map((s) => s.key)).toEqual([
        "backlog",
        "triage",
        "shipped",
      ]);
      // Beta never opted out, so it still follows the workspace.
      expect((await store.listStatuses(asOwner, beta)).map((s) => s.key)).toEqual([
        "backlog",
        "doing",
        "done",
      ]);
    });

    it("unions the stages in view for a cross-product board", async () => {
      await resetToInherited();
      await store.replaceStatuses(
        [
          { key: "backlog", label: "Backlog" },
          { key: "triage", label: "Triage" },
          { key: "shipped", label: "Shipped" },
        ],
        asOwner,
        alpha,
      );

      const union = await store.listStatusesUnion(asOwner, [alpha, beta]);
      // The default's order is the spine; stages only Alpha defines follow it.
      // Nothing is dropped, which is the point: an item in "triage" must have a
      // column to sit in on a board that spans both products.
      expect(union.map((s) => s.key)).toEqual([
        "backlog",
        "doing",
        "done",
        "triage",
        "shipped",
      ]);
      expect(union.map((s) => s.position)).toEqual([0, 1, 2, 3, 4]);
    });

    it("re-homes only the edited product's items", async () => {
      await resetToInherited();
      const aItem = randomUUID();
      const bItem = randomUUID();
      await owner`insert into features
        (id, workspace_id, product_id, spec_id, level, title, status) values
        (${aItem}, ${ws}, ${alpha}, ${randomUUID()}, 'feature', 'A', 'doing'),
        (${bItem}, ${ws}, ${beta}, ${randomUUID()}, 'feature', 'B', 'doing')`;

      // Alpha drops "doing"; its item must move, Beta's must not.
      await store.replaceStatuses(
        [
          { key: "backlog", label: "Backlog" },
          { key: "done", label: "Done" },
        ],
        asOwner,
        alpha,
      );

      const [a] = await owner`select status from features where id = ${aItem}`;
      const [b] = await owner`select status from features where id = ${bItem}`;
      expect(a!.status).toBe("backlog");
      expect(b!.status).toBe("doing");
    });

    it("leaves an overriding product alone when the default changes", async () => {
      await resetToInherited();
      await store.replaceStatuses(
        [
          { key: "backlog", label: "Backlog" },
          { key: "doing", label: "Doing" },
        ],
        asOwner,
        alpha,
      );
      const item = randomUUID();
      await owner`insert into features
        (id, workspace_id, product_id, spec_id, level, title, status)
        values (${item}, ${ws}, ${alpha}, ${randomUUID()}, 'feature', 'A', 'doing')`;

      // The workspace drops "doing". Alpha still has it, so its item must not
      // be swept to a stage Alpha's own board would not show.
      await store.replaceStatuses(
        [
          { key: "backlog", label: "Backlog" },
          { key: "done", label: "Done" },
        ],
        asOwner,
      );

      const [row] = await owner`select status from features where id = ${item}`;
      expect(row!.status).toBe("doing");
    });

    it("reverts to inheriting when given an empty set", async () => {
      await resetToInherited();
      await store.replaceStatuses(
        [{ key: "solo", label: "Solo" }],
        asOwner,
        alpha,
      );
      expect((await store.listStatuses(asOwner, alpha)).map((s) => s.key)).toEqual([
        "solo",
      ]);

      await store.replaceStatuses([], asOwner, alpha);
      expect((await store.listStatuses(asOwner, alpha)).map((s) => s.key)).toEqual([
        "backlog",
        "doing",
        "done",
      ]);
    });

    it("lets a product admin edit their own product and refuses another", async () => {
      await resetToInherited();
      await expect(
        store.replaceStatuses(DEFAULT_STAGES, asAlphaAdmin, alpha),
      ).resolves.toBeTruthy();
      await expect(
        store.replaceStatuses(DEFAULT_STAGES, asAlphaAdmin, beta),
      ).rejects.toThrow();
      const rows = await owner`select 1 from workspace_statuses
        where workspace_id = ${ws} and product_id = ${beta}`;
      expect(rows.length).toBe(0);
    });

    it("refuses a plain member, who could rewrite these before 0065", async () => {
      await resetToInherited();
      await expect(
        store.replaceStatuses(DEFAULT_STAGES, asMember, alpha),
      ).rejects.toThrow();
      await expect(
        store.replaceStatuses([{ key: "x", label: "X" }], asMember),
      ).rejects.toThrow();
      // The default is untouched: the refusal is real, not just an error on the
      // way out after a partial write.
      expect((await store.listStatuses(asOwner)).map((s) => s.key)).toEqual([
        "backlog",
        "doing",
        "done",
      ]);
    });
  });

  // ── Stage gates ─────────────────────────────────────────────────────────

  describe("stage gates", () => {
    it("keeps two products' checklists apart", async () => {
      await resetToInherited();
      await store.replaceStageGates(
        [{ stageKey: "doing", label: "Workspace gate" }],
        asOwner,
      );
      await store.replaceStageGates(
        [{ stageKey: "doing", label: "Alpha gate" }],
        asOwner,
        alpha,
      );

      expect((await store.listStageGates(asOwner, alpha)).map((g) => g.label)).toEqual(
        ["Alpha gate"],
      );
      expect((await store.listStageGates(asOwner, beta)).map((g) => g.label)).toEqual(
        ["Workspace gate"],
      );
    });

    it("keeps completions attached across an edit that keeps the gate", async () => {
      await resetToInherited();
      const [gate] = await store.replaceStageGates(
        [{ stageKey: "doing", label: "Spec reviewed" }],
        asOwner,
        alpha,
      );
      const item = randomUUID();
      await owner`insert into features
        (id, workspace_id, product_id, spec_id, level, title, status)
        values (${item}, ${ws}, ${alpha}, ${randomUUID()}, 'feature', 'A', 'doing')`;
      await owner`insert into feature_gate_completions
        (workspace_id, feature_id, gate_id) values (${ws}, ${item}, ${gate!.id})`;

      // Rename the gate, keeping its id: the completion must survive, or a
      // product tightening its checklist would silently mark work as having
      // passed gates it never saw.
      await store.replaceStageGates(
        [{ id: gate!.id, stageKey: "doing", label: "Spec reviewed by PM" }],
        asOwner,
        alpha,
      );
      const rows = await owner`select 1 from feature_gate_completions
        where feature_id = ${item} and gate_id = ${gate!.id}`;
      expect(rows.length).toBe(1);
    });

    it("refuses a product admin on another product, and a member anywhere", async () => {
      await resetToInherited();
      await expect(
        store.replaceStageGates(
          [{ stageKey: "doing", label: "x" }],
          asAlphaAdmin,
          beta,
        ),
      ).rejects.toThrow();
      await expect(
        store.replaceStageGates(
          [{ stageKey: "doing", label: "x" }],
          asMember,
          alpha,
        ),
      ).rejects.toThrow();
    });
  });

  // ── Custom properties ───────────────────────────────────────────────────

  describe("custom properties", () => {
    it("lets two products carry different property sets", async () => {
      await resetToInherited();
      await store.createProperty({ label: "Shared", type: "text" }, asOwner);
      await store.createProperty(
        { label: "Alpha only", type: "text" },
        asOwner,
        alpha,
      );

      expect(
        (await store.listProperties(asOwner, undefined, alpha)).map((p) => p.label),
      ).toEqual(["Alpha only"]);
      expect(
        (await store.listProperties(asOwner, undefined, beta)).map((p) => p.label),
      ).toEqual(["Shared"]);
    });

    it("hides a de-scoped property's values without destroying them", async () => {
      await resetToInherited();
      const prop = await store.createProperty(
        { label: "Squad", type: "text" },
        asOwner,
      );
      const item = randomUUID();
      await owner`insert into features
        (id, workspace_id, product_id, spec_id, level, title, status, custom_fields)
        values (${item}, ${ws}, ${alpha}, ${randomUUID()}, 'feature', 'A', 'backlog',
          ${owner.json({ [prop.key]: "platform" })})`;

      // Alpha takes over its property set and does not include Squad.
      await store.createProperty({ label: "Risk", type: "text" }, asOwner, alpha);
      expect(
        (await store.listProperties(asOwner, undefined, alpha)).map((p) => p.label),
      ).toEqual(["Risk"]);

      // The value is still on the row, ready to light back up if the property
      // is re-added. An admin tidying a settings list must not destroy work.
      const [row] = await owner`select custom_fields from features where id = ${item}`;
      expect((row!.custom_fields as Record<string, unknown>)[prop.key]).toBe(
        "platform",
      );
    });

    it("refuses a product admin on another product, and a member anywhere", async () => {
      await resetToInherited();
      await expect(
        store.createProperty({ label: "x", type: "text" }, asAlphaAdmin, beta),
      ).rejects.toThrow();
      await expect(
        store.createProperty({ label: "x", type: "text" }, asMember, alpha),
      ).rejects.toThrow();
    });
  });

  // ── Detail templates ────────────────────────────────────────────────────

  describe("detail templates", () => {
    it("lets two products carry different templates, sharing a name", async () => {
      await resetToInherited();
      await store.createDetailTemplate(
        { name: "Spec", body: "workspace" },
        asOwner,
      );
      await store.createDetailTemplate(
        { name: "Spec", body: "alpha" },
        asOwner,
        alpha,
      );

      expect(
        (await store.listDetailTemplates(asOwner, alpha)).map((t) => t.body),
      ).toEqual(["alpha"]);
      expect(
        (await store.listDetailTemplates(asOwner, beta)).map((t) => t.body),
      ).toEqual(["workspace"]);
    });

    it("refuses a product admin on another product, and a member anywhere", async () => {
      await resetToInherited();
      await expect(
        store.createDetailTemplate({ name: "x", body: "" }, asAlphaAdmin, beta),
      ).rejects.toThrow();
      await expect(
        store.createDetailTemplate({ name: "x", body: "" }, asMember, alpha),
      ).rejects.toThrow();
    });
  });

  // ── Built-in field visibility and per-level templates ───────────────────

  describe("built-in field visibility", () => {
    it("lets two products show different fields at the same level", async () => {
      await resetToInherited();
      await store.updateLevelFields({ epic: ["assignee"] }, asOwner, alpha);

      const forAlpha = await store.listLevels(asOwner, alpha);
      const forBeta = await store.listLevels(asOwner, beta);
      expect(forAlpha.find((l) => l.key === "epic")?.fields).toEqual(["assignee"]);
      // Beta inherits, which for an unconfigured level is "every field".
      expect(forBeta.find((l) => l.key === "epic")?.fields).toBeNull();
    });

    it("leaves a level the product never mentioned inheriting", async () => {
      await resetToInherited();
      await store.updateLevelFields({ epic: ["assignee"] }, asOwner, alpha);

      // This is the rule that makes adding a level workspace-wide safe: the new
      // level is in nobody's override map, so it shows every field rather than
      // none, for customised and uncustomised products alike.
      const levels = await store.listLevels(asOwner, alpha);
      expect(levels.find((l) => l.key === "feature")?.fields).toBeNull();
    });

    it("patches rather than replaces the product's map", async () => {
      await resetToInherited();
      await store.updateLevelFields({ epic: ["assignee"] }, asOwner, alpha);
      await store.updateLevelFields({ feature: ["release"] }, asOwner, alpha);

      const levels = await store.listLevels(asOwner, alpha);
      expect(levels.find((l) => l.key === "epic")?.fields).toEqual(["assignee"]);
      expect(levels.find((l) => l.key === "feature")?.fields).toEqual(["release"]);
    });

    it("refuses a product admin on another product, and a member anywhere", async () => {
      await resetToInherited();
      await expect(
        store.updateLevelFields({ epic: [] }, asAlphaAdmin, beta),
      ).rejects.toThrow();
      await expect(
        store.updateLevelFields({ epic: [] }, asMember, alpha),
      ).rejects.toThrow();
    });
  });

  // ── The settings screen's inherited/overridden read ──────────────────────

  it("reports which settings a product has taken over", async () => {
    await resetToInherited();
    expect(await store.cardsOverrides(asOwner, beta)).toMatchObject({
      stages: false,
      stageGates: false,
      properties: false,
      detailTemplates: false,
      cardFields: false,
    });

    await store.replaceStatuses(DEFAULT_STAGES, asOwner, alpha);
    await store.updateLevelFields({ epic: ["assignee"] }, asOwner, alpha);

    // Alpha's stages match the workspace's exactly, and it is still an
    // override: it will not follow the default when that next changes.
    expect(await store.cardsOverrides(asOwner, alpha)).toMatchObject({
      stages: true,
      cardFields: true,
      properties: false,
    });

    // The workspace default inherits from nothing, so nothing is an override.
    expect(await store.cardsOverrides(asOwner, null)).toMatchObject({
      stages: false,
      cardFields: false,
    });
  });
});
