import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DbStore } from "@/lib/store/db";

/**
 * Which changes to an idea produce an email, and which stay silent.
 *
 * This is the volume control, and it is the difference between a feature people
 * value and one they filter. "Tell a submitter about every state change" taken
 * literally means a message every time a triager nudges a card: several a week
 * to somebody who suggested one thing.
 *
 * The rule implemented instead is that a message goes out when what the PUBLIC
 * PAGE says about the idea changes. These cases pin both halves of that: the
 * transitions that must speak, and the ones that must not.
 *
 * Asserted on the outbox rather than on sent mail. The row is what the relay
 * consumes, it is written in the same transaction as the change, and asserting
 * here separates "did we decide to tell them" from "did the mail go out",
 * which are different failures with different causes.
 *
 * Needs a migrated Postgres at DATABASE_URL; skips itself when unset.
 */

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const ws = randomUUID();
const user = randomUUID();
const shownProduct = randomUUID();
const secretProduct = randomUUID();
const suffix = randomUUID().slice(0, 8);

describe.skipIf(!DB_URL)("when a portal idea change is announced", () => {
  let sql: postgres.Sql;
  let store: DbStore;
  const scope = { workspaceId: ws, userId: user };

  /** The phrases emitted since the last reset, in order. */
  async function emitted(): Promise<string[]> {
    const rows = await sql<{ data: Record<string, unknown> }[]>`
      select data from outbox_events
        where workspace_id = ${ws} and type = 'portal_idea.state_changed'
        order by created_at`;
    return rows.map((r) => String(r.data.phrase));
  }

  /** A fresh idea in a known state, returning its id. */
  async function seedIdea(input: {
    status: string;
    visibility: string;
    productId?: string;
  }): Promise<string> {
    const id = randomUUID();
    await sql`insert into ideas
      (id, workspace_id, product_id, title, status, portal_visibility)
      values (${id}, ${ws}, ${input.productId ?? shownProduct},
              ${`Idea ${id.slice(0, 6)}`}, ${input.status}, ${input.visibility})`;
    return id;
  }

  beforeAll(async () => {
    sql = postgres(DB_URL!, { prepare: false, max: 2 });
    store = new DbStore(DB_URL!);

    await sql`insert into users (id, name, email)
      values (${user}, 'Admin', ${`admin-${suffix}@example.com`})`;
    await sql`insert into workspaces (id, name, slug)
      values (${ws}, 'Emit Co', ${`emit-${suffix}`})`;
    await sql`insert into members (workspace_id, user_id, role)
      values (${ws}, ${user}, 'owner')`;
    await sql`insert into products (id, workspace_id, key, name) values
      (${shownProduct}, ${ws}, ${`shown-${suffix}`}, 'Shown'),
      (${secretProduct}, ${ws}, ${`secret-${suffix}`}, 'Unannounced')`;
    await sql`insert into idea_statuses (workspace_id, key, label, position) values
      (${ws}, 'new', 'New', 0),
      (${ws}, 'planned', 'On the roadmap', 1),
      (${ws}, 'awaiting_legal', 'Awaiting legal review', 2),
      (${ws}, 'shipped', 'Shipped', 3)`;
    await sql`insert into idea_settings
        (workspace_id, portal_enabled, portal_idea_statuses)
      values (${ws}, true, array['planned', 'shipped'])`;
    await sql`insert into idea_portal_products (workspace_id, product_id)
      values (${ws}, ${shownProduct})`;
  });

  beforeEach(async () => {
    await sql`delete from outbox_events where workspace_id = ${ws}`;
    await sql`delete from ideas where workspace_id = ${ws}`;
  });

  afterAll(async () => {
    await sql`delete from outbox_events where workspace_id = ${ws}`;
    await sql`delete from ideas where workspace_id = ${ws}`;
    await sql`delete from idea_portal_products where workspace_id = ${ws}`;
    await sql`delete from idea_settings where workspace_id = ${ws}`;
    await sql`delete from idea_statuses where workspace_id = ${ws}`;
    await sql`delete from products where workspace_id = ${ws}`;
    await sql`delete from members where workspace_id = ${ws}`;
    await sql`delete from workspaces where id = ${ws}`;
    await sql`delete from users where id = ${user}`;
    await sql.end({ timeout: 5 });
  });

  it("announces a held submission being published", async () => {
    const id = await seedIdea({ status: "planned", visibility: "pending" });
    await store.updateIdea(id, { portalVisibility: "published" }, scope);
    expect(await emitted()).toEqual(["is now public on the ideas page"]);
  });

  it("announces a move between two published stages, by label", async () => {
    const id = await seedIdea({ status: "planned", visibility: "published" });
    await store.updateIdea(id, { status: "shipped" }, scope);
    // The workspace's own label, which is safe here and nowhere else: it is a
    // stage the admin chose to publish, so the portal already shows that exact
    // word on the idea's own page.
    expect(await emitted()).toEqual(["is now Shipped"]);
  });

  it("stays silent moving between two UNPUBLISHED stages", async () => {
    // The triage pass. Nothing the reader can see has changed, so nothing is
    // sent. This is the case that decides whether the feature is welcome.
    const id = await seedIdea({ status: "new", visibility: "published" });
    await store.updateIdea(id, { status: "awaiting_legal" }, scope);
    expect(await emitted()).toEqual([]);
  });

  it("stays silent when an idea is withdrawn from view", async () => {
    // Deliberately no "your idea was removed": it reads as a rejection notice
    // for what is usually a stage change, and it would link to a page the
    // reader can no longer open.
    const id = await seedIdea({ status: "planned", visibility: "published" });
    await store.updateIdea(id, { portalVisibility: "hidden" }, scope);
    expect(await emitted()).toEqual([]);
  });

  it("never puts an unpublished stage's label in the message", async () => {
    // Moving ONTO an unpublished stage is a withdrawal, so it is silent. The
    // assertion that matters is the negative one: `Awaiting legal review` is
    // the workspace's internal wording and must not reach a stranger's inbox.
    const id = await seedIdea({ status: "planned", visibility: "published" });
    await store.updateIdea(id, { status: "awaiting_legal" }, scope);
    const rows = await sql<{ data: unknown }[]>`
      select data from outbox_events
        where workspace_id = ${ws} and type = 'portal_idea.state_changed'`;
    expect(JSON.stringify(rows)).not.toContain("Awaiting legal review");
    expect(rows).toEqual([]);
  });

  it("stays silent for an idea in an unpublished product", async () => {
    const id = await seedIdea({
      status: "planned",
      visibility: "published",
      productId: secretProduct,
    });
    await store.updateIdea(id, { status: "shipped" }, scope);
    expect(await emitted()).toEqual([]);
  });

  it("stays silent while the portal is switched off", async () => {
    await sql`update idea_settings set portal_enabled = false where workspace_id = ${ws}`;
    try {
      const id = await seedIdea({ status: "planned", visibility: "published" });
      await store.updateIdea(id, { status: "shipped" }, scope);
      expect(await emitted()).toEqual([]);
    } finally {
      await sql`update idea_settings set portal_enabled = true where workspace_id = ${ws}`;
    }
  });

  it("stays silent for an edit that changes no state", async () => {
    const id = await seedIdea({ status: "planned", visibility: "published" });
    await store.updateIdea(id, { title: "Retitled" }, scope);
    expect(await emitted()).toEqual([]);
  });
});
