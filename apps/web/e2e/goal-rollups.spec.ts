import { expect, test } from "@playwright/test";

import { getWorkspace, resetGoals } from "./helpers/db";

/**
 * Where a goal shows up once it exists: the portfolio dashboard, and the goal
 * reading of the roadmap timeline.
 *
 * Both are roll-ups of the same two figures the Goals page keeps apart, so what
 * is worth asserting end to end is that they stay apart here too, and that a
 * goal with nothing to draw is surfaced rather than dropped.
 */
test.describe("goal roll-ups", () => {
  test.beforeEach(async () => {
    const ws = await getWorkspace();
    await resetGoals(ws.id);
  });

  /** Create a goal through the UI, optionally with a measurement period. */
  async function createGoal(
    page: import("@playwright/test").Page,
    slug: string,
    title: string,
    period?: { start: string; end: string },
  ): Promise<void> {
    await page.goto(`/${slug}/all/goals`);
    await page.getByRole("button", { name: "New goal" }).first().click();
    await page.getByLabel("Title").fill(title);
    if (period) {
      await page.getByLabel("Period start").fill(period.start);
      await page.getByLabel("Period end").fill(period.end);
    }
    await page.getByRole("button", { name: "Create goal" }).click();
    await expect(page.getByText(title).first()).toBeVisible();
  }

  test("reports both goal figures on the portfolio dashboard", async ({
    page,
  }) => {
    const ws = await getWorkspace();
    await createGoal(page, ws.slug, "Adoption grows", {
      start: "2026-01-01",
      end: "2026-12-31",
    });

    await page.goto(`/${ws.slug}/dashboard`);
    await expect(page.getByRole("heading", { name: "Goals" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Adoption grows" })).toBeVisible();
    // The same two labelled figures as the Goals page, still not merged.
    await expect(page.getByText("Outcome", { exact: true })).toBeVisible();
    await expect(page.getByText("Delivery", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "All goals →" })).toBeVisible();
  });

  test("hides the dashboard's goals section when there are none", async ({
    page,
  }) => {
    const ws = await getWorkspace();
    await page.goto(`/${ws.slug}/dashboard`);
    await expect(page.getByRole("heading", { name: "Portfolio" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Goals" })).toHaveCount(0);
  });

  test("draws a goal swimlane on the timeline, and trays an undated goal", async ({
    page,
  }) => {
    const ws = await getWorkspace();
    await createGoal(page, ws.slug, "Dated objective", {
      start: "2026-01-01",
      end: "2026-06-30",
    });
    await createGoal(page, ws.slug, "Open-ended objective");

    await page.goto(`/${ws.slug}/all/roadmap?view=timeline`);
    await page.getByRole("link", { name: "By goal" }).click();
    await expect(page).toHaveURL(/rows=goals/);

    // Rows are goals now, so the gutter is headed by one.
    await expect(page.getByText("Goal", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Dated objective" }),
    ).toBeVisible();
    // The band fills with outcome; delivery is stated, never averaged in.
    await expect(page.getByText(/A goal band fills with its outcome/)).toBeVisible();

    // A goal with no period has nowhere to be drawn, and is named rather than
    // silently missing.
    await expect(page.getByText(/No period set \(1\)/)).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Open-ended objective" }),
    ).toBeVisible();
  });

  test("says so when no goal in scope has a period to draw", async ({ page }) => {
    const ws = await getWorkspace();
    await createGoal(page, ws.slug, "Open-ended objective");

    await page.goto(`/${ws.slug}/all/roadmap?view=timeline&rows=goals`);
    await expect(page.getByText("Nothing to plot yet")).toBeVisible();
    // The fix is to date a goal, not to write one.
    await expect(page.getByText(/None of the goals in scope has a start/)).toBeVisible();
  });

  test("still honours the old ?ladder=1 links", async ({ page }) => {
    const ws = await getWorkspace();
    await page.goto(`/${ws.slug}/all/roadmap?view=timeline&ladder=1`);
    await expect(
      page.getByRole("link", { name: "Laddered" }),
    ).toHaveAttribute("aria-current", "true");
  });
});
