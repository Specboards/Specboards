import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { PortalContext } from "./resolve";

/**
 * What the public read model returns, and much more importantly what it does
 * not.
 *
 * ── Why these assertions are about absence ─────────────────────────────────
 * Every case here concerns a row or a field that EXISTS, is readable on the
 * owner connection, and must not appear on a page served to a stranger. That is
 * the only class of bug this design exists to prevent, and the only one a
 * working portal would never reveal: a leak renders perfectly, looks like a
 * feature, and is noticed by the wrong person.
 *
 * ── Why the field list is asserted exactly, not field by field ─────────────
 * `expect(Object.keys(idea)).toEqual([...])` rather than a handful of
 * `not.toHaveProperty` calls, so that publishing a NEW field is a decision
 * somebody has to take on purpose rather than something that happens quietly.
 *
 * Worth being precise about which mistake that catches, because the obvious
 * guess is wrong. Widening the projection's `select` is harmless on its own:
 * the `.map()` rebuilds an explicit object literal, so an extra selected column
 * goes nowhere and this file stays green (checked, by doing it). The mutation
 * that DOES leak is `...r` in that map, which is also the tidier-looking edit
 * and the one a reviewer is likelier to wave through. With the select widened
 * and the spread added, two cases below fail, one on the exact key list and one
 * on the author id reaching the serialised output.
 *
 * ── Two enforcement layers, and this file exercises the outer one ──────────
 * `portal-role-rls.int.test.ts` asks the database what the portal role may
 * read. This asks the read model what it projects, through the real connection,
 * so a projection that selected a forbidden column would fail here even though
 * RLS was never the thing stopping it. Both are needed: RLS bounds the rows,
 * the projection bounds the fields, and neither substitutes for the other.
 *
 * Needs a migrated Postgres with the portal role provisioned and able to log
 * in; skips itself without DATABASE_URL_PORTAL.
 */

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const PORTAL_URL = process.env.DATABASE_URL_PORTAL;

const ws = randomUUID();
const shownProduct = randomUUID();
const unannouncedProduct = randomUUID();
const publishedIdea = randomUUID();
const internalIdea = randomUUID();
const unannouncedIdea = randomUUID();
const pendingIdea = randomUUID();
const hiddenIdea = randomUUID();
const promotedFeature = randomUUID();
const author = randomUUID();
const suffix = randomUUID().slice(0, 8);

/** The exact public shape of an idea. Adding to this is a decision. */
const PUBLIC_IDEA_FIELDS = [
  "id",
  "title",
  "description",
  "status",
  "statusLabel",
  "submitterName",
  "voteCount",
  "createdAt",
].sort();

