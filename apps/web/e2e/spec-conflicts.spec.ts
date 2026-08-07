import { expect, test, type Page } from "@playwright/test";

import { getWorkspace, resetBoard, seedRepository } from "./helpers/db";
import {
  getRepoBranchFiles,
  getRepoFiles,
  resetFixture,
  setRepoFiles,
} from "./helpers/github";

/**
 * The race this release exists to stop: the app loads a spec, the file changes
 * in git, and the app saves. Last-write-wins would silently drop whatever
 * happened in git in between, on a document we tell customers is their source
 * of truth.
 *
 * Covered in both write modes, because the branch the guard applies to differs
 * between them. In direct mode the write is checked against the default branch.
 * In PR mode it is checked against the working branch, where the version that
 * beats the author may be a proposal *they* made earlier and can no longer see,
 * since the board goes on showing the default branch until a review merges.
 *
 * The assertion that matters in every case is the same one: the text that was
 * in git before the save is still there afterwards.
 */

const OWNER = "acme";
const SPEC_ID = "55555555-5555-4555-8555-555555555555";
const SPEC_PATH = "specs/pricing/spec.md";
const BRANCH = "specboards/specs-pricing-spec-md";

function pricingSpec(body: string): string {
  return [
    "---",
    `id: ${SPEC_ID}`,
    'title: "Pricing"',
    "kind: feature",
    "---",
    "",
    "# Pricing",
    "",
    body,
    "",
  ].join("\n");
}

/** Seed a repo + import its one spec, then open that item's page. */
async function setup(page: Page, repo: string, config?: Record<string, unknown>) {
  const ws = await getWorkspace();
  await resetBoard(ws.id);
  resetFixture();
  await seedRepository({ workspaceId: ws.id, owner: OWNER, name: repo, config });
  setRepoFiles(OWNER, repo, { [SPEC_PATH]: pricingSpec("The original body.") });

  await page.goto(`/${ws.slug}/settings/repositories`);
  await page.getByRole("button", { name: /Create 1 card/i }).click();
  await expect(page.getByText(/Imported\s+1\s+spec/i)).toBeVisible();
  await page.goto(`/${ws.slug}/all/backlog/work/${SPEC_ID}`);
  await expect(page.locator(".tiptap")).toContainText("The original body.");
}

/** Type at the end of the body and press the save button, whatever it says. */
async function editAndSave(page: Page, text: string) {
  await page.locator(".tiptap").click();
  await page.keyboard.press("End");
  await page.keyboard.type(text);
  const save = page.getByRole("button", {
    name: /Send for review|Commit changes/i,
  });
  await expect(save).toBeEnabled();
  await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().includes(`/api/v1/features/${SPEC_ID}/content`) &&
        r.request().method() === "PUT",
    ),
    save.click(),
  ]);
}

