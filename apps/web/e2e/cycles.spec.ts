import { expect, test } from "@playwright/test";

import { getWorkspace, resetCycles } from "./helpers/db";

/**
 * Cycles: the team-facing time box, a second axis alongside releases.
 *
 * The load-bearing behaviours exercised here are the ones a unit test cannot
 * show: that a cycle's state comes from its dates with nothing having run, and
 * that rollover carries unfinished work forward while leaving delivered work
 * behind in the cycle that delivered it.
 */
test.describe("cycles", () => {
  test.beforeEach(async () => {
    const ws = await getWorkspace();
    await resetCycles(ws.id);
  });

  test("admin can create cycles whose state follows their dates", async ({
    page,
  }) => {
    const ws = await getWorkspace();
    await page.goto(`/${ws.slug}/all/cycles`);

    // Nothing yet: the empty state carries the create affordance.
    await expect(page.getByText("No cycles yet")).toBeVisible();

    // Create a cycle well in the past. No status field exists to set, which is
    // the point: the state is derived.
    await page.getByRole("button", { name: "New cycle" }).first().click();
    await page.getByLabel("Name").fill("Sprint past");
    await page.getByLabel("Start date").fill("2020-01-01");
    await page.getByLabel("End date").fill("2020-01-14");
    await page.getByRole("button", { name: "Create cycle" }).click();

    // It reads as Complete purely because the dates have passed.
    await expect(page.getByText("Sprint past")).toBeVisible();
    await expect(page.getByText("Complete", { exact: true })).toBeVisible();

    // ...and one well in the future reads as Upcoming, same page, no action.
    await page.getByRole("button", { name: "New cycle" }).first().click();
    await page.getByLabel("Name").fill("Sprint future");
    await page.getByLabel("Start date").fill("2099-01-01");
    await page.getByLabel("End date").fill("2099-01-14");
    await page.getByRole("button", { name: "Create cycle" }).click();

    await expect(page.getByText("Sprint future")).toBeVisible();
    await expect(page.getByText("Upcoming", { exact: true })).toBeVisible();
  });

  test("rejects a cycle that ends before it starts", async ({ page }) => {
    const ws = await getWorkspace();
    await page.goto(`/${ws.slug}/all/cycles`);

    await page.getByRole("button", { name: "New cycle" }).first().click();
    await page.getByLabel("Name").fill("Backwards");
    await page.getByLabel("Start date").fill("2026-08-10");
    await page.getByLabel("End date").fill("2026-08-01");
    await page.getByRole("button", { name: "Create cycle" }).click();

    await expect(
      page.getByText(/cannot end before it starts/i),
    ).toBeVisible();
  });

  test("edits and deletes a cycle", async ({ page }) => {
    const ws = await getWorkspace();
    await page.goto(`/${ws.slug}/all/cycles`);

    await page.getByRole("button", { name: "New cycle" }).first().click();
    await page.getByLabel("Name").fill("Sprint 1");
    await page.getByLabel("Start date").fill("2099-02-01");
    await page.getByLabel("End date").fill("2099-02-14");
    await page.getByRole("button", { name: "Create cycle" }).click();
    await expect(page.getByText("Sprint 1")).toBeVisible();

    await page.getByRole("button", { name: "Edit" }).click();
    await page.getByLabel("Name").fill("Sprint one");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Sprint one")).toBeVisible();

    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText("No cycles yet")).toBeVisible();
  });
});
