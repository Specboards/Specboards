import { expect, test } from "@playwright/test";

import { getWorkspace, resetBoard, resetIdeas } from "./helpers/db";

/**
 * Ideas: the internal capture → vote → triage → promote flow. The authenticated
 * admin from global setup drives the real drawers and controls; the `all`
 * product view reaches every idea without connecting a repo. resetBoard clears
 * any features a prior promote created so re-runs start clean.
 */
test.describe("ideas: internal capture, vote, and promote", () => {
  test.beforeEach(async () => {
    const ws = await getWorkspace();
    await resetBoard(ws.id);
    await resetIdeas(ws.id);
  });

  test("admin can capture, vote, restage, and promote an idea", async ({
    page,
  }) => {
    const ws = await getWorkspace();
    await page.goto(`/${ws.slug}/all/ideas`);

    // Capture an idea via the drawer.
    await page.getByRole("button", { name: "New idea" }).click();
    await page.getByLabel("Title").fill("Dark mode");
    await page.getByLabel("Details").fill("Customers keep asking for a dark theme.");
    await page.getByRole("button", { name: "Capture idea" }).click();

    const row = page.locator("li", { hasText: "Dark mode" });
    await expect(row).toBeVisible();
    await expect(row).toContainText("dark theme");

    // Vote for it: the control flips to the "voted" state and the tally is 1.
    await row.getByRole("button", { name: "Vote for this idea" }).click();
    await expect(
      row.getByRole("button", { name: "Remove your vote" }),
    ).toBeVisible();
    await expect(row.getByRole("button", { name: "Remove your vote" })).toContainText(
      "1",
    );

    // Move it through the review workflow (inline status field on the row).
    await row.getByLabel("Status of Dark mode").selectOption("under_review");
    await expect(row.getByLabel("Status of Dark mode")).toHaveValue("under_review");

    // Promote and Delete now live in the detail drawer, not the row. Open it by
    // clicking the idea title.
    await row.getByRole("button", { name: /Dark mode/ }).click();

    // Promote it into a feature (confirm dialog auto-accepted); the drawer's
    // Promote action is replaced by a link to the promoted feature.
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Promote" }).click();
    await expect(page.getByRole("link", { name: /Promoted/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Promote" })).toHaveCount(0);

    // Delete it from the drawer; the drawer closes and the row disappears.
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Delete" }).click();
    await expect(page.locator("li", { hasText: "Dark mode" })).toHaveCount(0);
  });

  test("admin can rename a review stage in Settings → Ideas", async ({
    page,
  }) => {
    const ws = await getWorkspace();
    await page.goto(`/${ws.slug}/settings/ideas`);

    // Rename the first default stage ("New") and save.
    const firstStage = page.getByLabel("Stage 1");
    await expect(firstStage).toHaveValue("New");
    await firstStage.fill("Inbox");
    await page.getByRole("button", { name: "Save stages" }).click();
    await expect(page.getByLabel("Stage 1")).toHaveValue("Inbox");

    // The renamed stage now drives the Ideas capture status vocabulary.
    await page.goto(`/${ws.slug}/all/ideas`);
    await page.getByRole("button", { name: "New idea" }).click();
    await page.getByLabel("Title").fill("Renamed-stage check");
    await page.getByRole("button", { name: "Capture idea" }).click();
    const row = page.locator("li", { hasText: "Renamed-stage check" });
    await expect(
      row.getByLabel("Status of Renamed-stage check"),
    ).toContainText("Inbox");
  });
});
