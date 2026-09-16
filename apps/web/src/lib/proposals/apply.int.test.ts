import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@specboards/db";

/**
 * Applying a proposal, against a migrated Postgres.
 *
 * AR-03 from the adversarial review of `v1.0.0..0c364b6`: `prepare` decides
 * the proposal is safe to apply, and the write happens in a later, separate
 * transaction. Anything that changes the target in between is invisible to
 * the write, so a person editing the same field has their edit silently
 * replaced. A git-backed spec never had the problem, because it carries a
 * blob sha down to its write; the database-backed targets had nothing.
 *
 * ── Why these drive prepare and apply by hand ─────────────────────────────
 * `applyProposal` calls both with no gap a test can reach into, and the real
 * gap is microseconds wide. The run-lifecycle tests learned this the hard
 * way: two callers fired at `Promise.all` overlapped so rarely that the suite
 * passed against a deliberately broken build. Splitting the call here is not
 * a workaround, it IS the race, held still: prepare, let somebody else write,
 * then apply. Deterministic, and it fails on every build that does not carry
 * the precondition into the write.
 *
 * Needs a migrated Postgres at DATABASE_URL; skips itself when unset.
 */

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const sfx = randomUUID().slice(0, 8);
const ws = randomUUID();
const owner = randomUUID();
const editor = randomUUID();
const product = randomUUID();
const releaseId = randomUUID();
/**
 * Every fixture proposal hangs off one finished run.
 *
 * `proposals_origin_source_ck` insists an `origin = 'run'` row names a run,
 * so there is no such thing as a runless run proposal to write here. Finished
 * rather than active, so it cannot collide with `agent_runs_one_active_uq`.
 */
const runId = randomUUID();

const asOwner = { userId: owner, workspaceId: ws };
/** A second person with the same rights, so a refusal is about the race. */
const asEditor = { userId: editor, workspaceId: ws };

const CARD_BODY = "The original description.";
const NOTES = "## 1.0\n\nThe original notes.";

