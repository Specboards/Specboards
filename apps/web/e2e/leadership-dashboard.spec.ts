import { expect, test } from "@playwright/test";

import { getWorkspace } from "./helpers/db";

/**
 * Leadership dashboard: the workspace-wide portfolio snapshot at
 * `/{org}/dashboard`, reached from the Dashboard entry that leads the sidebar.
 *
 * Read-only, so this checks it is reachable and that it reports the seeded
 * workspace rather than driving any mutation. The seeded workspace has no
 * product groups, which is deliberately the case the card calls out: an
 * ungrouped workspace still has to get a useful dashboard.
 */
test.describe("leadership dashboard", () => {
  test("reachable from the sidebar and reports the workspace", async ({
    page,
  }) => {
    const ws = await getWorkspace();
    await page.goto(`/${ws.slug}/all/backlog`);

    // The Dashboard entry is workspace-scoped, so it is present from any product
    // scope. Exact match: a group scope also offers "Group dashboard".
    await page
      .getByRole("link", { name: "Dashboard", exact: true })
      .first()
      .click();
    await expect(page).toHaveURL(new RegExp(`/${ws.slug}/dashboard$`));
    await expect(page.getByRole("heading", { name: "Portfolio" })).toBeVisible();

    // Ungrouped products appear even with no groups defined: the seeded product
    // links through to its own backlog.
    await expect(page.getByText(/product · .* item/)).toBeVisible();

    // Signals always render, with an explicit "nothing" rather than a blank.
    await expect(
      page.getByRole("heading", { name: "Worth escalating" }),
    ).toBeVisible();
    for (const name of ["Blocked", "Past target date", "Stale in progress"]) {
      await expect(page.getByRole("heading", { name })).toBeVisible();
    }
  });
});
