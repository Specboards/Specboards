import { expect, test } from "@playwright/test";

import { getWorkspace, resetReleases } from "./helpers/db";

/**
 * Releases lifecycle on the Roadmap (admin-only controls). The authenticated
 * admin from global setup drives the real create drawer and the release detail
 * panel, which is the single home for Edit / Release / Delete. Releases are
 * workspace-wide, so the `all` product view is enough to reach them without
 * connecting a repo.
 */
test.describe("roadmap: release lifecycle", () => {
  test.beforeEach(async () => {
    const ws = await getWorkspace();
    await resetReleases(ws.id);
  });

  test("admin can create, edit, release, and delete a release", async ({
    page,
  }) => {
    const ws = await getWorkspace();
    await page.goto(`/${ws.slug}/all/roadmap`);

    // Create a release via the drawer, with a start and ship date.
    await page.getByRole("button", { name: "New release" }).click();
    await page.getByLabel("Name").fill("Winter release");
    await page.getByLabel("Start date").fill("2026-11-01");
    await page.getByLabel("Ship date").fill("2026-12-01");
    await page.getByRole("button", { name: "Create release" }).click();

    // The release column appears: its name is a button (opens the detail panel)
    // with the date range beneath it. Planned is the default, so no status suffix.
    const column = page.getByRole("button", { name: "Winter release" });
    await expect(column).toBeVisible();
    await expect(page.getByText(/2026-11-01.*2026-12-01/)).toBeVisible();

    // Open the detail panel and edit: rename, move to In progress, clear the
    // ship date. Edit / Release / Delete all live in this panel now.
    await column.click();
    await page.getByRole("button", { name: "Edit" }).click();
    await page.getByLabel("Name").fill("Winter GA");
    await page.getByLabel("Status").selectOption("in_progress");
    await page.getByLabel("Ship date").fill("");
    await page.getByRole("button", { name: "Save" }).click();

    // Back in view mode, the (still-open) panel shows the new status and the
    // ship date is gone. The column heading behind the panel is aria-hidden
    // while it's open, so assert on the panel's own content here; the renamed
    // heading is confirmed once the panel closes (below and in the shipped view).
    await expect(page.getByText("In progress", { exact: true })).toBeVisible();
    await expect(page.getByText("2026-12-01")).toHaveCount(0);

    // Release it from the panel: the confirm dialog is auto-accepted; the panel
    // closes and the release leaves the active roadmap for the Shipped view.
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Release", exact: true }).click();
    await expect(page.getByRole("button", { name: "Winter GA" })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Winter release" }),
    ).toHaveCount(0);

    // Open the Shipped releases view: the release is there under its new name,
    // which confirms the rename persisted.
    await page.getByRole("link", { name: /Shipped releases/ }).click();
    const shipped = page.getByRole("button", { name: "Winter GA" });
    await expect(shipped).toBeVisible();

    // Open its panel (it's marked Shipped) and delete it; the column disappears.
    await shipped.click();
    await expect(page.getByText("Shipped", { exact: true })).toBeVisible();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByRole("button", { name: "Winter GA" })).toHaveCount(0);
  });
});