test.describe("spec editing: a change made in git is never overwritten", () => {
  test("direct mode refuses the save and offers a way out", async ({ page }) => {
    const REPO = "tariffs";
    await setup(page, REPO, { version: 1, writeMode: "direct" });

    // Someone edits the file in the repo while the page sits open. The board's
    // cached copy, and so the editor, still holds the original.
    setRepoFiles(OWNER, REPO, {
      [SPEC_PATH]: pricingSpec("Rewritten in the repo by someone else."),
    });

    await editAndSave(page, " Edited in the app.");

    // Nothing was written. This is the whole feature.
    const raw = getRepoFiles(OWNER, REPO)[SPEC_PATH];
    expect(raw).toContain("Rewritten in the repo by someone else.");
    expect(raw).not.toContain("Edited in the app.");

    // The author is shown what happened, in words that do not require knowing
    // what a blob sha is, with the incoming version to read.
    await expect(
      page.getByText(/Someone else changed this spec while you were writing/i),
    ).toBeVisible();
    await expect(
      page.getByText("Rewritten in the repo by someone else."),
    ).toBeVisible();

    // And their own writing is still in the editor, unsaved but not lost.
    await expect(page.locator(".tiptap")).toContainText("Edited in the app.");
  });

  test("keeping mine overwrites deliberately, once the author has seen theirs", async ({
    page,
  }) => {
    const REPO = "levies";
    await setup(page, REPO, { version: 1, writeMode: "direct" });
    setRepoFiles(OWNER, REPO, { [SPEC_PATH]: pricingSpec("Repo version.") });

    await editAndSave(page, " Mine.");
    await expect(
      page.getByText(/Someone else changed this spec while you were writing/i),
    ).toBeVisible();

    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes(`/api/v1/features/${SPEC_ID}/content`) &&
          r.request().method() === "PUT",
      ),
      page.getByRole("button", { name: "Keep mine" }).click(),
    ]);

    // The overwrite is a guarded write against the version they were shown, not
    // an unguarded one: it succeeds because they chose it, having seen it.
    const raw = getRepoFiles(OWNER, REPO)[SPEC_PATH];
    expect(raw).toContain("Mine.");
    expect(raw).not.toContain("Repo version.");
    await expect(
      page.getByText(/Someone else changed this spec/i),
    ).toBeHidden();
  });

  test("using theirs takes two clicks and replaces the draft", async ({ page }) => {
    const REPO = "duties";
    await setup(page, REPO, { version: 1, writeMode: "direct" });
    setRepoFiles(OWNER, REPO, { [SPEC_PATH]: pricingSpec("Theirs won.") });

    await editAndSave(page, " Mine.");
    await page.getByRole("button", { name: "Use theirs" }).click();

    // One click only arms it. Discarding someone's writing sits next to the
    // button that keeps it, so a stray click must not be enough.
    await expect(page.locator(".tiptap")).toContainText("Mine.");
    await page.getByRole("button", { name: "Discard my version" }).click();

    await expect(page.locator(".tiptap")).toContainText("Theirs won.");
    await expect(page.locator(".tiptap")).not.toContainText("Mine.");
    // Nothing was committed by adopting: git is unchanged.
    expect(getRepoFiles(OWNER, REPO)[SPEC_PATH]).toContain("Theirs won.");
  });

  test("pr mode guards the working branch, not the base", async ({ page }) => {
    // The case PR mode creates on its own: the author proposes a change, the
    // board goes on showing the default branch, and a later edit from a fresh
    // page is written from a base that is missing their own open proposal.
    const REPO = "duties-pr";
    await setup(page, REPO);

    await editAndSave(page, " First proposal.");
    expect(getRepoBranchFiles(OWNER, REPO, BRANCH)[SPEC_PATH]).toContain(
      "First proposal.",
    );

    // Reload: the editor now shows the default branch, with no sign of the
    // proposal waiting for review.
    await page.reload();
    await expect(page.locator(".tiptap")).not.toContainText("First proposal.");

    await editAndSave(page, " Second, unaware of the first.");

    // The branch still holds the first proposal. Without the guard this second
    // save would have replaced it, and the review would quietly lose a change
    // its own author had made.
    const proposed = getRepoBranchFiles(OWNER, REPO, BRANCH)[SPEC_PATH];
    expect(proposed).toContain("First proposal.");
    expect(proposed).not.toContain("Second, unaware of the first.");
    await expect(
      page.getByText(/Someone else changed this spec while you were writing/i),
    ).toBeVisible();
  });

  test("a second save in the same session is not a conflict with itself", async ({
    page,
  }) => {
    // The guard has to move forward with each write, or every author would be
    // stopped by their own previous save, which would make the feature read as
    // broken rather than careful.
    const REPO = "excise";
    await setup(page, REPO, { version: 1, writeMode: "direct" });

    await editAndSave(page, " First.");
    await expect(
      page.getByRole("status").filter({ hasText: /Committed [0-9a-f]{7} to / }),
    ).toBeVisible();

    await editAndSave(page, " Second.");
    await expect(
      page.getByText(/Someone else changed this spec/i),
    ).toBeHidden();
    const raw = getRepoFiles(OWNER, REPO)[SPEC_PATH];
    expect(raw).toContain("First.");
    expect(raw).toContain("Second.");
  });
});
