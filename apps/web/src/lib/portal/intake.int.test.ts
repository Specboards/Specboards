import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The public idea intake, exercised against real Postgres.
 *
 * This is the first endpoint in the product that lets somebody with no account
 * WRITE, so the cases worth having are the ones about what a stranger cannot
 * make it do: file into a workspace whose portal is off, file into a product
 * that workspace has not published, or publish something a review-first
 * workspace meant to hold.
 *
 * ── Mail is stubbed, and only mail ─────────────────────────────────────────
 * `sendEmail` is mocked so the suite sends nothing. Everything else is real:
 * the route handler, `resolvePortal` on the portal connection, and the insert
 * on the owner connection. Stubbing the store instead would have left the one
 * thing this endpoint is for (a correctly-scoped row) unasserted.
 *
 * Needs a migrated Postgres with the portal role provisioned and able to log
 * in; skips itself without DATABASE_URL_PORTAL.
 */

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const PORTAL_URL = process.env.DATABASE_URL_PORTAL;

const openWs = randomUUID();
const shutWs = randomUUID();
const shownProduct = randomUUID();
const unannouncedProduct = randomUUID();
const shutProduct = randomUUID();
const suffix = randomUUID().slice(0, 8);
const openSlug = `intake-open-${suffix}`;
const shutSlug = `intake-shut-${suffix}`;

// `revalidatePath` needs Next's per-request store, which exists in a real
// route handler and not when the handler is called directly. Mocked rather than
// guarded in the route, because the route's call is correct in production and a
// `try/catch` there would hide a genuine failure to refresh the board.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

const sent: { to: string; subject: string }[] = [];
vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn(async (m: { to: string; subject: string }) => {
    sent.push({ to: m.to, subject: m.subject });
  }),
  renderInfoEmail: () => ({ textBody: "text", htmlBody: "<p>html</p>" }),
}));

