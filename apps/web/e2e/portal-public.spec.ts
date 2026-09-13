import { expect, test } from "@playwright/test";

import { mintVoteToken } from "@/lib/portal/vote-token";

import { BASE_URL } from "./helpers/constants";
import {
  getAdminUserId,
  getWorkspace,
  resetBoard,
  resetIdeas,
  resetPortalProducts,
  resetReleases,
  seedPortalFixture,
  voteCountFor,
} from "./helpers/db";

/**
 * The public portal's three visitor journeys, and everything they must not
 * reveal.
 *
 * `portal-shell.spec.ts` covers the chrome and the session-parity property.
 * This covers what the portal actually does now that it does something:
 * browse, submit, vote through a magic link, and read a roadmap.
 *
 * ── Why the leak assertions are against the RESPONSE, not the page ─────────
 * A field can be absent from what a visitor sees and present in what they were
 * sent. Next serialises server component props into the RSC payload inline in
 * the document, so an id that no element renders still ships to the browser and
 * is one View Source away. Every negative assertion here is therefore over the
 * raw response text.
 *
 * The fixture exists so that each of those has something to leak: a published
 * product and an unannounced one, a published stage and an unpublished one with
 * an embarrassing label, an idea that is visible and four that must not be, and
 * the visible idea carries an author id, a submitter email and a promoted
 * feature so the read model has real fields to omit.
 *
 * ── What these prove, and what they do not ─────────────────────────────────
 * This suite points `DATABASE_URL_PORTAL` at the same database as everything
 * else (see `playwright.config.ts`), so the portal reads on the OWNER
 * connection here and row-level security is not what keeps these rows out.
 * What is being asserted is therefore the application half: the read model's
 * own projection and predicates, the routing, and the 404s.
 *
 * That is the right split rather than a shortcut. The database half is asserted
 * in `portal-role-rls.int.test.ts`, which connects as the real
 * `specboards_portal` role, and the two are genuinely independent defences: RLS
 * bounds the rows, the projection bounds the fields, and a bug in either is
 * invisible to a test of the other.
 */

/** Everything a visitor must never receive, whatever page they load. */
async function assertNoLeaks(
  body: string,
  seed: Awaited<ReturnType<typeof seedPortalFixture>>,
  authorId: string,
) {
  const forbidden: [string, string][] = [
    ["an unannounced product's name", "UNANNOUNCED-PRODUCT-"],
    ["an idea in an unannounced product", "SECRET-PRODUCT-IDEA-"],
    ["an idea at an unpublished stage", "UNPUBLISHED-STAGE-IDEA-"],
    ["an unpublished stage's label", seed.unpublishedStage],
    ["an idea a moderator hid", "HIDDEN-IDEA-"],
    ["a submission awaiting review", "PENDING-IDEA-"],
    ["the promoted feature's title", "UNANNOUNCED-FEATURE-"],
    ["the promoted feature's id", seed.promotedFeatureId],
    ["the internal author's id", authorId],
    // The WHOLE address, not a prefix.
    //
    // This was `"ada-"`, which is a substring a uuid produces by chance: hex
    // segments routinely end in `ada` and are followed by a hyphen, so the
    // assertion failed on perhaps one run in ten, on a page that leaked
    // nothing. A flaky security check is worse than no check, because it
    // teaches people to re-run it rather than read it, which is the same
    // reasoning `portal-shell.spec.ts` records about comparing raw markup.
    ["the submitter's email address", seed.submitterEmail],
    ["a hidden idea's id", seed.hiddenIdeaId],
    ["an unannounced product's id", seed.secretProductId],
    ["a roadmap item in an unannounced product", "SECRET-ROADMAP-ITEM-"],
  ];
  for (const [what, needle] of forbidden) {
    expect(body, `the portal must not send ${what}`).not.toContain(needle);
  }
}

