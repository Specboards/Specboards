import { expect, test } from "@playwright/test";

import {
  getWorkspace,
  resetBoard,
  resetNotifications,
  seedNotifications,
} from "./helpers/db";

/**
 * The notification centre, end to end.
 *
 * The bell panel was the only place a notification surfaced, which was fine
 * while a mention was the only thing that could land there and useless once
 * every assignment and status change does. What is asserted here is the three
 * things that panel could not do: group several notices about one item into one
 * block, narrow the list down, and put something back on the pile.
 *
 * Rows are seeded rather than produced through the app, because the fan-out
 * never notifies you about your own action and this suite signs in as one
 * person. Who receives what is pinned precisely in the fan-out's own
 * integration suite.
 */

/** Create a DB-native card through the UI and return its stable spec id. */
async function newFeature(
  page: import("@playwright/test").Page,
  ws: { slug: string },
  title: string,
) {
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
  const body = (await res.json()) as { feature: { specId: string } };
  return body.feature.specId;
}

test.describe("notification centre", () => {
  test("groups by item, filters, and lets a row be put back", async ({
    page,
  }) => {
    const ws = await getWorkspace();
    await resetBoard(ws.id);
    await resetNotifications(ws.id);

    const checkout = await newFeature(page, ws, "Checkout flow");
    const refunds = await newFeature(page, ws, "Refunds");

    await seedNotifications(ws.id, [
      {
        specId: checkout,
        type: "item.assigned",
        snippet: "Checkout flow was assigned to you.",
      },
      {
        specId: checkout,
        type: "item.status_changed",
        snippet: "Checkout flow moved to defining.",
      },
      {
        specId: checkout,
        type: "comment.mentioned",
        snippet: "Can you look at this?",
      },
      {
        specId: refunds,
        type: "item.assigned",
        snippet: "Refunds was assigned to you.",
        read: true,
      },
    ]);

    await page.goto(`/${ws.slug}/notifications`);

    // Three notices about one item read as one block, not three rows. Ten
    // changes to one card is the case that makes an ungrouped list unusable.
    const checkoutBlock = page
      .locator("li")
      .filter({ hasText: "Checkout flow" })
      .first();
    await expect(checkoutBlock.getByText("assigned you an item")).toBeVisible();
    await expect(checkoutBlock.getByText("moved an item")).toBeVisible();
    await expect(checkoutBlock.getByText("mentioned you")).toBeVisible();

    // The unread total is the whole inbox: three of the four.
    await expect(page.getByText("3 unread across your work.")).toBeVisible();

    // Unread only: the read Refunds notice drops out.
    await page.getByRole("button", { name: "Unread", exact: true }).click();
    await expect(page.getByText("Refunds was assigned to you.")).toBeHidden();
    await expect(
      page.getByText("Checkout flow was assigned to you."),
    ).toBeVisible();
    // The badge still counts the whole inbox, not the filtered view.
    await expect(page.getByText("3 unread across your work.")).toBeVisible();

    // Back to everything, then narrow by type instead.
    await page.getByRole("button", { name: "All", exact: true }).click();
    await page.getByLabel("Filter by type").selectOption("comment.mentioned");
    await expect(page.getByText("Can you look at this?")).toBeVisible();
    await expect(
      page.getByText("Checkout flow moved to defining."),
    ).toBeHidden();

    await page.getByLabel("Filter by type").selectOption("");
    await expect(
      page.getByText("Checkout flow moved to defining."),
    ).toBeVisible();

    // Putting one back is the gesture the bell has no room for: a row opened by
    // accident, or read at a moment it could not be acted on.
    const refundsRow = page
      .locator("li")
      .filter({ hasText: "Refunds was assigned to you." })
      .last();
    await refundsRow.getByRole("button", { name: "Mark unread" }).click();
    await expect(page.getByText("4 unread across your work.")).toBeVisible();

    // And clearing the lot leaves the page saying so rather than looking broken.
    await page.getByRole("button", { name: "Mark all read" }).click();
    await expect(page.getByText("You are up to date.")).toBeVisible();
  });

  test("says there is nothing rather than showing an empty list", async ({
    page,
  }) => {
    const ws = await getWorkspace();
    await resetNotifications(ws.id);
    await page.goto(`/${ws.slug}/notifications`);
    await expect(page.getByText(/Nothing yet/)).toBeVisible();
  });

  test("the bell links through to it", async ({ page }) => {
    // The panel is a summary now, so the way to the whole thing has to be there.
    const ws = await getWorkspace();
    await page.goto(`/${ws.slug}/all/backlog`);
    await page.getByRole("button", { name: /^Notifications/ }).click();
    await page.getByRole("link", { name: "See all notifications" }).click();
    await expect(page).toHaveURL(new RegExp(`/${ws.slug}/notifications$`));
  });
});
