import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { getWorkspace } from "./helpers/db";

/**
 * Automated WCAG 2.2 AA gate. Runs axe-core against the app's key pages and
 * fails on any violation, so accessibility regressions are caught in CI. This
 * complements (does not replace) manual keyboard and screen-reader passes.
 *
 * color-contrast is gated (the token remediation landed alongside this). A
 * subset of pages is also scanned in dark mode.
 */
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function scan(
  page: Page,
  path: string,
  opts: { dark?: boolean } = {},
): Promise<string> {
  // Force reduced motion so nothing is mid-animation when axe snapshots the DOM;
  // next-themes is on `system`, so emulating the color scheme flips the theme.
  await page.emulateMedia({
    reducedMotion: "reduce",
    colorScheme: opts.dark ? "dark" : "light",
  });
  await page.goto(path);
  // The app polls (notifications), so networkidle can hang. Wait for the main
  // landmark to render, then let one paint settle before snapshotting.
  await page.locator("main").first().waitFor({ state: "visible" });
  await page.waitForTimeout(300);

  const results = await new AxeBuilder({ page })
    .withTags(WCAG_TAGS)
    // TipTap's contenteditable surface is third-party internals we do not own.
    .exclude(".ProseMirror")
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
    {
      name: "roadmap timeline",
      path: () => `/${slug}/all/roadmap?view=timeline`,
    },
    {
      // The zoom control and the today marker's label only render on an axis, so
      // scan a non-default zoom to cover both.
      name: "roadmap timeline (weeks)",
      path: () => `/${slug}/all/roadmap?view=timeline&zoom=week`,
    },
    {
      // The laddered (portfolio) reading of the timeline: disclosures, progress
      // fills, and the dependency overlay.
      name: "roadmap timeline (laddered)",
      path: () => `/${slug}/all/roadmap?view=timeline&ladder=1`,
    },
    { name: "leadership dashboard", path: () => `/${slug}/dashboard` },
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

  // Dark mode exercises the second set of tokens; scan a representative few.
  const DARK_PAGES: { name: string; path: () => string }[] = [
    { name: "backlog board", path: () => `/${slug}/all/backlog` },
    { name: "backlog list", path: () => `/${slug}/all/backlog?view=list` },
    // The timeline draws bars from status colours against the grid, so it is
    // the view most likely to regress contrast in the second token set.
    {
      name: "roadmap timeline",
      path: () => `/${slug}/all/roadmap?view=timeline`,
    },
    { name: "settings: profile", path: () => `/${slug}/settings/profile` },
  ];

  for (const p of DARK_PAGES) {
    test(`no axe violations (dark): ${p.name}`, async ({ page }) => {
      const report = await scan(page, p.path(), { dark: true });
      expect(report, `dark-mode axe violations on ${p.name}:\n${report}`).toBe("");
    });
  }
});
