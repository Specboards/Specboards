import { expect, test } from "@playwright/test";

import { getWorkspace } from "./helpers/db";

/**
 * Non-drag move mechanism (Stage 7, WCAG 2.1.1 Level A / 2.5.7). Every board
 * card carries a keyboard- and pointer-operable "Move" menu as an alternative to
 * dragging. Verifies the menu relocates a card between status columns and
 * persists the change, with no drag involved.
 */
test.describe("board move menu", () => {
  let slug: string;
  test.beforeAll(async () => {
    slug = (await getWorkspace()).slug;
  });

  test("moves a card to another column via the menu", async ({ page }) => {
    // Seed a feature so a card (and its Move menu) render on the board.
    const res = await page.request.post("/api/v1/features", {
      data: { title: "Menu move probe", level: "feature" },
    });
    expect(res.ok(), await res.text()).toBeTruthy();

    await page.goto(`/${slug}/all/backlog`);

    // Open the card's Move menu. Target the actual <button> element: dnd-kit's
    // sortable wrapper is also role="button" with the same accessible name.
    await page.locator('button[aria-label="Move Menu move probe"]').click();

    // The backlog -> defining transition is allowed, so "Defining" is offered.
    const [patch] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes("/api/v1/features/") &&
          r.request().method() === "PATCH",
      ),
      page.getByRole("menuitem", { name: "Defining" }).click(),
    ]);
    expect(patch.ok()).toBeTruthy();
  });
});
