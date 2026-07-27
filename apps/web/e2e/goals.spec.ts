import { expect, test } from "@playwright/test";

import { getWorkspace, resetGoals } from "./helpers/db";

/**
 * Goals: objectives, their key results, and the work laddering up.
 *
 * The behaviour worth an end-to-end test is the one the whole feature exists
 * for: outcome progress and delivery progress are two separate numbers, and a
 * key result's progress is measured as distance travelled from its baseline
 * rather than distance to its target. Both are easy to "fix" into something
 * plausible and wrong, so they are asserted through the real UI.
 */
test.describe("goals", () => {
  test.beforeEach(async () => {
    const ws = await getWorkspace();
    await resetGoals(ws.id);
  });

  test("creates a goal, adds a key result, and measures from the baseline", async ({
    page,
  }) => {
    const ws = await getWorkspace();
    await page.goto(`/${ws.slug}/all/goals`);

    await expect(page.getByText("No goals yet")).toBeVisible();

    await page.getByRole("button", { name: "New goal" }).first().click();
    await page.getByLabel("Title").fill("Teams plan weekly");
    await page.getByLabel("Period start").fill("2026-01-01");
    await page.getByLabel("Period end").fill("2026-03-31");
    await page.getByRole("button", { name: "Create goal" }).click();

    await expect(page.getByText("Teams plan weekly")).toBeVisible();
    // No key results yet: the outcome reads as unmeasured, not 0%.
    await expect(page.getByText("No key results yet")).toBeVisible();

    // A metric that starts at 40 and targets 60, currently sitting at its
    // baseline. Naive current/target arithmetic would call this 67%.
    await page.getByRole("button", { name: "Add key result" }).click();
    await page.getByRole("textbox", { name: "Key result" }).fill("Weekly actives");
    await page.getByRole("spinbutton", { name: "From" }).fill("40");
    await page.getByRole("spinbutton", { name: "To" }).fill("60");
    await page.getByRole("button", { name: "Add key result", exact: true }).last().click();

    await expect(page.getByText("Weekly actives")).toBeVisible();
    // Nothing has been achieved, so 0%.
    await expect(page.getByText("0%").first()).toBeVisible();

    // Move it halfway and the figure follows, recomputed rather than stored.
    const current = page.getByLabel("Current value for Weekly actives");
    await current.fill("50");
    await current.blur();
    await expect(page.getByText("50%").first()).toBeVisible();
  });

  test("rejects a key result whose target equals its baseline", async ({
    page,
  }) => {
    const ws = await getWorkspace();
    await page.goto(`/${ws.slug}/all/goals`);

    await page.getByRole("button", { name: "New goal" }).first().click();
    await page.getByLabel("Title").fill("Degenerate measure");
    await page.getByRole("button", { name: "Create goal" }).click();

    await page.getByRole("button", { name: "Add key result" }).click();
    await page.getByRole("textbox", { name: "Key result" }).fill("Nowhere");
    await page.getByRole("spinbutton", { name: "From" }).fill("5");
    await page.getByRole("spinbutton", { name: "To" }).fill("5");
    await page.getByRole("button", { name: "Add key result", exact: true }).last().click();

    await expect(page.getByText(/target must differ/i)).toBeVisible();
  });

  test("keeps outcome and delivery progress as separate figures", async ({
    page,
  }) => {
    const ws = await getWorkspace();
    await page.goto(`/${ws.slug}/all/goals`);

    await page.getByRole("button", { name: "New goal" }).first().click();
    await page.getByLabel("Title").fill("Shipped but unmoved");
    await page.getByRole("button", { name: "Create goal" }).click();

    // Both readouts render, labelled, side by side. Neither is folded into the
    // other: a goal where everything shipped and no metric moved is exactly
    // what the two-number layout exists to reveal.
    await expect(page.getByText("Outcome", { exact: true })).toBeVisible();
    await expect(page.getByText("Delivery", { exact: true })).toBeVisible();
    await expect(page.getByText("No key results yet")).toBeVisible();
    await expect(page.getByText("No work linked yet")).toBeVisible();
  });

  test("nests a child goal under its parent instead of listing it flat", async ({
    page,
  }) => {
    const ws = await getWorkspace();
    await page.goto(`/${ws.slug}/all/goals`);

    await page.getByRole("button", { name: "New goal" }).first().click();
    await page.getByLabel("Title").fill("Company objective");
    await page.getByRole("button", { name: "Create goal" }).click();
    await expect(page.getByText("Company objective")).toBeVisible();

    // "Sits under" only appears once there is another goal to sit under.
    await page.getByRole("button", { name: "New goal" }).first().click();
    await page.getByLabel("Title").fill("Product objective");
    await page.getByLabel("Sits under").selectOption({ label: "Company objective" });
    await page.getByRole("button", { name: "Create goal" }).click();

    const child = page
      .getByRole("heading", { name: "Product objective" })
      // The card, its indent wrapper, and the rule that carries the ladder.
      .locator("xpath=ancestor::div[contains(@class,'border-l-2')][1]");
    await expect(child).toBeVisible();
    // Nesting says who the parent is, so the card does not repeat it in words.
    await expect(page.getByText("under Company objective")).toHaveCount(0);
  });

  test("rejects a period that ends before it starts", async ({ page }) => {
    const ws = await getWorkspace();
    await page.goto(`/${ws.slug}/all/goals`);

    await page.getByRole("button", { name: "New goal" }).first().click();
    await page.getByLabel("Title").fill("Backwards");
    await page.getByLabel("Period start").fill("2026-12-31");
    await page.getByLabel("Period end").fill("2026-01-01");
    await page.getByRole("button", { name: "Create goal" }).click();

    await expect(page.getByText(/cannot end before it starts/i)).toBeVisible();
  });
});
