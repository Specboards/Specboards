import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { PortalContext } from "@/lib/portal/resolve";

/**
 * Anonymous voting, against real Postgres.
 *
 * The interesting cases are all about a vote that must NOT be recorded, or must
 * not be recorded twice. A vote that works is visible in the product; a vote
 * that is silently double-counted is visible only as a number somebody trusts
 * and should not.
 *
 * Needs a migrated Postgres with the portal role provisioned and able to log
 * in; skips itself without DATABASE_URL_PORTAL.
 */

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const PORTAL_URL = process.env.DATABASE_URL_PORTAL;

const ws = randomUUID();
const product = randomUUID();
const publishedIdea = randomUUID();
const hiddenIdea = randomUUID();
const unpublishedStageIdea = randomUUID();
const member = randomUUID();
const suffix = randomUUID().slice(0, 8);

describe.skipIf(!DB_URL || !PORTAL_URL)("recording an anonymous vote", () => {
  let sql: postgres.Sql;
  let recordPortalVote: typeof import("./vote").recordPortalVote;
  let portal: PortalContext;

  const countFor = async (ideaId: string) => {
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from idea_votes where idea_id = ${ideaId}`;
    return Number(row?.n ?? 0);
  };

  beforeAll(async () => {
    sql = postgres(DB_URL!, { prepare: false, max: 2 });
    await sql.unsafe(
      readFileSync(
        join(process.cwd(), "..", "..", "infra", "portal-role.sql"),
        "utf8",
      ),
    );

    await sql`insert into workspaces (id, name, slug)
      values (${ws}, 'Vote Co', ${`vote-${suffix}`})`;
    await sql`insert into products (id, workspace_id, key, name)
      values (${product}, ${ws}, ${`p-${suffix}`}, 'Product')`;
    await sql`insert into idea_settings
        (workspace_id, portal_enabled, portal_idea_statuses)
      values (${ws}, true, array['planned'])`;
    await sql`insert into idea_portal_products (workspace_id, product_id)
      values (${ws}, ${product})`;
    await sql`insert into ideas
        (id, workspace_id, product_id, title, status, portal_visibility) values
        (${publishedIdea}, ${ws}, ${product}, 'Published', 'planned', 'published'),
        (${hiddenIdea}, ${ws}, ${product}, 'Hidden', 'planned', 'hidden'),
        (${unpublishedStageIdea}, ${ws}, ${product}, 'Wrong stage', 'new', 'published')`;

    vi.stubEnv("DATABASE_URL_PORTAL", PORTAL_URL!);
    vi.resetModules();
    recordPortalVote = (await import("./vote")).recordPortalVote;

    portal = {
      workspaceId: ws,
      orgSlug: `vote-${suffix}`,
      title: "Vote Co",
      settings: {
        portalEnabled: true,
        portalTitle: null,
        portalProductIds: [product],
        portalIdeaStatuses: ["planned"],
        portalRoadmapEnabled: false,
        portalRoadmapItemStatuses: [],
        portalModeration: "review_first",
      },
    };
  });

  beforeEach(async () => {
    await sql`delete from idea_votes where workspace_id = ${ws}`;
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await sql`delete from idea_votes where workspace_id = ${ws}`;
    await sql`delete from ideas where workspace_id = ${ws}`;
    await sql`delete from idea_portal_products where workspace_id = ${ws}`;
    await sql`delete from idea_settings where workspace_id = ${ws}`;
    await sql`delete from products where workspace_id = ${ws}`;
    await sql`delete from workspaces where id = ${ws}`;
    await sql.end({ timeout: 5 });
  });

  it("records a vote from a confirmed address", async () => {
    const result = await recordPortalVote(
      portal,
      publishedIdea,
      "ada@example.com",
    );
    expect(result).toEqual({ ok: true, alreadyVoted: false });
    expect(await countFor(publishedIdea)).toBe(1);
  });

  it("is idempotent, so a replayed confirmation link counts once", async () => {
    // The property the card asked for. The confirmation link is clickable more
    // than once within its 30-minute window (a second click, a mail gateway
    // prefetch, a browser retry), and each of those must be a no-op rather than
    // a vote.
    await recordPortalVote(portal, publishedIdea, "ada@example.com");
    const replay = await recordPortalVote(
      portal,
      publishedIdea,
      "ada@example.com",
    );
    expect(replay).toEqual({ ok: true, alreadyVoted: true });
    expect(await countFor(publishedIdea)).toBe(1);
  });

  it("treats a case-varying address as the same voter", async () => {
    // The token carries whatever the visitor typed. Without the lower-casing
    // here and the case-folded index behind it, `Ada@` and `ada@` are two
    // votes from one person.
    await recordPortalVote(portal, publishedIdea, "ada@example.com");
    const again = await recordPortalVote(
      portal,
      publishedIdea,
      "  ADA@Example.COM  ",
    );
    expect(again).toEqual({ ok: true, alreadyVoted: true });
    expect(await countFor(publishedIdea)).toBe(1);
  });

  it("lets a member and an external voter both count on one idea", async () => {
    // The two identity kinds are independent, which is what the partial
    // indexes in 0010 exist for.
    await sql`insert into idea_votes (workspace_id, idea_id, user_id)
      values (${ws}, ${publishedIdea}, ${member})`;
    await recordPortalVote(portal, publishedIdea, "ada@example.com");
    expect(await countFor(publishedIdea)).toBe(2);
  });

  it("refuses a vote on an idea the moderator hid", async () => {
    // The stale-link case, and the reason the publication check lives in the
    // recording helper rather than at each caller. The idea was public when the
    // mail went out; by the time the link is clicked it is not.
    const result = await recordPortalVote(portal, hiddenIdea, "ada@example.com");
    expect(result).toEqual({ ok: false, reason: "not-found" });
    expect(await countFor(hiddenIdea)).toBe(0);
  });

  it("refuses a vote on an idea at an unpublished stage", async () => {
    const result = await recordPortalVote(
      portal,
      unpublishedStageIdea,
      "ada@example.com",
    );
    expect(result).toEqual({ ok: false, reason: "not-found" });
    expect(await countFor(unpublishedStageIdea)).toBe(0);
  });

  it("refuses a vote on an idea in another workspace", async () => {
    const elsewhere: PortalContext = { ...portal, workspaceId: randomUUID() };
    const result = await recordPortalVote(
      elsewhere,
      publishedIdea,
      "ada@example.com",
    );
    expect(result).toEqual({ ok: false, reason: "not-found" });
    expect(await countFor(publishedIdea)).toBe(0);
  });

  it("refuses an id that names nothing", async () => {
    const result = await recordPortalVote(
      portal,
      randomUUID(),
      "ada@example.com",
    );
    expect(result).toEqual({ ok: false, reason: "not-found" });
  });
});