test.describe("the public portal", () => {
  let seed: Awaited<ReturnType<typeof seedPortalFixture>>;
  let slug: string;
  let workspaceId: string;
  let authorId: string;

  test.beforeEach(async () => {
    const ws = await getWorkspace();
    slug = ws.slug;
    workspaceId = ws.id;
    authorId = await getAdminUserId();
    await resetIdeas(workspaceId);
    seed = await seedPortalFixture({ workspaceId, authorId });
  });

  test.afterEach(async () => {
    // Every other spec assumes no portal and an empty board, so leave the
    // workspace as found. Order matters: features reference both the release
    // and the products, and `product-groups.spec.ts` deletes products in its
    // own setup, where a leftover feature fails it on a foreign key several
    // files from the cause.
    await resetIdeas(workspaceId);
    await resetBoard(workspaceId);
    await resetReleases(workspaceId);
    await resetPortalProducts(workspaceId);
  });

  test("browses published ideas and sends nothing else", async ({
    request,
  }) => {
    const res = await request.get(`${BASE_URL}/${slug}/ideas`);
    expect(res.status()).toBe(200);
    const body = await res.text();

    // The one idea that should be there, by its published stage label.
    expect(body).toContain(seed.publishedStage);
    expect(body).toContain("On the roadmap");
    await assertNoLeaks(body, seed, authorId);
  });

  test("serves a published idea's own page, and 404s the rest", async ({
    request,
  }) => {
    const ok = await request.get(
      `${BASE_URL}/${slug}/ideas/${seed.visibleIdeaId}`,
    );
    expect(ok.status()).toBe(200);
    await assertNoLeaks(await ok.text(), seed, authorId);

    // Four reasons an idea is not public, one answer. An id is guessable in
    // bulk, so a route that distinguished them would confirm which ids name
    // real internal ideas.
    for (const [why, id] of [
      ["a moderator hid it", seed.hiddenIdeaId],
      ["it is awaiting review", seed.pendingIdeaId],
      ["its stage is not published", seed.unpublishedStageIdeaId],
      ["its product is not published", seed.secretProductIdeaId],
    ] as const) {
      const res = await request.get(`${BASE_URL}/${slug}/ideas/${id}`, {
        failOnStatusCode: false,
      });
      expect(res.status(), `must 404 because ${why}`).toBe(404);
    }
  });

  test("accepts a submission and holds it for review", async ({ request }) => {
    const email = `submitter-${Date.now()}@example.com`;
    const res = await request.post(`${BASE_URL}/api/portal/${slug}/ideas`, {
      headers: { "content-type": "application/json", origin: BASE_URL },
      data: { title: "E2E submitted idea", email, name: "E2E Person" },
    });
    expect(res.status()).toBe(200);
    // `moderated` is the workspace's default (review-first), so the visitor is
    // told the truth: it is not on the page yet.
    expect(await res.json()).toMatchObject({ ok: true, moderated: true });

    // And it really is not. This is the assertion the moderation state exists
    // for: the row is written, and the public page does not show it.
    const list = await request.get(`${BASE_URL}/${slug}/ideas`);
    expect(await list.text()).not.toContain("E2E submitted idea");
  });

  test("refuses a submission naming a product it does not publish", async ({
    request,
  }) => {
    // The id is guessable, and accepting it would let an outsider file into an
    // unannounced backlog.
    const res = await request.post(`${BASE_URL}/api/portal/${slug}/ideas`, {
      headers: { "content-type": "application/json", origin: BASE_URL },
      data: {
        title: "Filed at the secret product",
        email: "someone@example.com",
        productId: seed.secretProductId,
      },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(400);
  });

  test("counts a vote when its magic link is opened", async ({ browser }) => {
    // The token is minted here with the app's OWN function rather than
    // reimplemented, so this exercises the real signature and the real expiry.
    // Doing it this way rather than reading a mailbox is deliberate: the E2E
    // stack has no mail transport, and the thing worth testing is what the link
    // does, not that SMTP works.
    const token = mintVoteToken({
      ideaId: seed.visibleIdeaId,
      email: "e2e-voter@example.com",
    });
    expect(token, "BETTER_AUTH_SECRET must be set for the E2E run").not.toBeNull();

    expect(await voteCountFor(seed.visibleIdeaId)).toBe(0);

    // A stranger's browser: no session, no cookies.
    const ctx = await browser.newContext({ storageState: undefined });
    try {
      const page = await ctx.newPage();
      await page.goto(
        `${BASE_URL}/${slug}/ideas/vote?t=${encodeURIComponent(token!)}`,
      );
      // Lands on the idea, not on a dead-end confirmation screen.
      await expect(page).toHaveURL(
        new RegExp(`/${slug}/ideas/${seed.visibleIdeaId}\\?voted=counted$`),
      );
      await expect(page.getByText("Your vote is counted")).toBeVisible();
      expect(await voteCountFor(seed.visibleIdeaId)).toBe(1);

      // Replaying the same link counts once. A second click, a mail gateway
      // prefetch and a browser retry all land here.
      await page.goto(
        `${BASE_URL}/${slug}/ideas/vote?t=${encodeURIComponent(token!)}`,
      );
      await expect(page).toHaveURL(/\?voted=already$/);
      expect(await voteCountFor(seed.visibleIdeaId)).toBe(1);

      // And the confirmation left a cookie, so the next vote needs no email.
      const cookies = await ctx.cookies();
      expect(cookies.map((c) => c.name)).toContain("sb_portal_voter");
      const voter = cookies.find((c) => c.name === "sb_portal_voter");
      expect(voter?.httpOnly, "the voter cookie must be httpOnly").toBe(true);
      // The address must not be readable from the cookie value.
      expect(voter?.value).not.toContain("e2e-voter@example.com");
    } finally {
      await ctx.close();
    }
  });

  test("refuses a vote link for an idea that is no longer public", async ({
    browser,
  }) => {
    // The stale-link case: public when the mail went out, withdrawn by the time
    // it is opened.
    const token = mintVoteToken({
      ideaId: seed.hiddenIdeaId,
      email: "e2e-voter@example.com",
    })!;
    const ctx = await browser.newContext({ storageState: undefined });
    try {
      const page = await ctx.newPage();
      await page.goto(
        `${BASE_URL}/${slug}/ideas/vote?t=${encodeURIComponent(token)}`,
      );
      await expect(page).toHaveURL(/\/ideas\?voted=gone$/);
      expect(await voteCountFor(seed.hiddenIdeaId)).toBe(0);
    } finally {
      await ctx.close();
    }
  });

  test("refuses a forged vote link", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: undefined });
    try {
      const page = await ctx.newPage();
      // A payload naming a real idea, with a signature that is not ours.
      const forged = `${Buffer.from(
        JSON.stringify({
          ideaId: seed.visibleIdeaId,
          email: "attacker@example.com",
          exp: Date.now() + 60_000,
        }),
        "utf8",
      ).toString("base64url")}.not-a-real-signature`;
      await page.goto(`${BASE_URL}/${slug}/ideas/vote?t=${forged}`);
      await expect(page).toHaveURL(/\/ideas\?voted=invalid$/);
      expect(await voteCountFor(seed.visibleIdeaId)).toBe(0);
    } finally {
      await ctx.close();
    }
  });

  test("says voting is unavailable rather than pretending to send", async ({
    request,
  }) => {
    // The E2E stack configures no mail transport, which makes it exactly the
    // deployment this guard is for. Without it the endpoint answers `sent:
    // true`, the visitor is told to check their email, `sendEmail` logs
    // "dropping", and the vote is never recorded.
    const res = await request.post(
      `${BASE_URL}/api/portal/${slug}/ideas/${seed.visibleIdeaId}/vote`,
      {
        headers: { "content-type": "application/json", origin: BASE_URL },
        data: { email: "wants-to-vote@example.com" },
        failOnStatusCode: false,
      },
    );
    expect(res.status()).toBe(503);
    expect(await voteCountFor(seed.visibleIdeaId)).toBe(0);
  });

  test("404s the roadmap until it is switched on, separately", async ({
    request,
  }) => {
    // The roadmap is gated separately from the ideas portal (migration 0008):
    // wanting feedback in the open is not the same decision as publishing what
    // you plan to build and when. The fixture publishes ideas and not the
    // roadmap, so this is that state.
    const off = await request.get(`${BASE_URL}/${slug}/roadmap`, {
      failOnStatusCode: false,
    });
    expect(off.status()).toBe(404);

    // And the ideas portal is unaffected, which is the half that proves the two
    // switches are independent rather than one gating both.
    const ideas = await request.get(`${BASE_URL}/${slug}/ideas`);
    expect(ideas.status()).toBe(200);
  });

  test("publishes a roadmap without publishing the vocabulary", async ({
    page,
    request,
  }) => {
    // Switch the roadmap on as the admin, publishing one internal stage.
    const enable = await page.request.patch("/api/v1/idea-settings", {
      headers: { "content-type": "application/json" },
      data: {
        portalRoadmapEnabled: true,
        portalRoadmapItemStatuses: ["in_progress"],
      },
    });
    expect(enable.ok(), "enabling the roadmap").toBe(true);

    const res = await request.get(`${BASE_URL}/${slug}/roadmap`);
    expect(res.status()).toBe(200);
    const body = await res.text();

    // The item is there, described in the public vocabulary...
    expect(body).toContain(seed.roadmapItemTitle);
    expect(body).toContain("In progress");
    // ...and never by the workspace's own stage key, which is the entire
    // reason the coarse mapping exists.
    expect(body, "the roadmap must not publish internal stage keys").not.toContain(
      "in_progress",
    );
    await assertNoLeaks(body, seed, authorId);
  });

  test("asks for an address before it asks for anything else", async ({
    request,
  }) => {
    // No cookie and no email is the normal first visit, answered with what the
    // client should do rather than an error it has to interpret.
    const res = await request.post(
      `${BASE_URL}/api/portal/${slug}/ideas/${seed.visibleIdeaId}/vote`,
      {
        headers: { "content-type": "application/json", origin: BASE_URL },
        data: {},
      },
    );
    expect(await res.json()).toMatchObject({ ok: true, needsEmail: true });
  });
});

