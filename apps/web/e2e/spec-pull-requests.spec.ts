import { expect, test } from "@playwright/test";

import { getWorkspace, resetBoard, seedRepository } from "./helpers/db";
import {
  closeRepoPull,
  getRepoBranchFiles,
  getRepoFiles,
  getRepoPulls,
  resetFixture,
  setRepoFiles,
} from "./helpers/github";

/**
 * The v0.26.2 tracer bullet: a repo whose write mode is `pr` takes a spec edit
 * as a proposal, not a publication.
 *
 * As with spec editing, the assertions that matter are about git. The screen can
 * say anything; what decides whether this feature works is whether the default
 * branch was left alone, whether the change is sitting on a working branch, and
 * whether a second edit joined the review already open instead of filing a
 * competing one. A test that only read the page could pass while the app quietly
 * published unreviewed changes onto a protected branch, which is the exact
 * failure this release exists to prevent.
 *
 * Note that no config is seeded on the repo: `pr` is what a repo gets when
 * nobody has said otherwise, and that default is itself part of what is under
 * test here.
 */

const OWNER = "acme";
const REPO = "ledger";
const SPEC_ID = "44444444-4444-4444-8444-444444444444";
const SPEC_PATH = "specs/invoicing/spec.md";
const BRANCH = "specboards/specs-invoicing-spec-md";

function invoicingSpec(): string {
  return [
    "---",
    `id: ${SPEC_ID}`,
    'title: "Invoicing"',
    "kind: feature",
    "---",
    "",
    "# Invoicing",
    "",
    "The original body.",
    "",
  ].join("\n");
}

/** Import the seeded spec so there is a board row pointing at the file. */
async function importSpec(page: import("@playwright/test").Page, slug: string) {
  await page.goto(`/${slug}/settings/repositories`);
  await page.getByRole("button", { name: /Create 1 card/i }).click();
  await expect(page.getByText(/Imported\s+1\s+spec/i)).toBeVisible();
}

/** Type at the end of the spec body and send it, waiting for the write. */
async function editAndSend(
  page: import("@playwright/test").Page,
  text: string,
) {
  const editor = page.locator(".tiptap");
  await editor.click();
  await page.keyboard.press("End");
  await page.keyboard.type(text);

  const send = page.getByRole("button", { name: /Send for review/i });
  await expect(send).toBeEnabled();
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().includes(`/api/v1/features/${SPEC_ID}/content`) &&
        r.request().method() === "PUT",
    ),
    send.click(),
  ]);
  expect(response.ok()).toBeTruthy();
}

test.describe("spec editing: changes go through a pull request", () => {
  test.beforeEach(async ({ page }) => {
    const ws = await getWorkspace();
    await resetBoard(ws.id);
    resetFixture();
    await seedRepository({ workspaceId: ws.id, owner: OWNER, name: REPO });
    setRepoFiles(OWNER, REPO, { [SPEC_PATH]: invoicingSpec() });
    await importSpec(page, ws.slug);
    await page.goto(`/${ws.slug}/all/backlog/work/${SPEC_ID}`);
  });

  test("proposes the change instead of publishing it", async ({ page }) => {
    // The button admits what saving does before it is pressed. An author told
    // "commit" and then shown the old text would reasonably think it was lost.
    await expect(page.getByRole("button", { name: /Send for review/i })).toBeVisible();

    await editAndSend(page, " Edited in the app.");

    // The default branch is untouched. This is the assertion the whole release
    // turns on: a protected branch must not receive an unreviewed write.
    expect(getRepoFiles(OWNER, REPO)[SPEC_PATH]).not.toContain("Edited in the app.");
    // The change is on the file's working branch, with its frontmatter intact.
    const proposed = getRepoBranchFiles(OWNER, REPO, BRANCH)[SPEC_PATH];
    expect(proposed).toContain("Edited in the app.");
    expect(proposed).toContain(`id: ${SPEC_ID}`);

    const pulls = getRepoPulls(OWNER, REPO);
    expect(pulls).toHaveLength(1);
    expect(pulls[0]).toMatchObject({ branch: BRANCH, state: "open" });

    // The author is told the board has not changed yet, and given a way to
    // reach the review rather than just being asked to wait.
    await expect(
      page.getByRole("status").filter({ hasText: /Waiting for review/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: `Review #${pulls[0]!.number}` }),
    ).toBeVisible();

    // Their own text stays on screen. Refreshing from the server here would
    // show the default branch's copy and read as the edit reverting.
    await expect(page.locator(".tiptap")).toContainText("Edited in the app.");
  });

  test("records the pull request on the item it changed", async ({ page }) => {
    await editAndSend(page, " Traceable.");
    const [pull] = getRepoPulls(OWNER, REPO);

    // The proposal is reachable from the card, not only from the editor that
    // happened to make it. Without this the change is invisible to everyone
    // who did not watch it happen.
    await page.reload();
    await page.getByRole("button", { name: "Integrations" }).click();
    await expect(
      page.getByRole("link", { name: `PR #${pull!.number}` }),
    ).toBeVisible();
  });

  test("adds a second edit to the review already open", async ({ page }) => {
    await editAndSend(page, " First pass.");
    await editAndSend(page, " Second pass.");

    // One review, not one per typo fix. This is the difference between a
    // feature people use and one they turn off.
    const pulls = getRepoPulls(OWNER, REPO);
    expect(pulls).toHaveLength(1);
    expect(Object.keys(getRepoBranchFiles(OWNER, REPO, BRANCH))).toContain(SPEC_PATH);

    const proposed = getRepoBranchFiles(OWNER, REPO, BRANCH)[SPEC_PATH];
    expect(proposed).toContain("First pass.");
    expect(proposed).toContain("Second pass.");

    await expect(
      page.getByRole("link", { name: `Added to review #${pulls[0]!.number}` }),
    ).toBeVisible();
  });

  test("starts fresh when the earlier review was turned down", async ({ page }) => {
    await editAndSend(page, " Rejected idea.");
    const [first] = getRepoPulls(OWNER, REPO);
    closeRepoPull(OWNER, REPO, first!.number);

    await page.reload();
    await editAndSend(page, " Different idea.");

    // A closed review's branch is left where it is. Committing onto it would
    // carry the turned-down change into the new proposal, which is a good way
    // to get something merged that a reviewer already said no to.
    const pulls = getRepoPulls(OWNER, REPO);
    expect(pulls).toHaveLength(2);
    expect(pulls[1]!.branch).not.toBe(first!.branch);
    expect(getRepoBranchFiles(OWNER, REPO, pulls[1]!.branch)[SPEC_PATH]).not.toContain(
      "Rejected idea.",
    );
  });
});
