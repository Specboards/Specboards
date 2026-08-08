import { expect, test } from "@playwright/test";

import { getWorkspace, resetBoard, resetReleases } from "./helpers/db";

/**
 * The item change log, end to end: a change made in the app is recorded and
 * reads back as a sentence.
 *
 * The assertions are about the **words**, not about a row existing. A history
 * that renders "status: backlog -> defining" is the same failure as telling an
 * author their change is on branch `specboards/spec-x`: technically complete
 * and written for the wrong reader. Whether the row lands in the ledger at all,
 * with the right before value and actor, is covered precisely in the store's
 * integration suite; this covers the path from that row to a human.
 */

test.describe("item detail: change history", () => {
  test("records a change and reads it back in plain language", async ({ page }) => {
    const ws = await getWorkspace();
    await resetBoard(ws.id);
    await resetReleases(ws.id);

    // A DB-native card, so the whole history comes from the ledger rather than
    // partly from git.
    await page.goto(`/${ws.slug}/all/roadmap`);
    await page.getByRole("button", { name: "New feature" }).click();
    await page.getByLabel("Title").fill("Ledger subject");
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/v1/features") && r.request().method() === "POST",
      ),
      page.getByRole("button", { name: "Create feature" }).click(),
    ]);

    await page.getByRole("button", { name: "Ledger subject", exact: true }).click();

    // Nothing has happened to it yet, and the panel says so rather than showing
    // an empty list, which reads as broken rather than as "no history".
    await page.getByRole("button", { name: "History" }).click();
    await expect(page.getByText(/No changes recorded yet/i)).toBeVisible();

    // Change it the way a person would, through the UI. Located by `name`:
    // the properties panel labels its rows visually rather than binding a
    // <label> to the control, so there is no accessible name to query by.
    // The save is debounced, so the PATCH lands a moment after the selection.
    const [patch] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/v1/features/") && r.request().method() === "PATCH",
      ),
      page.locator('select[name="status"]').selectOption("defining"),
    ]);
    expect(patch.ok()).toBeTruthy();

    await page.reload();
    await page.getByRole("button", { name: "Ledger subject", exact: true }).click();
    // No second click: DetailSection persists the section's expanded state, so
    // History is already open and clicking would close it again.

    // The workspace's own words for its stages. No status keys, no ids.
    await expect(page.getByText(/moved this from Backlog to Defining/i)).toBeVisible();
    await expect(page.getByText(/status: |backlog -> |in_progress/)).toHaveCount(0);
  });
});
