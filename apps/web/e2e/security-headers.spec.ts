import { expect, test } from "@playwright/test";

/**
 * The production Content-Security-Policy must contain script injection: a
 * per-request nonce, `strict-dynamic`, and NO `'unsafe-inline'` in script-src
 * (docs/security-fixes.md, P2 "strengthen browser XSS containment"). The E2E
 * server runs a production build, so this asserts the shipped policy.
 */
test.describe("security headers", () => {
  test("CSP is nonce-based with no unsafe-inline script-src", async ({ page }) => {
    const res = await page.request.get("/sign-in");
    const csp = res.headers()["content-security-policy"] ?? "";
    expect(csp).not.toBe("");

    const scriptSrc = csp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("script-src"));
    expect(scriptSrc, "script-src directive present").toBeTruthy();
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).toMatch(/'nonce-[^']+'/);
    expect(scriptSrc).toContain("'strict-dynamic'");
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
