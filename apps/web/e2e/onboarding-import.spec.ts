import { expect, test } from "@playwright/test";

import { getWorkspace, resetBoard, seedRepository } from "./helpers/db";
import { resetFixture, setRepoFiles, specMd } from "./helpers/github";

// Stable spec ids so import skips id injection and stays deterministic.
const CHECKOUT_ID = "11111111-1111-4111-8111-111111111111";
const SEARCH_ID = "22222222-2222-4222-8222-222222222222";

const OWNER = "acme";
const REPO = "widgets";

test.describe("onboarding: scan + import", () => {
  test("scans a connected repo, imports its specs, and shows them on the board", async ({
    page,
  }) => {
    const ws = await getWorkspace();
    await resetBoard(ws.id);
    resetFixture();

    // A connected repo whose git contains two specs.
    await seedRepository({ workspaceId: ws.id, owner: OWNER, name: REPO });
    setRepoFiles(OWNER, REPO, {
      "specs/checkout/spec.md": specMd("Checkout Flow", CHECKOUT_ID),
      "specs/search/spec.md": specMd("Search Ranking", SEARCH_ID),
    });

    await page.goto(`/${ws.slug}/settings/repositories`);

    // The import panel scans on mount and reports what it found.
    await expect(page.getByText("Import your specs")).toBeVisible();
    await expect(page.getByText("Checkout Flow")).toBeVisible();
    await expect(page.getByText("Search Ranking")).toBeVisible();

    // Nothing is created until we confirm.
    const createButton = page.getByRole("button", { name: /Create 2 cards/i });
    await expect(createButton).toBeVisible();
    await createButton.click();

    // Import summary, then off to the board.
    await expect(page.getByText(/Imported\s+2\s+specs/i)).toBeVisible();
    await page.getByRole("link", { name: /View your board/i }).click();

    // The board opens on the Feature level: import auto-created one Feature
    // grouping per spec folder (titled from the folder name). Match the card
    // link specifically — the board's parent-epic filter also lists these
    // titles as <option>s, so a plain getByText is ambiguous.
    await expect(
      page.getByRole("link", { name: "Checkout", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Search", exact: true }),
    ).toBeVisible();

    // Switching to the leaf level shows the imported specs themselves.
    await page.getByRole("link", { name: "Work Items" }).click();
    await expect(page.getByText("Checkout Flow")).toBeVisible();
    await expect(page.getByText("Search Ranking")).toBeVisible();
  });
});
