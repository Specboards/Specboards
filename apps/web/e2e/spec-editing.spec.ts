import { expect, test } from "@playwright/test";

import { getWorkspace, resetBoard, seedRepository } from "./helpers/db";
import { getRepoFiles, resetFixture, setRepoFiles } from "./helpers/github";

/**
 * The v0.26.1 tracer bullet, end to end: someone with product write access
 * opens a spec-backed item, edits its Markdown, commits, and the change is a
 * commit in the repo.
 *
 * The assertions that matter are about git, not about the screen. A spec's
 * body is canonical in the repo and `spec_index` is only a cache, so a test
 * that checked the page alone could pass while nothing had been committed. So
 * this reads the fake repo's file back and checks three things: the body
 * changed, the frontmatter `id` survived (it is what ties the file to its board
 * row through renames), and the rest of the frontmatter came through untouched.
 */

const OWNER = "acme";
const REPO = "widgets";
const SPEC_ID = "33333333-3333-4333-8333-333333333333";
const SPEC_PATH = "specs/checkout/spec.md";

/** A spec file with more frontmatter than the id, so we can prove it survives. */
function checkoutSpec(): string {
  return [
    "---",
    `id: ${SPEC_ID}`,
    'title: "Checkout Flow"',
    "kind: feature",
    "owner: payments-team",
    "---",
    "",
    "# Checkout Flow",
    "",
    "The original body.",
    "",
    "## Problem",
    "",
    "Users abandon the cart.",
    "",
  ].join("\n");
}

test.describe("spec editing: edit a spec body in the app", () => {
  test("commits the edited body to the repo and keeps the frontmatter", async ({
    page,
  }) => {
    const ws = await getWorkspace();
    await resetBoard(ws.id);
    resetFixture();

    await seedRepository({ workspaceId: ws.id, owner: OWNER, name: REPO });
    // `writeMode: direct` is what makes this the commit-straight-to-the-branch
    // path; the default is `pr` (see spec-pull-requests.spec.ts). It is set in
    // the repo's own config file rather than on the row, so the chain this
    // asserts starts where a customer sets it: config.yml, read by the sync.
    setRepoFiles(OWNER, REPO, {
      ".specboards/config.yml": "version: 1\nwriteMode: direct\n",
      [SPEC_PATH]: checkoutSpec(),
    });

    // Import the spec so there is a board row pointing at the file.
    await page.goto(`/${ws.slug}/settings/repositories`);
    await page.getByRole("button", { name: /Create 1 card/i }).click();
    await expect(page.getByText(/Imported\s+1\s+spec/i)).toBeVisible();

    // Open the spec-backed item's full page.
    await page.goto(`/${ws.slug}/all/backlog/work/${SPEC_ID}`);
    // `exact` matters: the editor's own status line names the same path, so a
    // loose match is ambiguous.
    await expect(page.getByText(SPEC_PATH, { exact: true })).toBeVisible();

    // The body is editable, and says where saving sends it. This is the part
    // that distinguishes a spec from a DB-native card: the destination is a
    // commit, and the UI has to admit that rather than autosaving silently.
    const commit = page.getByRole("button", { name: /Commit changes/i });
    await expect(commit).toBeVisible();
    await expect(commit).toBeDisabled(); // nothing edited yet

    const editor = page.locator(".tiptap");
    await editor.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Edited in the app.");

    await expect(commit).toBeEnabled();

    const [writeResp] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes(`/api/v1/features/${SPEC_ID}/content`) &&
          r.request().method() === "PUT",
      ),
      commit.click(),
    ]);
    expect(writeResp.ok()).toBeTruthy();

    // The commit is reported back with its sha, not just a generic "Saved".
    // Scoped to the editor's status line: the toast says the same thing, and an
    // unscoped match resolves to both.
    await expect(
      page.getByRole("status").filter({ hasText: /Committed [0-9a-f]{7} to / }),
    ).toBeVisible();

    // What actually landed in git.
    const raw = getRepoFiles(OWNER, REPO)[SPEC_PATH];
    expect(raw).toBeDefined();
    expect(raw).toContain("Edited in the app.");
    // The stable id survives: without it the next sync would not recognise the
    // file as this board row and would import it as a second card.
    expect(raw).toContain(`id: ${SPEC_ID}`);
    // Frontmatter is preserved whole, not re-serialized down to the keys we
    // happen to know about.
    expect(raw).toContain("owner: payments-team");
    expect(raw).toContain("kind: feature");

    // And the loop closed: the page re-renders from the re-synced cache, so
    // what is on screen is what was read back out of git.
    await page.reload();
    await expect(page.locator(".tiptap")).toContainText("Edited in the app.");
  });
});

// Not covered here: a viewer without product write access seeing the body
// read-only. The E2E harness signs in as a single admin user and has no way to
// assume a role, so a test for it would assert nothing. The gate itself is
// `canEditSpec` in lib/item-detail.ts, and the server refuses the write
// independently (updateSpecContent's own product-write check), so the
// permission is enforced in two places even though only one is covered.
