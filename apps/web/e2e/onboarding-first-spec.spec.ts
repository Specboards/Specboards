import { expect, test } from "@playwright/test";

import { getWorkspace, resetBoard, seedRepository } from "./helpers/db";
import { getRepoFiles, resetFixture, setRepoFiles } from "./helpers/github";

const OWNER = "acme";
const REPO = "blank";

test.describe("onboarding: guided first spec", () => {
  test("commits a starter spec into an empty repo and imports it", async ({ page }) => {
    const ws = await getWorkspace();
    await resetBoard(ws.id);
    resetFixture();

    // A connected repo with no specs yet -> the guided empty state.
    await seedRepository({ workspaceId: ws.id, owner: OWNER, name: REPO });
    setRepoFiles(OWNER, REPO, {});

    await page.goto(`/${ws.slug}/settings/repositories`);

    await expect(
      page.getByText(/didn.?t find any specs in your connected repositories/i),
    ).toBeVisible();

    await page.fill('input[placeholder="Checkout flow"]', "Payments Onboarding");
    await page.getByRole("button", { name: /Create my first spec/i }).click();

    // The starter spec was committed (to the fake) and the card is on the board.
    // Match "Committed specs/..." specifically: /settings/repositories now
    // redirects into the tabbed Integrations page, where the (hidden) MCP panel
    // also contains the word "committed", so a bare /Committed/i is ambiguous.
    await expect(page.getByText(/Committed specs\//i)).toBeVisible();
    await expect(page.getByText("specs/payments-onboarding/spec.md")).toBeVisible();

    // The fake repo now actually holds the committed file.
    const files = getRepoFiles(OWNER, REPO);
    expect(Object.keys(files)).toContain("specs/payments-onboarding/spec.md");

    await page.getByRole("link", { name: /View your board/i }).click();
    await expect(page.getByText("Payments Onboarding")).toBeVisible();
  });
});
