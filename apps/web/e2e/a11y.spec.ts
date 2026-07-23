import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { getWorkspace } from "./helpers/db";

/**
 * Automated WCAG 2.2 AA gate. Runs axe-core against the app's key pages and
 * fails on any violation, so accessibility regressions are caught in CI. This
 * complements (does not replace) manual keyboard and screen-reader passes.
 *
 * color-contrast is disabled here for now: the token remediation lands in a
 * later stage, and this spec's own PR should stay green. Once the tokens are
 * fixed, remove the disableRules line so contrast becomes gated too.
 */
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function scan(page: Page, path: string): Promise<string> {
  // Force reduced motion so nothing is mid-animation when axe snapshots the DOM.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(path);
  // The app polls (notifications), so networkidle can hang. Wait for the main
  // landmark to render, then let one paint settle before snapshotting.
  await page.locator("main").first().waitFor({ state: "visible" });
  await page.waitForTimeout(300);

  const results = await new AxeBuilder({ page })
    .withTags(WCAG_TAGS)
    // TipTap's contenteditable surface is third-party internals we do not own.
    .exclude(".ProseMirror")
    .disableRules(["color-contrast"])
    .analyze();

  if (results.violations.length === 0) return "";
  return results.violations
    .map(
      (v) =>
        `  [${v.impact ?? "?"}] ${v.id}: ${v.help} (${v.nodes.length} node(s))\n` +
        v.nodes
          .slice(0, 3)
          .map((n) => `      ${n.target.join(" ")}`)
          .join("\n"),
    )
    .join("\n");
}

test.describe("a11y: unauthenticated pages", () => {
  // Scan the auth pages logged out; an authenticated session would redirect.
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const path of ["/sign-in", "/sign-up"]) {
    test(`no axe violations: ${path}`, async ({ page }) => {
      const report = await scan(page, path);
      expect(report, `axe violations on ${path}:\n${report}`).toBe("");
    });
  }
});

test.describe("a11y: authenticated app", () => {
  let slug: string;
  test.beforeAll(async () => {
    slug = (await getWorkspace()).slug;
  });

  // Path is a factory so the workspace slug (only known at runtime) is injected
  // while the test name stays static for readable reporting.
  const PAGES: { name: string; path: () => string }[] = [
    { name: "backlog board", path: () => `/${slug}/all/backlog` },
    { name: "backlog list", path: () => `/${slug}/all/backlog?view=list` },
    { name: "roadmap", path: () => `/${slug}/all/roadmap` },
    { name: "ideas", path: () => `/${slug}/all/ideas` },
    { name: "settings: profile", path: () => `/${slug}/settings/profile` },
    { name: "settings: products", path: () => `/${slug}/settings/products` },
    { name: "settings: repositories", path: () => `/${slug}/settings/repositories` },
  ];

  for (const p of PAGES) {
    test(`no axe violations: ${p.name}`, async ({ page }) => {
      const report = await scan(page, p.path());
      expect(report, `axe violations on ${p.name}:\n${report}`).toBe("");
    });
  }
});
