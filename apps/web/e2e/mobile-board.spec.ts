import { expect, test } from "@playwright/test";

import { getWorkspace } from "./helpers/db";

/**
 * Mobile swipe-column board (Stage 6). At a phone width the backlog board is a
 * scroll-snap carousel with a header that names the current column and steps
 * through them with prev/next arrows. Verifies the header is present, reflects
 * the active column, and advances when Next is pressed.
 */
test.describe("mobile swipe-column board", () => {
  test.use({ viewport: { width: 390, height: 780 } });

  let slug: string;
  test.beforeAll(async () => {
    slug = (await getWorkspace()).slug;
  });

  test("column nav names the column and advances", async ({ page }) => {
    // The board collapses to an empty state with no items; seed one feature so
    // the status columns (and thus the swipe nav) render. The page context
    // carries the authenticated session cookie.
    const res = await page.request.post("/api/v1/features", {
      data: { title: "Swipe column probe", level: "feature" },
    });
    expect(res.ok(), await res.text()).toBeTruthy();

    await page.goto(`/${slug}/all/backlog`);

    // The "n of m" readout is the swipe-column position (hidden from md up).
    const position = page.getByText(/^\d+ of \d+$/);
    await expect(position).toBeVisible();
    await expect(position).toHaveText(/^1 of \d+$/);

    // Prev is disabled on the first column; Next advances to the second.
    await expect(page.getByRole("button", { name: "Previous column" })).toBeDisabled();
    await page.getByRole("button", { name: "Next column" }).click();
    await expect(position).toHaveText(/^2 of \d+$/);
  });
});
