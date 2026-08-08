import { expect, test } from "@playwright/test";

import {
  getWorkspace,
  resetBoard,
  seedRepository,
  setGithubLinkState,
} from "./helpers/db";
import { getRepoPulls, resetFixture, setRepoFiles } from "./helpers/github";

/**
 * The pending-change state on the item detail.
 *
 * In PR mode a save leaves the board showing the live text while the author's
 * writing waits on a working branch. Before this, the only thing that said so
 * lived in the editor's React state, so it survived exactly as long as the tab
 * did: reload, and the spec showed the old text with nothing to explain why.
 * That reads as an editor that lost your work.
 *
 * So the assertion that matters here is about **a reload**. Anything that only
 * checked the page straight after saving would pass on the state that was
 * already there and prove nothing about the state this work adds.
 */

const OWNER = "acme";
const REPO = "billing";
const SPEC_ID = "77777777-7777-4777-8777-777777777777";
const SPEC_PATH = "specs/dunning/spec.md";

function dunningSpec(): string {
  return [
    "---",
    `id: ${SPEC_ID}`,
    'title: "Dunning"',
    "kind: feature",
    "---",
    "",
    "# Dunning",
    "",
    "The live body.",
    "",
  ].join("\n");
}

/** The panel that explains why the body below is not the latest writing. */
function pendingNotice(page: import("@playwright/test").Page) {
  return page.getByText(/A change to this spec is waiting for review/i);
}

test.describe("item detail: a change waiting for review", () => {
  test.beforeEach(async ({ page }) => {
    const ws = await getWorkspace();
    await resetBoard(ws.id);
    resetFixture();
    // No config, so the repo takes the default write mode, which is `pr`.
    await seedRepository({ workspaceId: ws.id, owner: OWNER, name: REPO });
    setRepoFiles(OWNER, REPO, { [SPEC_PATH]: dunningSpec() });

    await page.goto(`/${ws.slug}/settings/repositories`);
    await page.getByRole("button", { name: /Create 1 card/i }).click();
    await expect(page.getByText(/Imported\s+1\s+spec/i)).toBeVisible();
    await page.goto(`/${ws.slug}/all/backlog/work/${SPEC_ID}`);
  });

  test("explains the stale body after a reload, and clears when it merges", async ({
    page,
  }) => {
    // Nothing is in flight yet, so the panel must not be claiming otherwise.
    await expect(pendingNotice(page)).toHaveCount(0);

    await page.locator(".tiptap").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Proposed wording.");
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes(`/api/v1/features/${SPEC_ID}/content`) &&
          r.request().method() === "PUT",
      ),
      page.getByRole("button", { name: /Send for review/i }).click(),
    ]);

    const [pull] = getRepoPulls(OWNER, REPO);
    expect(pull).toBeTruthy();

    // The point of the whole item: come back to the page later and it still
    // tells you the spec has an unpublished change.
    await page.reload();
    await expect(pendingNotice(page)).toBeVisible();
    await expect(
      page.getByRole("link", { name: `Open review #${pull!.number}` }),
    ).toBeVisible();
    // And the body genuinely is the live text, which is what the panel claims.
    // If this ever showed the proposed wording the panel would be lying.
    await expect(page.locator(".tiptap")).toContainText("The live body.");
    await expect(page.locator(".tiptap")).not.toContainText("Proposed wording.");

    // Merging is what the webhook records. Once the change is live it is no
    // longer pending, and a panel that stayed would send people to a review
    // that has already happened.
    const changed = await setGithubLinkState(
      `https://github.test/pull/${pull!.number}`,
      "merged",
    );
    expect(changed).toBe(1);

    await page.reload();
    await expect(pendingNotice(page)).toHaveCount(0);
  });
});
