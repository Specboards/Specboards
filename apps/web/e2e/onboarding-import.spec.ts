import { expect, test } from "@playwright/test";

import { getWorkspace, resetBoard, seedRepository } from "./helpers/db";
import { resetFixture, setRepoFiles, specMd } from "./helpers/github";

// Stable spec ids so import skips id injection and stays deterministic.
const CHECKOUT_ID = "11111111-1111-4111-8111-111111111111";
const SEARCH_ID = "22222222-2222-4222-8222-222222222222";
const REFUNDS_ID = "33333333-3333-4333-8333-333333333333";

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

    // Import summary, then off to the board. It counts the cards created, not
    // the specs written: a re-sync also writes every spec whose file changed,
    // and reporting that total is how "Create 2 cards" used to come back as
    // "Imported 1 spec". The summary also reports that both specs landed
    // without a parent, since sync no longer invents a Feature grouping per
    // spec folder (ADR 0003 D3).
    await expect(page.getByText(/Created\s+2\s+cards/i)).toBeVisible();
    await expect(page.getByText(/not yet under a feature/i)).toBeVisible();
    await page.getByRole("link", { name: /View your board/i }).click();

    // "View your board" lands on the Work Item level, where imported specs
    // actually are. Previously it opened on Feature and relied on auto-created
    // wrapper cards being there; with the wrapper retired, that level would be
    // empty, so the link points at the leaf instead. Match the card link
    // specifically — the board's parent filter also lists these titles as
    // <option>s, so a plain getByText is ambiguous.
    await expect(
      page.getByRole("link", { name: "Checkout Flow", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Search Ranking", exact: true }),
    ).toBeVisible();

    // No grouping card was invented for either spec's folder.
    await page.getByRole("link", { name: "Features" }).click();
    await expect(
      page.getByRole("link", { name: "Checkout", exact: true }),
    ).toBeHidden();
    await expect(
      page.getByRole("link", { name: "Search", exact: true }),
    ).toBeHidden();
  });

  test("counts what it would create, not what is in the repository", async ({
    page,
  }) => {
    const ws = await getWorkspace();
    await resetBoard(ws.id);
    resetFixture();

    await seedRepository({ workspaceId: ws.id, owner: OWNER, name: REPO });
    setRepoFiles(OWNER, REPO, {
      "specs/checkout/spec.md": specMd("Checkout Flow", CHECKOUT_ID),
      "specs/search/spec.md": specMd("Search Ranking", SEARCH_ID),
    });

    await page.goto(`/${ws.slug}/settings/repositories`);
    await page.getByRole("button", { name: /Create 2 cards/i }).click();
    await expect(page.getByText(/Created\s+2\s+cards/i)).toBeVisible();

    // Everything in the repository is now on the board. The panel used to keep
    // offering "Create 2 cards" here, and pressing it created none: the count
    // described the repository rather than the pending work. On a real
    // workspace that is "Create 200 cards" when the true answer is zero.
    await page.getByRole("button", { name: /Scan again/i }).click();
    await expect(
      page.getByText(/All\s+2\s+specs .* already on your board/i),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Create \d+ card/i }),
    ).toBeHidden();

    // A spec merged since the last import is the one thing left to do, and the
    // panel now counts only that one.
    setRepoFiles(OWNER, REPO, {
      "specs/checkout/spec.md": specMd("Checkout Flow", CHECKOUT_ID),
      "specs/search/spec.md": specMd("Search Ranking", SEARCH_ID),
      "specs/refunds/spec.md": specMd("Refunds", REFUNDS_ID),
    });
    await page.getByRole("button", { name: /Rescan/i }).click();
    await expect(page.getByText(/1\s+new spec to import/i)).toBeVisible();
    await expect(page.getByText(/2 already on your board/i)).toBeVisible();

    // The preview list is what the button will create, so the two specs it
    // will not touch are not in it. Exact, because the row also shows the
    // spec's path and "specs/refunds/spec.md" contains the title.
    await expect(page.getByText("Refunds", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Checkout Flow", { exact: true }),
    ).toBeHidden();

    await page.getByRole("button", { name: /Create 1 card/i }).click();
    // One card created; the other two were rewritten from git, which the
    // button never claimed and which is now reported separately.
    await expect(page.getByText(/Created\s+1\s+card/i)).toBeVisible();
  });
});
