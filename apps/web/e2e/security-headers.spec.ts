import { expect, test } from "@playwright/test";

/**
 * The production Content-Security-Policy must contain script injection: a
 * per-request nonce, `strict-dynamic`, and NO `'unsafe-inline'` in script-src
 * (docs/archive/security-fixes.md, P2 "strengthen browser XSS containment"). The E2E
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
});
