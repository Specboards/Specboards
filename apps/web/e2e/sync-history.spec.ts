import { expect, test } from "@playwright/test";

import { getWorkspace, resetBoard, seedRepository } from "./helpers/db";
import { resetFixture, setRepoFiles } from "./helpers/github";

/**
 * Changes that happen in git, showing up in the item's history.
 *
 * Sync writes the `features` row directly rather than through the store that
 * records history, so before this a spec renamed or rewritten in an editor left
 * no trace at all: for a spec-backed item, that was most of its history missing.
 *
 * The reconcile is driven through the real import endpoint rather than by
 * calling `syncRepository` in-process, because the thing worth proving is that
 * the ledger write survives the path sync actually runs on, including its
 * transaction and its database role.
 */

const OWNER = "acme";
const REPO = "handbook";
const SPEC_ID = "88888888-8888-4888-8888-888888888888";
const SPEC_PATH = "specs/onboarding/spec.md";

function spec(title: string, body: string): string {
  return [
    "---",
    `id: ${SPEC_ID}`,
    `title: "${title}"`,
    "kind: feature",
    "---",
    "",
    `# ${title}`,
    "",
    body,
    "",
  ].join("\n");
}

/** Run the same reconcile the push webhook runs, through the API. */
async function resync(page: import("@playwright/test").Page) {
  const res = await page.request.post("/api/v1/repositories/import");
  expect(res.ok()).toBeTruthy();
}

test.describe("item history: changes made in git", () => {
  test("records a rename and a rewrite that happened in the repo", async ({ page }) => {
    const ws = await getWorkspace();
    await resetBoard(ws.id);
    resetFixture();
    await seedRepository({ workspaceId: ws.id, owner: OWNER, name: REPO });
    setRepoFiles(OWNER, REPO, { [SPEC_PATH]: spec("Onboarding", "The first draft.") });

    await page.goto(`/${ws.slug}/settings/repositories`);
    await page.getByRole("button", { name: /Create 1 card/i }).click();
    await expect(page.getByText(/Imported\s+1\s+spec/i)).toBeVisible();

    // The import itself is not a change. An item's history should not open with
    // a fictional edit describing the moment it came into existence.
    await page.goto(`/${ws.slug}/all/backlog/work/${SPEC_ID}`);
    await page.getByRole("button", { name: "History" }).click();
    await expect(page.getByText(/No changes recorded yet/i)).toBeVisible();

    // Someone edits the spec in their editor and pushes: a new title and a
    // rewritten body.
    setRepoFiles(OWNER, REPO, {
      [SPEC_PATH]: spec("Onboarding, revised", "A much better second draft."),
    });
    await resync(page);

    await page.goto(`/${ws.slug}/all/backlog/work/${SPEC_ID}`);
    // The history section stays expanded (DetailSection persists it).
    await expect(
      page.getByText(/changed the title from "Onboarding" to "Onboarding, revised"/i),
    ).toBeVisible();
    // The body change too. Asserted explicitly because it is the entry with no
    // field behind it, and a sentence built from the field name renders as
    // "changed the " with nothing after it.
    await expect(page.getByText(/rewrote the spec/i)).toBeVisible();
    // Attributed to git rather than to whoever happened to trigger the sync.
    await expect(page.getByText(/A change in git/i).first()).toBeVisible();
  });
});