describe.skipIf(!DB_URL || !PORTAL_URL)("public idea intake", () => {
  let sql: postgres.Sql;
  let POST: typeof import("@/app/api/portal/[org]/ideas/route").POST;

  /** Post a submission the way the portal form does. */
  const submit = (org: string, body: Record<string, unknown>) =>
    POST(
      new Request(`https://app.test/api/portal/${org}/ideas`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ org }) },
    );

  const rowsFor = (ws: string) =>
    sql<
      {
        title: string;
        status: string;
        portal_visibility: string;
        submitter_email: string | null;
        submitter_name: string | null;
        author_id: string | null;
        product_id: string;
      }[]
    >`select title, status, portal_visibility, submitter_email, submitter_name,
             author_id, product_id
        from ideas where workspace_id = ${ws}`;

  beforeAll(async () => {
    sql = postgres(DB_URL!, { prepare: false, max: 2 });
    await sql.unsafe(
      readFileSync(
        join(process.cwd(), "..", "..", "infra", "portal-role.sql"),
        "utf8",
      ),
    );

    await sql`insert into workspaces (id, name, slug) values
      (${openWs}, 'Intake Co', ${openSlug}),
      (${shutWs}, 'Closed Co', ${shutSlug})`;
    await sql`insert into products (id, workspace_id, key, name) values
      (${shownProduct}, ${openWs}, ${`shown-${suffix}`}, 'Shown Product'),
      (${unannouncedProduct}, ${openWs}, ${`secret-${suffix}`}, 'Unannounced Product'),
      (${shutProduct}, ${shutWs}, ${`priv-${suffix}`}, 'Private Product')`;
    await sql`insert into idea_settings
        (workspace_id, portal_enabled, portal_idea_statuses, portal_moderation)
      values
        (${openWs}, true, array['planned'], 'review_first'),
        (${shutWs}, false, array['planned'], 'immediate')`;
    await sql`insert into idea_portal_products (workspace_id, product_id) values
      (${openWs}, ${shownProduct}),
      (${shutWs}, ${shutProduct})`;

    vi.stubEnv("DATABASE_URL_PORTAL", PORTAL_URL!);
    vi.resetModules();
    POST = (await import("@/app/api/portal/[org]/ideas/route")).POST;
  });

  beforeEach(async () => {
    sent.length = 0;
    await sql`delete from ideas where workspace_id in ${sql([openWs, shutWs])}`;
    await sql`update idea_settings set portal_moderation = 'review_first'
                where workspace_id = ${openWs}`;
    // Reset the quota counters this file spends.
    //
    // These live in Postgres so the limit holds across machines, which means
    // they also hold across test runs and across the cases in this file. Every
    // request here carries no `fly-client-ip` and no trusted
    // `x-forwarded-for`, so `rateLimitKey` puts them all in the single
    // `portal-idea:unknown-client` bucket, which is 10 per hour: this file
    // makes nine submissions, so the second run in an hour would start
    // returning 429 and the failure would look like a broken endpoint rather
    // than an exhausted counter. Found exactly that way.
    await sql`delete from operation_limits
                where key like 'portal-idea%' or key like '%@example.com'`;
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await sql`delete from ideas where workspace_id in ${sql([openWs, shutWs])}`;
    await sql`delete from idea_portal_products where workspace_id in ${sql([openWs, shutWs])}`;
    await sql`delete from idea_settings where workspace_id in ${sql([openWs, shutWs])}`;
    await sql`delete from products where workspace_id in ${sql([openWs, shutWs])}`;
    await sql`delete from workspaces where id in ${sql([openWs, shutWs])}`;
    await sql.end({ timeout: 5 });
  });

  it("records a submission against the published product", async () => {
    const res = await submit(openSlug, {
      title: "Dark mode",
      description: "It burns at night.",
      name: "Ada",
      email: "Ada@Example.COM",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, moderated: true });

    const [row] = await rowsFor(openWs);
    expect(row?.title).toBe("Dark mode");
    expect(row?.product_id).toBe(shownProduct);
    // Lower-cased on the way in, so the address is one voter and one recipient
    // rather than several depending on how it was typed.
    expect(row?.submitter_email).toBe("ada@example.com");
    expect(row?.submitter_name).toBe("Ada");
    // Null, not the submitter. `author_id` means an internal member, and this
    // is the column `isExternalSubmission` distinguishes on.
    expect(row?.author_id).toBeNull();
    // First stage of the built-in workflow: untriaged, because nobody has
    // looked at it.
    expect(row?.status).toBe("new");
  });

  it("holds it for review by default, and confirms honestly", async () => {
    await submit(openSlug, { title: "Held", email: "a@example.com" });
    const [row] = await rowsFor(openWs);
    expect(row?.portal_visibility).toBe("pending");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("a@example.com");
  });

  it("publishes at once when the workspace asked for that", async () => {
    await sql`update idea_settings set portal_moderation = 'immediate'
                where workspace_id = ${openWs}`;
    const res = await submit(openSlug, {
      title: "Straight through",
      email: "b@example.com",
    });
    expect(await res.json()).toEqual({ ok: true, moderated: false });
    const [row] = await rowsFor(openWs);
    expect(row?.portal_visibility).toBe("published");
  });

  it("refuses a product the portal does not publish", async () => {
    // The one that matters most: an outsider naming an internal product id
    // must not be able to file into that backlog. Guessing the id is not far
    // fetched, since ids travel in URLs elsewhere in the app.
    const res = await submit(openSlug, {
      title: "Filed at the secret product",
      email: "c@example.com",
      productId: unannouncedProduct,
    });
    expect(res.status).toBe(400);
    expect(await rowsFor(openWs)).toHaveLength(0);
  });

  it("refuses another workspace's product outright", async () => {
    const res = await submit(openSlug, {
      title: "Cross-tenant",
      email: "d@example.com",
      productId: shutProduct,
    });
    expect(res.status).toBe(400);
    expect(await rowsFor(openWs)).toHaveLength(0);
    expect(await rowsFor(shutWs)).toHaveLength(0);
  });

  it("404s for a workspace whose portal is switched off", async () => {
    // And writes nothing. `resolvePortal` reads on the portal connection, where
    // an unpublished workspace is not a row that exists, so the endpoint cannot
    // be talked into a tenant that never opened a portal.
    const res = await submit(shutSlug, {
      title: "Into a closed portal",
      email: "e@example.com",
    });
    expect(res.status).toBe(404);
    expect(await rowsFor(shutWs)).toHaveLength(0);
  });

  it("404s for an org that does not exist, identically", async () => {
    const res = await submit(`no-such-${suffix}`, {
      title: "Nowhere",
      email: "f@example.com",
    });
    expect(res.status).toBe(404);
  });

  it.each([
    ["no title", { title: "  ", email: "g@example.com" }],
    ["no email", { title: "Anonymous", email: "" }],
    ["a malformed email", { title: "Anonymous", email: "not-an-address" }],
  ])("rejects a submission with %s", async (_label, body) => {
    const res = await submit(openSlug, body);
    expect(res.status).toBe(400);
    expect(await rowsFor(openWs)).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("swallows a honeypot hit without writing or sending", async () => {
    // 200 and a plausible body, so a bot cannot tell acceptance from rejection
    // and learns nothing to tune against.
    const res = await submit(openSlug, {
      title: "Buy pills",
      email: "bot@example.com",
      website: "http://spam.example",
    });
    expect(res.status).toBe(200);
    expect(await rowsFor(openWs)).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("still records the idea when the confirmation email fails", async () => {
    // The row is the deliverable. Failing the request would tell the submitter
    // their idea was lost when it was not, and invite a duplicate.
    const email = await import("@/lib/email");
    vi.mocked(email.sendEmail).mockRejectedValueOnce(new Error("postmark down"));
    const res = await submit(openSlug, {
      title: "Mail is down",
      email: "h@example.com",
    });
    expect(res.status).toBe(200);
    expect(await rowsFor(openWs)).toHaveLength(1);
  });
});
