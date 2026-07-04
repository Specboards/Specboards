import { expect, test } from "@playwright/test";

import { getWorkspace, resetReleases } from "./helpers/db";

/**
 * Releases lifecycle on the Roadmap (admin-only controls). The authenticated
 * admin from global setup drives the real create -> edit -> delete drawers;
 * releases are workspace-wide, so the `all` product view is enough to reach
 * them without connecting a repo.
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

    // The new column heading appears with its date range and defaults to
    // Planned (no status suffix is shown for the default state).
    const heading = page.getByRole("heading", { name: /Winter release/ });
    await expect(heading).toBeVisible();
    await expect(heading).toContainText("2026-11-01");
    await expect(heading).toContainText("2026-12-01");

    // Edit: rename, move to In progress, clear the ship date.
    await page.getByRole("button", { name: "Edit release Winter release" }).click();
    await page.getByLabel("Name").fill("Winter GA");
    await page.getByLabel("Status").selectOption("in_progress");
    await page.getByLabel("Ship date").fill("");
    await page.getByRole("button", { name: "Save changes" }).click();

    const edited = page.getByRole("heading", { name: /Winter GA/ });
    await expect(edited).toBeVisible();
    await expect(edited).toContainText("In progress");
    await expect(edited).not.toContainText("2026-12-01");
    await expect(page.getByRole("heading", { name: /Winter release/ })).toHaveCount(0);

    // Release it: the confirm dialog is auto-accepted; it leaves the active
    // roadmap and moves under the Shipped releases view.
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Release", exact: true }).click();
    await expect(page.getByRole("heading", { name: /Winter GA/ })).toHaveCount(0);

    // Open the Shipped releases view and confirm it's there, marked Shipped.
    await page.getByRole("link", { name: /Shipped releases/ }).click();
    const shipped = page.getByRole("heading", { name: /Winter GA/ });
    await expect(shipped).toBeVisible();
    await expect(shipped).toContainText("Shipped");

    // Delete from the shipped view; the column disappears.
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Delete release Winter GA" }).click();
    await expect(page.getByRole("heading", { name: /Winter GA/ })).toHaveCount(0);
  });
});
