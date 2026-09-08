import { expect, test, type Page } from "@playwright/test";

import {
  assignWithoutWatching,
  getWorkspace,
  resetBoard,
  resetWatchers,
} from "./helpers/db";

/**
 * Watching an item, through the browser.
 *
 * The recipient behaviour is pinned in the integration suite, which can run
 * the relay and read inboxes. What is only checkable here is what the control
 * says, and the thing worth checking is that it accounts for itself: being
 * assigned an item follows it without anybody choosing to, so a reader can
 * arrive at a control reading "Unwatch" about a decision they never made. A
 * state you did not set and cannot explain reads as the product acting behind
 * your back.
 */

/** Create a DB-native card on the roadmap and open its detail flyout. */
async function newFeatureAndOpen(page: Page, ws: { slug: string }, title: string) {
  await page.goto(`/${ws.slug}/all/roadmap`);
  await page.getByRole("button", { name: "New feature" }).click();
  await page.getByLabel("Title").fill(title);
  const [res] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/features") && r.request().method() === "POST",
    ),
    page.getByRole("button", { name: "Create feature" }).click(),
  ]);
  const { feature } = (await res.json()) as { feature: { specId: string } };
  const specId = feature.specId;
  await page.getByRole("button", { name: title, exact: true }).click();
  return specId;
}

test.describe("watching an item", () => {
  test("auto-watches whoever created the item, and lets them leave for good", async ({
    page,
  }) => {
    const ws = await getWorkspace();
    await resetBoard(ws.id);
    await resetWatchers(ws.id);
    await newFeatureAndOpen(page, ws, "Checkout flow");

    // Creating an item is one of the actions that says you expect to hear what
    // happens to it, so the row is already there. Named, not just counted, and
    // in the open rather than behind a hover.
    await expect(
      page.getByRole("button", { name: "Unwatch", exact: true }),
    ).toBeVisible();
    await expect(page.getByText(/1 watcher: E2E Admin/)).toBeVisible();

    await page.getByRole("button", { name: "Unwatch", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Watch", exact: true }),
    ).toBeVisible();
    await expect(page.getByText(/watcher/)).toHaveCount(0);

    // The click is the save, and leaving sticks. Auto-watch that could not be
    // left would be noise with extra steps, so a row saying no has to survive
    // a fresh read.
    await page.reload();
    await page.getByRole("button", { name: "Checkout flow", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Watch", exact: true }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Watch", exact: true }).click();
    await expect(page.getByText("You are watching this item.")).toBeVisible();
  });

  test("says when you follow an item only because it is yours", async ({
    page,
  }) => {
    const ws = await getWorkspace();
    await resetBoard(ws.id);
    const specId = await newFeatureAndOpen(page, ws, "Refunds");

    // Assigned, with nothing recorded about watching it: what an item assigned
    // before this feature existed looks like, and the case worth pinning here.
    await assignWithoutWatching(ws.id, specId);
    await page.reload();
    await page.getByRole("button", { name: "Refunds", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Unwatch", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(/You follow this because it is assigned to you/),
    ).toBeVisible();

    // Leaving does not give the work away. That is the whole point: it is the
    // only per-item lever there is, because the preference grid is per event
    // type and cannot say "this one item is too noisy".
    await page.getByRole("button", { name: "Unwatch", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Watch", exact: true }),
    ).toBeVisible();
    await expect(page.locator('select[name="assigneeId"]')).not.toHaveValue("");
  });
});