/**
 * The origin rule, asserted where it actually runs.
 *
 * `lib/portal/intake-csrf.test.ts` asserts the predicate and the absence of an
 * exemption. This asserts the COMPOSITION of middleware and route, which is the
 * lesson of #460: that outage happened while `csrf-origin.test.ts` passed
 * throughout, because the predicate was right and the wiring was not.
 */
test.describe("the portal's origin rule", () => {
  test("accepts the portal's own origin and refuses a foreign one", async ({
    request,
  }) => {
    const { slug, id } = await getWorkspace();
    const authorId = await getAdminUserId();
    await resetIdeas(id);
    await resetBoard(id);
    await resetReleases(id);
    await seedPortalFixture({ workspaceId: id, authorId });
    try {
      const post = (origin: string) =>
        request.post(`${BASE_URL}/api/portal/${slug}/ideas`, {
          headers: { "content-type": "application/json", origin },
          data: { title: "Origin probe", email: "probe@example.com" },
          failOnStatusCode: false,
        });

      // Same origin: the real request the portal form makes.
      expect((await post(BASE_URL)).status()).toBe(200);
      // Foreign origin: refused by the middleware, before the route runs.
      expect((await post("https://evil.example")).status()).toBe(403);
      // A sandboxed iframe or a redirected POST sends the literal "null".
      expect((await post("null")).status()).toBe(403);
    } finally {
      // The fixture creates products, features and a release as well as ideas,
      // and `product-groups.spec.ts` deletes products in its own setup. A
      // feature left pointing at one of ours fails that spec on a foreign key,
      // several files away from the cause. Order matters: features first.
      await resetIdeas(id);
      await resetBoard(id);
      await resetReleases(id);
      await resetPortalProducts(id);
    }
  });

  test("cannot post to an authenticated write route from a portal page", async ({
    request,
  }) => {
    // The guard on the whole reason no exemption was added. A portal endpoint
    // being same-origin must not have made the app's authenticated writes
    // reachable from anywhere new.
    const res = await request.post(`${BASE_URL}/api/v1/ideas`, {
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      data: { title: "Should never be created" },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(403);
  });
});
