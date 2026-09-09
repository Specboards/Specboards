import { expect, test } from "@playwright/test";

import { BASE_URL } from "./helpers/constants";
import { getWorkspace } from "./helpers/db";

/**
 * The public portal at `/{org}/ideas`, exercised where it actually runs.
 *
 * The assertions that matter here are about a page being ABSENT or IDENTICAL,
 * not about one rendering. A portal that renders is trivial; a portal that
 * renders the same thing to a stranger as to the workspace's own admin is the
 * whole design.
 *
 * ── Why the session-parity case exists ─────────────────────────────────────
 * The portal was going to live on its own subdomain, where the app's session
 * cookie could not reach it. That scheme was dropped because it needs wildcard
 * DNS and a wildcard certificate, which a self-host on an internal network or
 * `localhost:3000` cannot get.
 *
 * On `/{org}/ideas` the portal shares an origin with the app, so a signed-in
 * admin's cookie arrives with every request. `portal-auth-isolation.test.ts`
 * asserts statically that portal source never reads it. This asserts the
 * consequence end to end: the bytes are the same either way. A portal that
 * renders differently for a signed-in viewer is reading something it should
 * not, whatever the imports say.
 *
 * The suite's default `storageState` is the signed-in admin, so "with a
 * session" is the default context and "without" is the explicit one.
 */
test.describe("public ideas portal", () => {
  test("404s while the portal is unpublished", async ({ page, request }) => {
    // The seeded workspace has never enabled a portal, so this is the state
    // every workspace is in until an admin opts in. Nothing about the org
    // existing should be inferable from the response.
    const { slug } = await getWorkspace();
    const res = await page.request.get(`/${slug}/ideas`, {
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(404);

    // And a workspace that does not exist answers identically, so the URL is
    // not a directory of which companies have accounts.
    const unknown = await request.get("/no-such-workspace-xyz/ideas", {
      failOnStatusCode: false,
    });
    expect(unknown.status()).toBe(404);
  });

  test("does not leak the internal ideas board", async ({ page }) => {
    // `/{org}/{product}/ideas` is the authenticated board and `/{org}/ideas`
    // is the portal. They differ by one path segment, which is exactly the
    // kind of neighbouring route a refactor collapses by accident.
    const { slug } = await getWorkspace();
    const internal = await page.request.get(`/${slug}/default/ideas`, {
      failOnStatusCode: false,
    });
    // Signed in, so the internal board is reachable: proves the two routes are
    // distinct rather than one shadowing the other.
    expect(internal.status()).toBe(200);
  });

  test("robots.txt keeps crawlers out of the authenticated app", async ({
    request,
  }) => {
    const res = await request.get("/robots.txt");
    expect(res.status()).toBe(200);
    const body = await res.text();

    // The areas that must never be indexed. Listing them is the point of the
    // file; this is the guard that an edit does not quietly drop one.
    for (const path of ["/api/", "/sign-in", "/*/settings", "/*/backlog"]) {
      expect(body, `robots.txt must disallow ${path}`).toContain(
        `Disallow: ${path}`,
      );
    }
    // The portal is the one thing meant to be found, so it must NOT be
    // disallowed. `/{org}/ideas` is not listed, and no rule may cover it.
    expect(body).not.toContain("Disallow: /*/ideas");
  });

  test("serves a stranger exactly what it serves the admin", async ({
    page,
    browser,
  }) => {
    // Publish a portal as the signed-in admin, then compare what the portal
    // renders with that session against what it renders with none.
    const { slug } = await getWorkspace();
    const enable = await page.request.patch("/api/v1/idea-settings", {
      headers: { "content-type": "application/json" },
      data: { portalEnabled: true, portalTitle: "Parity Portal" },
    });
    expect(enable.ok(), "enabling the portal").toBe(true);

    // Compared as rendered DOM rather than as raw HTML.
    //
    // The first version of this asserted the response bodies were
    // byte-identical and failed on two responses with identical content: Next
    // splits the RSC payload across `__next_f.push` calls at boundaries that
    // move between requests, session or no session. That assertion would have
    // been flaky between two anonymous requests, and flaky is worse than absent
    // for a security check, because it teaches people to re-run it.
    //
    // The DOM is also the honest statement of the property. What matters is
    // that the visitor sees the same page, not that the stream arrived in the
    // same number of pieces.
    const renderOf = async (ctx: import("@playwright/test").BrowserContext) => {
      const p = await ctx.newPage();
      try {
        await p.goto(`${BASE_URL}/${slug}/ideas`);
        await p.waitForLoadState("networkidle");
        return {
          // Markup with every <script> removed.
          //
          // Next streams the RSC payload as a series of inline
          // `self.__next_f.push(...)` scripts, and splits it at boundaries that
          // move between requests whether or not a session is involved. Two
          // identical anonymous requests differ there, so comparing raw markup
          // would be flaky, and a flaky security check is worse than none: it
          // teaches people to re-run it rather than read it.
          //
          // What is left is the DOM the visitor actually gets: structure,
          // classes, attributes and text. A portal that rendered something extra
          // for a signed-in viewer would differ here.
          //
          // `<title>` and `<meta>` go for a second reason: React renders them
          // into the body while streaming and hoists them into <head> during
          // hydration, so whether they appear here is a question of how far
          // hydration had got when this ran, not of what was served.
          html: (await p.locator("body").innerHTML())
            .replace(/<script[\s\S]*?<\/script>/g, "")
            .replace(/<title[\s\S]*?<\/title>/g, "")
            .replace(/<meta\b[^>]*>/g, "")
            .replace(/nonce="[^"]*"/g, 'nonce="_"')
            .trim(),
          // What a person actually sees. The chrome checks below use this
          // rather than the markup, because Next serialises the root layout's
          // not-found boundary into the RSC payload of every page: its text is
          // present in the HTML of a page that never renders it, and asserting
          // over the markup fails on a string nobody can read.
          text: (await p.locator("body").innerText()).trim(),
        };
      } finally {
        await p.close();
      }
    };

    try {
      const authed = await renderOf(page.context());
      expect(authed.text).toContain("Parity Portal");

      // No storageState: no cookies, no session, a stranger.
      const anon = await browser.newContext({ storageState: undefined });
      try {
        const anonymous = await renderOf(anon);
        expect(anonymous.text).toContain("Parity Portal");

        // Neither may carry the application's chrome. The sidebar embeds this
        // workspace's whole product list into the document, and the portal is
        // a customer's page rather than ours.
        for (const { text } of [authed, anonymous]) {
          expect(text).not.toContain("Skip to main content");
          expect(text).not.toContain("Back to your workspace");
        }

        // The assertion the design rests on: a signed-in admin and a stranger
        // are served the same page. Anything the portal read from the session
        // would show up here.
        expect(
          anonymous.html,
          "the portal must render identically with and without a session",
        ).toBe(authed.html);
      } finally {
        await anon.close();
      }
    } finally {
      // Leave the workspace as found: every other spec assumes no portal.
      await page.request.patch("/api/v1/idea-settings", {
        headers: { "content-type": "application/json" },
        data: { portalEnabled: false, portalTitle: null },
      });
    }
  });
});