describe.skipIf(!DB_URL || !PORTAL_URL)("the public ideas read model", () => {
  let sql: postgres.Sql;
  let portal: PortalContext;
  let listPortalIdeas: typeof import("./ideas").listPortalIdeas;
  let readPortalIdea: typeof import("./ideas").readPortalIdea;

  beforeAll(async () => {
    sql = postgres(DB_URL!, { prepare: false, max: 2 });
    await sql.unsafe(
      readFileSync(
        join(process.cwd(), "..", "..", "infra", "portal-role.sql"),
        "utf8",
      ),
    );

    await sql`insert into workspaces (id, name, slug)
      values (${ws}, 'Read Model Co', ${`rm-${suffix}`})`;
    await sql`insert into users (id, name, email)
      values (${author}, 'Internal Author', ${`author-${suffix}@rm.test`})`;
    await sql`insert into products (id, workspace_id, key, name) values
      (${shownProduct}, ${ws}, ${`shown-${suffix}`}, 'Shown Product'),
      (${unannouncedProduct}, ${ws}, ${`secret-${suffix}`}, 'Unannounced Product')`;

    // A custom workflow, so the stage LABELS come from the table rather than
    // from the built-in defaults. `planned` is published; `awaiting_legal` is
    // not, and its label is the kind of thing a workspace would be unhappy to
    // find on its own public page.
    await sql`insert into idea_statuses (workspace_id, key, label, position) values
      (${ws}, 'planned', 'On the roadmap', 0),
      (${ws}, 'awaiting_legal', 'Awaiting legal review', 1),
      (${ws}, 'shipped', 'Shipped', 2)`;

    await sql`insert into idea_settings
        (workspace_id, portal_enabled, portal_title, portal_idea_statuses,
         portal_roadmap_enabled, portal_roadmap_item_statuses)
      values (${ws}, true, 'Read Model Co Ideas', array['planned', 'shipped'],
              false, array[]::text[])`;
    await sql`insert into idea_portal_products (workspace_id, product_id)
      values (${ws}, ${shownProduct})`;

    await sql`insert into workspace_levels (workspace_id, key, label, position, is_leaf)
      values (${ws}, ${`feature-${suffix}`}, 'Feature', 0, false)`;
    await sql`insert into features (id, workspace_id, product_id, spec_id, level, title, status)
      values (${promotedFeature}, ${ws}, ${shownProduct}, ${promotedFeature},
              ${`feature-${suffix}`}, 'Unannounced feature name', 'in_progress')`;

    await sql`insert into ideas
        (id, workspace_id, product_id, title, description, status,
         author_id, submitter_name, submitter_email, promoted_feature_id)
      values
        (${publishedIdea}, ${ws}, ${shownProduct}, 'Published idea',
         'Please build this', 'planned', ${author}, 'Ada Outside',
         ${`ada-${suffix}@example.com`}, ${promotedFeature}),
        (${internalIdea}, ${ws}, ${shownProduct}, 'Awaiting legal idea',
         null, 'awaiting_legal', ${author}, null, null, null),
        (${unannouncedIdea}, ${ws}, ${unannouncedProduct},
         'Idea about the unannounced thing', null, 'planned', ${author},
         null, null, null)`;

    // Two more in the PUBLISHED product at a PUBLISHED stage, so the moderation
    // state is the only thing keeping them off the portal. Anything else in the
    // fixture would let these pass for the wrong reason.
    await sql`insert into ideas
        (id, workspace_id, product_id, title, status, submitter_name,
         submitter_email, portal_visibility)
      values
        (${pendingIdea}, ${ws}, ${shownProduct}, 'Unreviewed submission',
         'planned', 'Spammer', ${`spam-${suffix}@example.com`}, 'pending'),
        (${hiddenIdea}, ${ws}, ${shownProduct}, 'Rejected submission',
         'planned', 'Rejected Person', ${`rej-${suffix}@example.com`}, 'hidden')`;

    await sql`insert into idea_votes (workspace_id, idea_id, voter_email) values
      (${ws}, ${publishedIdea}, ${`v1-${suffix}@example.com`}),
      (${ws}, ${publishedIdea}, ${`v2-${suffix}@example.com`})`;

    // Point the module at the portal role, then import it fresh:
    // `getPortalDb()` memoises its client in a module-level variable, so the
    // env has to be set before the first call in this module instance.
    vi.stubEnv("DATABASE_URL_PORTAL", PORTAL_URL!);
    vi.resetModules();
    const mod = await import("./ideas");
    listPortalIdeas = mod.listPortalIdeas;
    readPortalIdea = mod.readPortalIdea;

    portal = {
      workspaceId: ws,
      orgSlug: `rm-${suffix}`,
      title: "Read Model Co Ideas",
      settings: {
        portalEnabled: true,
        portalTitle: "Read Model Co Ideas",
        portalProductIds: [shownProduct],
        portalIdeaStatuses: ["planned", "shipped"],
        portalRoadmapEnabled: false,
        portalRoadmapItemStatuses: [],
        portalModeration: "review_first",
      },
    };
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await sql`delete from idea_votes where workspace_id = ${ws}`;
    await sql`delete from ideas where workspace_id = ${ws}`;
    await sql`delete from features where workspace_id = ${ws}`;
    await sql`delete from workspace_levels where workspace_id = ${ws}`;
    await sql`delete from idea_portal_products where workspace_id = ${ws}`;
    await sql`delete from idea_settings where workspace_id = ${ws}`;
    await sql`delete from idea_statuses where workspace_id = ${ws}`;
    await sql`delete from products where workspace_id = ${ws}`;
    await sql`delete from workspaces where id = ${ws}`;
    await sql`delete from users where id = ${author}`;
    await sql.end({ timeout: 5 });
  });

  it("lists only ideas in a published product at a published stage", async () => {
    // Three ideas exist. One is at a stage nobody published, one belongs to a
    // product nobody published, and each is excluded for its own reason.
    const { ideas } = await listPortalIdeas(portal);
    expect(ideas.map((i) => i.title)).toEqual(["Published idea"]);
  });

  it("excludes an unreviewed submission and a rejected one", async () => {
    // Both sit in a published product at a published stage, so the visibility
    // model would show them and the moderation state is the only thing that
    // does not. That is the point: this is the one rule that is about a single
    // row rather than a category, and it is the one an admin reaches for when
    // a stranger writes something they do not want on their own branded page.
    const { ideas } = await listPortalIdeas(portal);
    const titles = ideas.map((i) => i.title);
    expect(titles).not.toContain("Unreviewed submission");
    expect(titles).not.toContain("Rejected submission");
    expect(titles).toEqual(["Published idea"]);

    // And by id, so a direct link to a rejected submission is as dead as the
    // list implies. A moderator who rejects spam has to be able to rely on the
    // URL the spammer already has going nowhere.
    expect(await readPortalIdea(portal, pendingIdea)).toBeNull();
    expect(await readPortalIdea(portal, hiddenIdea)).toBeNull();
  });

  it("leaks nothing from a submission it refused to publish", async () => {
    // The rejected rows carry a name and an address like any other submission.
    // Excluding a row from the list is not the same as its contents being
    // unreachable, and this is the assertion that says so.
    const serialised = JSON.stringify(await listPortalIdeas(portal));
    expect(serialised).not.toContain("Spammer");
    expect(serialised).not.toContain(`spam-${suffix}@example.com`);
    expect(serialised).not.toContain("Rejected Person");
    expect(serialised).not.toContain(`rej-${suffix}@example.com`);
  });

  it("projects exactly the public fields and no others", async () => {
    const { ideas } = await listPortalIdeas(portal);
    const [idea] = ideas;
    expect(idea).toBeDefined();
    expect(Object.keys(idea!).sort()).toEqual(PUBLIC_IDEA_FIELDS);
  });

  it("omits the internal author, the submitter's email, and the promotion", async () => {
    // All four exist on this row and all four are readable on the owner
    // connection. Serialised, because the assertion that matters is about what
    // reaches the client, and a field nested somewhere unexpected would still
    // ship.
    const { ideas } = await listPortalIdeas(portal);
    const serialised = JSON.stringify(ideas);

    expect(serialised).not.toContain(author);
    expect(serialised).not.toContain(`ada-${suffix}@example.com`);
    expect(serialised).not.toContain(promotedFeature);
    expect(serialised).not.toContain("Unannounced feature name");
    // The submitter's NAME is published on purpose (they chose to attach it to
    // a public suggestion); their address is not. Asserted so the case above
    // cannot pass by dropping both.
    expect(ideas[0]?.submitterName).toBe("Ada Outside");
  });

  it("resolves the stage label the workspace chose, not the key", async () => {
    const { ideas } = await listPortalIdeas(portal);
    expect(ideas[0]?.statusLabel).toBe("On the roadmap");
  });

  it("offers only published stages as filters, with no unpublished label", async () => {
    // A published stage with no ideas at it still belongs in the filter, and
    // an unpublished stage's label must not appear even though its key is a
    // real part of the workspace's workflow.
    const { stages } = await listPortalIdeas(portal);
    expect(stages).toEqual([
      { key: "planned", label: "On the roadmap" },
      { key: "shipped", label: "Shipped" },
    ]);
    expect(JSON.stringify(stages)).not.toContain("Awaiting legal review");
  });

  it("counts votes without reading who cast them", async () => {
    // Two anonymous votes. The count is the whole demand signal; the addresses
    // behind it are not a column this connection can even name (0010), so a
    // projection that reached for them would fail rather than leak.
    const { ideas } = await listPortalIdeas(portal);
    expect(ideas[0]?.voteCount).toBe(2);
    expect(JSON.stringify(ideas)).not.toContain(`v1-${suffix}@example.com`);
  });

  it("reads a published idea by id, with the same projection", async () => {
    const idea = await readPortalIdea(portal, publishedIdea);
    expect(idea?.title).toBe("Published idea");
    expect(Object.keys(idea!).sort()).toEqual(PUBLIC_IDEA_FIELDS);
  });

  it("returns null for an unpublished idea, exactly as for a missing one", async () => {
    // The same answer for both, so the detail route cannot be used to confirm
    // which guessed ids name real internal ideas.
    expect(await readPortalIdea(portal, internalIdea)).toBeNull();
    expect(await readPortalIdea(portal, unannouncedIdea)).toBeNull();
    expect(await readPortalIdea(portal, randomUUID())).toBeNull();
  });

  it("publishes nothing when the workspace has chosen no stages", async () => {
    // The default state of a portal switched on before it is configured. It is
    // unfinished rather than broken, and the correct output is empty.
    const unconfigured: PortalContext = {
      ...portal,
      settings: { ...portal.settings, portalIdeaStatuses: [] },
    };
    expect(await listPortalIdeas(unconfigured)).toEqual({
      ideas: [],
      stages: [],
    });
    expect(await readPortalIdea(unconfigured, publishedIdea)).toBeNull();
  });

  it("cannot be talked into another workspace's ideas by its context", async () => {
    // The read model filters by `workspaceId` as well as relying on RLS, because
    // the portal role can read the published rows of EVERY workspace by design
    // (0009: deciding which portal a request is for is the application's job).
    // This is that filter, asserted.
    const elsewhere: PortalContext = { ...portal, workspaceId: randomUUID() };
    expect((await listPortalIdeas(elsewhere)).ideas).toEqual([]);
    expect(await readPortalIdea(elsewhere, publishedIdea)).toBeNull();
  });
});