describe.skipIf(!DB_URL)("applying a proposal", () => {
  let sql: postgres.Sql;
  let db: Database;
  let handlers: typeof import("./handlers");
  let service: typeof import("./service");
  let errors: typeof import("./errors");
  let store: typeof import("@/lib/store");
  let features: typeof import("@/lib/features-service");

  /** The DB-native card every test starts from. */
  let cardId: string;
  let cardSpecId: string;
  /** A spec-backed item, for the case that must keep merging. */
  let specBackedId: string;
  let specBackedSpecId: string;

  beforeAll(async () => {
    sql = postgres(DB_URL!, { prepare: false, max: 4 });
    const { createDb } = await import("@specboards/db");
    db = createDb(DB_URL!);
    handlers = await import("./handlers");
    service = await import("./service");
    errors = await import("./errors");
    store = await import("@/lib/store");
    features = await import("@/lib/features-service");

    await sql`insert into workspaces (id, name, slug) values
      (${ws}, 'Proposals', ${"prop-int-" + sfx})`;
    await sql`insert into users (id, name, email) values
      (${owner}, 'Owner', ${`owner-${sfx}@prop.test`}),
      (${editor}, 'Editor', ${`editor-${sfx}@prop.test`})`;
    await sql`insert into members (workspace_id, user_id, role) values
      (${ws}, ${owner}, 'owner'),
      (${ws}, ${editor}, 'member')`;
    await sql`insert into products (id, workspace_id, key, name, visibility)
      values (${product}, ${ws}, 'alpha', 'Alpha', 'org')`;
    await sql`insert into workspace_levels (workspace_id, key, label, position, is_leaf)
      values (${ws}, 'work', 'Work Items', 0, true)`;
    // The second person needs write access to the product, so a refusal below
    // is about the race and not about what they were allowed to do.
    await sql`insert into product_members (workspace_id, product_id, user_id, role)
      values (${ws}, ${product}, ${editor}, 'contributor')`;
    await sql`insert into agent_runs (id, workspace_id, product_id, target_type,
                                      target_id, agent_id, actor_type, trigger,
                                      status, finished_at)
      values (${runId}, ${ws}, ${product}, 'feature', ${randomUUID()},
              ${owner}, 'agent', 'assignment', 'succeeded', now())`;
    await sql`insert into releases (id, workspace_id, product_id, name, status,
                                    release_notes_mode, release_notes_body)
      values (${releaseId}, ${ws}, ${product}, ${"v1.0-" + sfx}, 'planned',
              'in_app', ${NOTES})`;

    cardId = randomUUID();
    cardSpecId = cardId;
    await sql`insert into features (id, workspace_id, product_id, spec_id, level,
                                    title, status, details)
      values (${cardId}, ${ws}, ${product}, ${cardSpecId}, 'work', 'A card',
              'backlog', ${CARD_BODY})`;

    specBackedId = randomUUID();
    specBackedSpecId = specBackedId;
    await sql`insert into features (id, workspace_id, product_id, spec_id, level,
                                    title, status)
      values (${specBackedId}, ${ws}, ${product}, ${specBackedSpecId}, 'work',
              'A spec', 'backlog')`;
    // A spec_index row is what makes an item spec-backed rather than a card.
    await sql`insert into spec_index (feature_id, path, blob_sha, content)
      values (${specBackedId}, ${`specs/${sfx}.md`}, 'deadbeef', ${CARD_BODY})`;
  });

  afterAll(async () => {
    await sql`delete from workspaces where id = ${ws}`;
    await sql`delete from users where id in (${owner}, ${editor})`;
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await sql`delete from proposals where workspace_id = ${ws}`;
    await sql`update features set details = ${CARD_BODY}, status = 'backlog',
                tags = '{}', assignee_id = null, release_id = null
              where id = ${cardId}`;
    await sql`update releases set release_notes_body = ${NOTES},
                release_notes_mode = 'in_app' where id = ${releaseId}`;
  });

  /** A proposal row, open, drafted against whatever is there now. */
  async function propose(
    kind: "spec_content" | "item_metadata",
    targetType: "feature" | "release",
    targetId: string,
    payload: unknown,
  ): Promise<import("./store").ProposalRow> {
    const id = randomUUID();
    await sql`insert into proposals
        (id, workspace_id, product_id, origin, run_id, actor_id, actor_type,
         kind, target_type, target_id, payload, base_version, status)
      values (${id}, ${ws}, ${product}, 'run', ${runId}, ${owner}, 'agent',
              ${kind}, ${targetType}, ${targetId},
              ${sql.json(payload as never)}, null, 'open')`;
    const { getProposal } = await import("./store");
    const row = await getProposal(db, asOwner, id);
    if (!row) throw new Error("the fixture proposal was not readable");
    return row;
  }

  describe("when the target moves between prepare and the write", () => {
    it("refuses a card body rather than replacing the newer text", async () => {
      const row = await propose("spec_content", "feature", cardId, {
        body: "What the agent proposed.",
      });
      const handler = handlers.handlerFor(row.kind);
      const prepared = await handler.prepare(db, asOwner, row);

      // Somebody else edits the same field, in the gap.
      await features.patchFeature(
        cardSpecId,
        { details: "What a person typed a moment ago." },
        asEditor,
      );

      await expect(
        handler.apply(db, asOwner, row, prepared),
      ).rejects.toBeInstanceOf(errors.ProposalStaleError);

      // The point of the whole exercise: their text is still there.
      const [after] = await sql<{ details: string }[]>`
        select details from features where id = ${cardId}`;
      expect(after!.details).toBe("What a person typed a moment ago.");
    });

    it("tells the reviewer what the card says now", async () => {
      const row = await propose("spec_content", "feature", cardId, {
        body: "What the agent proposed.",
      });
      const handler = handlers.handlerFor(row.kind);
      const prepared = await handler.prepare(db, asOwner, row);
      await features.patchFeature(
        cardSpecId,
        { details: "Newer text." },
        asEditor,
      );

      // Refusing without showing the new state moves the problem to the
      // reviewer, so the error carries it, as the prepare-time guard does.
      await expect(
        handler.apply(db, asOwner, row, prepared),
      ).rejects.toMatchObject({ currentBody: "Newer text." });
    });

    it("refuses item metadata rather than walking the board backwards", async () => {
      const row = await propose("item_metadata", "feature", cardId, {
        status: "ready",
      });
      const handler = handlers.handlerFor(row.kind);
      const prepared = await handler.prepare(db, asOwner, row);

      await features.patchFeature(cardSpecId, { status: "defining" }, asEditor);

      await expect(
        handler.apply(db, asOwner, row, prepared),
      ).rejects.toBeInstanceOf(errors.ProposalStaleError);

      const [after] = await sql<{ status: string }[]>`
        select status from features where id = ${cardId}`;
      expect(after!.status).toBe("defining");
    });

    it("refuses release notes rather than replacing the newer notes", async () => {
      const row = await propose("spec_content", "release", releaseId, {
        body: "## 1.0\n\nWhat the agent proposed.",
      });
      const handler = handlers.handlerFor(row.kind);
      const prepared = await handler.prepare(db, asOwner, row);

      const s = await store.getStore();
      await s.updateRelease(
        releaseId,
        { releaseNotesMode: "in_app", releaseNotesBody: "## 1.0\n\nHand written." },
        asEditor,
      );

      await expect(
        handler.apply(db, asOwner, row, prepared),
      ).rejects.toBeInstanceOf(errors.ProposalStaleError);

      const [after] = await sql<{ body: string }[]>`
        select release_notes_body as body from releases where id = ${releaseId}`;
      expect(after!.body).toBe("## 1.0\n\nHand written.");
    });
  });

  describe("when the change does not collide", () => {
    it("applies a tag change even though the assignee moved underneath it", async () => {
      // The precondition watches the fields being written and nothing else.
      // Watching the whole row would make this refuse, which is two people
      // not colliding being told that they did.
      const row = await propose("item_metadata", "feature", cardId, {
        tags: ["api"],
      });
      const handler = handlers.handlerFor(row.kind);
      const prepared = await handler.prepare(db, asOwner, row);

      await features.patchFeature(cardSpecId, { assigneeId: editor }, asEditor);

      await expect(
        handler.apply(db, asOwner, row, prepared),
      ).resolves.toBeDefined();

      const [after] = await sql<{ tags: string[]; assignee: string }[]>`
        select tags, assignee_id as assignee from features where id = ${cardId}`;
      expect(after!.tags).toContain("api");
      expect(after!.assignee).toBe(editor);
    });

    it("leaves a spec-backed item to merge, as it always did", async () => {
      // AR-03's fix must not reach the git path. A spec has no body column to
      // fingerprint and does not need one: `expectedBlobSha` is this same
      // guarantee further down its own write, and unlike a fingerprint it can
      // three-way merge a non-overlapping edit instead of refusing it.
      const row = await propose("spec_content", "feature", specBackedId, {
        body: "A rewritten spec.",
      });
      const handler = handlers.handlerFor(row.kind);
      const prepared = (await handler.prepare(db, asOwner, row)) as {
        expect?: string;
      };
      expect(prepared.expect).toBeUndefined();
    });
  });

  describe("with nobody else writing", () => {
    // The failure this guards against is the opposite of a race: a
    // fingerprint taken over one set of field names and re-checked against
    // another matches nothing, so every apply refuses and the feature is
    // dead. It is invisible until a proposal touches the field that does not
    // line up, so every field a proposal may carry is applied here.
    const CASES: [string, Record<string, unknown>][] = [
      ["status", { status: "defining" }],
      ["tags", { tags: ["api", "urgent"] }],
      ["assigneeId", { assigneeId: null }],
      ["releaseId", { releaseId: null }],
      ["cycleId", { cycleId: null }],
      ["parentSpecId", { parentSpecId: null }],
      ["customFields", { customFields: {} }],
      ["several at once", { status: "defining", tags: ["api"] }],
    ];

    for (const [name, payload] of CASES) {
      it(`applies a proposal over ${name}`, async () => {
        const row = await propose("item_metadata", "feature", cardId, payload);
        const decision = await service.applyProposal(db, asOwner, row.id);
        expect(decision.status).toBe("applied");
      });
    }

    it("applies a card body end to end", async () => {
      const row = await propose("spec_content", "feature", cardId, {
        body: "The applied body.",
      });
      const decision = await service.applyProposal(db, asOwner, row.id);
      expect(decision.status).toBe("applied");

      const [after] = await sql<{ details: string }[]>`
        select details from features where id = ${cardId}`;
      expect(after!.details).toBe("The applied body.");
    });

    it("applies release notes end to end", async () => {
      const row = await propose("spec_content", "release", releaseId, {
        body: "## 1.0\n\nThe applied notes.",
      });
      const decision = await service.applyProposal(db, asOwner, row.id);
      expect(decision.status).toBe("applied");

      const [after] = await sql<{ body: string }[]>`
        select release_notes_body as body from releases where id = ${releaseId}`;
      expect(after!.body).toBe("## 1.0\n\nThe applied notes.");
    });
  });

  it("leaves a refused proposal open for the reviewer to come back to", async () => {
    // The claim is released when the apply throws, which is what makes this a
    // race somebody can lose and retry rather than a proposal that dies.
    const row = await propose("spec_content", "feature", cardId, {
      body: "What the agent proposed.",
    });

    const handler = handlers.handlerFor(row.kind);
    const prepared = await handler.prepare(db, asOwner, row);
    await features.patchFeature(cardSpecId, { details: "Newer." }, asEditor);
    await expect(handler.apply(db, asOwner, row, prepared)).rejects.toThrow();

    // Through the service, so the claim/release path runs as it does in life.
    await sql`update features set details = ${CARD_BODY} where id = ${cardId}`;
    const decision = await service.applyProposal(db, asOwner, row.id);
    expect(decision.status).toBe("applied");
  });
});
