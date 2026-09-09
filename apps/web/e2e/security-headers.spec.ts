import { expect, test } from "@playwright/test";

import { getWorkspace } from "./helpers/db";

/**
 * The production Content-Security-Policy must contain script injection: a
 * per-request nonce, `strict-dynamic`, and NO `'unsafe-inline'` in script-src
 * (docs/security-review-2026-07.md, P2 "strengthen browser XSS containment"). The E2E
 * server runs a production build, so this asserts the shipped policy.
 */
test.describe("security headers", () => {
  test("CSP is nonce-based with no unsafe-inline script-src", async ({ page }) => {
    const res = await page.request.get("/sign-in");
    const csp = res.headers()["content-security-policy"] ?? "";
    expect(csp).not.toBe("");

    const directive = (name: string) =>
      csp
        .split(";")
        .map((d) => d.trim())
        // Match the exact directive name, so `style-src` does not also match
        // `style-src-attr`.
        .find((d) => d === name || d.startsWith(`${name} `));

    const scriptSrc = directive("script-src");
    expect(scriptSrc, "script-src directive present").toBeTruthy();
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).toMatch(/'nonce-[^']+'/);
    expect(scriptSrc).toContain("'strict-dynamic'");
    // `next dev` adds 'unsafe-eval' so React Refresh can run (without it the
    // bootstrap dies and nothing hydrates). This is the guard that it never
    // rides along into a build.
    expect(scriptSrc).not.toContain("'unsafe-eval'");

    // The dev HMR websocket is likewise development-only.
    const connectSrc = directive("connect-src");
    expect(connectSrc, "connect-src directive present").toBeTruthy();
    expect(connectSrc).toBe("connect-src 'self'");

    // style-src (the element directive) must also be free of 'unsafe-inline':
    // an injected <style> block is refused. Inline style="..." attributes stay
    // allowed through the narrower style-src-attr, which is expected.
    const styleSrc = directive("style-src");
    expect(styleSrc, "style-src directive present").toBeTruthy();
    expect(styleSrc).not.toContain("'unsafe-inline'");
    expect(styleSrc).toMatch(/'nonce-[^']+'/);

    const styleSrcAttr = directive("style-src-attr");
    expect(styleSrcAttr, "style-src-attr directive present").toBeTruthy();
    expect(styleSrcAttr).toContain("'unsafe-inline'");
  });

  test("each response carries a fresh nonce", async ({ page }) => {
    const nonceOf = async () => {
      const res = await page.request.get("/sign-in");
      const csp = res.headers()["content-security-policy"] ?? "";
      return csp.match(/'nonce-([^']+)'/)?.[1];
    };
    const a = await nonceOf();
    const b = await nonceOf();
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
  });

  /**
   * The header is not the policy; the page is.
   *
   * Everything above asserts the CSP *string*, and a build that emits a perfect
   * header and zero nonce attributes satisfies all of it while being completely
   * non-interactive: with `strict-dynamic` and no `'unsafe-inline'`, a script
   * tag missing its nonce is simply refused. That is the shape of
   * vercel/next.js#96063, which we dodge by building with `--webpack`, but the
   * blind spot is general and would not warn us about the next regression
   * either. These two tests close it by looking at what the browser received.
   */
  test("every script tag in the document carries the nonce from the header", async ({
    page,
  }) => {
    const res = await page.request.get("/sign-in");
    const nonce = (res.headers()["content-security-policy"] ?? "").match(
      /script-src[^;]*'nonce-([^']+)'/,
    )?.[1];
    expect(nonce, "a script-src nonce in the header").toBeTruthy();

    const html = await res.text();
    // Every <script> that carries code has to be nonced. `src`-less and
    // `src`-ful alike: strict-dynamic refuses both without one.
    const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]!);
    expect(scripts.length, "the page ships script tags at all").toBeGreaterThan(0);

    const unnonced = scripts.filter((attrs) => !attrs.includes(`nonce="${nonce}"`));
    expect(
      unnonced,
      `every <script> must carry nonce="${nonce}"; these did not`,
    ).toEqual([]);
  });

  /**
   * `form-action 'self'` is right for every route but one. The GitHub App
   * manifest flow has to POST the App definition to github.com, and a blanket
   * `'self'` refuses that navigation outright, which was half of why the
   * self-host GitHub connection dead-ended on a blank page (the other half was
   * the refused inline script, covered by `lib/github-manifest-form.test.ts`).
   *
   * The widening is scoped to the one path and to github.com, so these two
   * assertions are a pair: the exception exists, and it has not leaked.
   */
  test("form-action permits github.com on the manifest route only", async ({ page }) => {
    const formAction = async (path: string) => {
      const res = await page.request.get(path, { maxRedirects: 0 });
      const csp = res.headers()["content-security-policy"] ?? "";
      return csp
        .split(";")
        .map((d) => d.trim())
        .find((d) => d === "form-action" || d.startsWith("form-action "));
    };

    expect(await formAction("/api/v1/github/app/create")).toBe(
      "form-action 'self' https://github.com",
    );
    expect(await formAction("/sign-in")).toBe("form-action 'self'");
  });

  test("the page hydrates under the nonce policy", async ({ page }) => {
    // The assertion above proves the tags are nonced; this proves the browser
    // accepted them and React came alive. A silently dead bundle fails here
    // rather than in production, which is the whole point of the pair.
    const violations: string[] = [];
    page.on("console", (msg) => {
      const text = msg.text();
      if (/Content Security Policy|Refused to (execute|apply|load)/i.test(text)) {
        violations.push(text);
      }
    });

    await page.goto("/sign-in");
    // An interaction that can only work post-hydration: React must have
    // attached handlers for a controlled input to hold what is typed.
    const email = page.getByLabel(/email/i).first();
    await email.waitFor({ state: "visible" });
    await email.fill("hydration@probe.test");
    await expect(email).toHaveValue("hydration@probe.test");

    expect(violations, "no CSP violations logged while loading").toEqual([]);
  });

  test("a 404 renders our own page rather than Next's un-nonced fallback", async ({
    page,
  }) => {
    // Next's built-in not-found (and its error boundary) style themselves with
    // an inline <style> that carries no nonce, so `style-src` refuses it: the
    // reader gets an unstyled page and a CSP error on top of whatever went
    // wrong. app/not-found.tsx and app/error.tsx exist to keep those fallbacks
    // off the screen.
    const violations: string[] = [];
    page.on("console", (msg) => {
      const text = msg.text();
      if (/Content Security Policy|Refused to (execute|apply|load)/i.test(text)) {
        violations.push(text);
      }
    });

    const { slug } = await getWorkspace();
    await page.goto(
      `/${slug}/all/backlog/feature/00000000-0000-0000-0000-000000000000`,
    );

    await expect(
      page.getByText("We could not find that page"),
    ).toBeVisible();
    expect(
      await page.locator("style").count(),
      "no inline <style> to be refused",
    ).toBe(0);
    expect(violations, "no CSP violations logged on a 404").toEqual([]);
  });

  test("the rich-text editor's runtime styles carry the nonce", async ({
    page,
  }) => {
    // TipTap appends ProseMirror's base rules as a `<style>` through plain DOM
    // calls, which webpack's runtime nonce does not reach. Unlabelled it was
    // refused, so the editor lost `white-space: pre-wrap` and the rest of the
    // ProseMirror baseline while looking almost right.
    const violations: string[] = [];
    page.on("console", (msg) => {
      const text = msg.text();
      if (/Content Security Policy|Refused to (execute|apply|load)/i.test(text)) {
        violations.push(text);
      }
    });

    const { slug } = await getWorkspace();
    await page.goto(`/${slug}/all/roadmap`);
    await page.getByRole("button", { name: "New feature" }).click();
    await expect(page.locator(".tiptap")).toBeVisible();

    // The attribute is hidden by the browser once applied; the property is not.
    const unnonced = await page.evaluate(() =>
      [...document.querySelectorAll("style")].filter((s) => !s.nonce).length,
    );
    expect(unnonced, "every runtime <style> carries a nonce").toBe(0);
    expect(violations, "no CSP violations logged with an editor open").toEqual(
      [],
    );
  });

  /**
   * The cross-site origin check, exercised where it actually runs.
   *
   * `lib/csrf-origin.test.ts` pins the rule as a function, and it passed
   * throughout the outage it should have caught: the marketing site's "Request
   * access" form was refused with 403 for months because the composition of
   * middleware and route was never tested, only the predicate. The endpoint was
   * built with a CORS allowlist that read as authoritative, and its preflight
   * succeeded (OPTIONS is not a mutating method), so nothing looked wrong until
   * a real POST was tried.
   *
   * So these two assertions belong at this level and belong together: the
   * public intake admits the marketing origin, and the authenticated write
   * surface still refuses it. One without the other is how the bug happened and
   * how a careless fix for it would go unnoticed.
   */
  test("the origin check admits the public intake and still refuses the authenticated surface", async ({
    page,
  }) => {
    const MARKETING = "https://www.specboards.ai";

    const intake = await page.request.post("/api/access-request", {
      headers: { "content-type": "application/json", origin: MARKETING },
      data: {},
      failOnStatusCode: false,
    });
    // Not 403 is the assertion. 400 is the route itself answering, which is the
    // proof that middleware let the request reach it; the body is validated by
    // the route's own tests, not here.
    expect(
      intake.status(),
      "the marketing origin reaches the access-request route",
    ).not.toBe(403);
    expect(intake.status()).toBe(400);

    const authenticated = await page.request.post("/api/v1/ideas", {
      headers: { "content-type": "application/json", origin: MARKETING },
      data: { title: "cross-site" },
      failOnStatusCode: false,
    });
    expect(
      authenticated.status(),
      "the marketing origin is refused by the mutating /api/v1 surface",
    ).toBe(403);
    // Assert which 403. The request context here carries a session, so a
    // regression that let it through would create an idea rather than fail an
    // authorization check, and a 403 from somewhere else would pass this test
    // while the guard was gone.
    expect(await authenticated.text()).toContain("came from another site");
  });
});
