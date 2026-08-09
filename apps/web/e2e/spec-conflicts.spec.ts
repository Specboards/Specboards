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

/** A spec with the sections two different people would each own. */
function sectionedSpec(problem: string, design: string): string {
  return pricingSpec(
    ["## Problem", "", problem, "", "## Design", "", design].join("\n"),
  );
}

/** Seed a repo + import its one spec, then open that item's page. */
async function setup(
  page: Page,
  repo: string,
  config?: Record<string, unknown>,
  seed = pricingSpec("The original body."),
) {
  const ws = await getWorkspace();
  await resetBoard(ws.id);
  resetFixture();
  await seedRepository({ workspaceId: ws.id, owner: OWNER, name: repo, config });
  setRepoFiles(OWNER, repo, { [SPEC_PATH]: seed });

  await page.goto(`/${ws.slug}/settings/repositories`);
  await page.getByRole("button", { name: /Create 1 card/i }).click();
  await expect(page.getByText(/Imported\s+1\s+spec/i)).toBeVisible();
  await page.goto(`/${ws.slug}/all/backlog/work/${SPEC_ID}`);
  await expect(page.locator(".tiptap")).not.toBeEmpty();
}

/**
 * Type `text` at the end of the paragraph containing `after` (or at the end of
 * the document when it is omitted) and press save. Editing a *named* paragraph
 * is what lets a test put two people in two different sections.
 */
async function editAndSave(page: Page, text: string, after?: string) {
  if (after) {
    await page.locator(".tiptap p", { hasText: after }).first().click();
  } else {
    await page.locator(".tiptap").click();
  }
  await page.keyboard.press("End");
  await page.keyboard.type(text);
  const save = page.getByRole("button", {
    name: /Send for review|Save changes/i,
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

/**
 * The conflict panel, found by the one sentence that does not change with the
 * shape of the clash. Its heading deliberately names the section involved, so
 * matching on that would make every test restate the copy.
 */
function conflictPanel(page: Page) {
  return page.getByText(/Your version is still in the editor above/i);
}

/** The merged-save notice in the editor, not the toast that says the same. */
function mergedNotice(page: Page) {
  return page.getByText(/The editor now shows the combined version/i);
}

test.describe("spec editing: two people, two sections, one afternoon", () => {
  // The case this is really for: a product manager owns Problem, a designer
  // owns Design, they are both in the spec at once, and neither should be told
  // their save was refused because the other one got there first.
  const REPO = "duties-merge";
  const BASE = sectionedSpec("Refunds take too long.", "TBD.");

  test("merges edits to different sections instead of blocking the second", async ({
    page,
  }) => {
    await setup(page, REPO, { version: 1, writeMode: "direct" }, BASE);

    // The designer files their section while this page sits open, so the
    // editor is now working from a version that no longer exists in git.
    setRepoFiles(OWNER, REPO, {
      [SPEC_PATH]: sectionedSpec(
        "Refunds take too long.",
        "One screen, no confirmation step.",
      ),
    });

    // The product manager rewrites theirs and saves.
    await editAndSave(page, " Eleven days, median.", "Refunds take too long.");

    // Both survive. Nobody was asked to choose, and nobody redid an afternoon.
    const raw = getRepoFiles(OWNER, REPO)[SPEC_PATH]!;
    expect(raw).toContain("Eleven days, median.");
    expect(raw).toContain("One screen, no confirmation step.");
    await expect(conflictPanel(page)).toBeHidden();

    // And they are told, because their spec now holds a paragraph they have
    // not read, with the editor showing the combined version rather than the
    // copy they typed.
    await expect(mergedNotice(page)).toBeVisible();
    await expect(page.locator(".tiptap")).toContainText(
      "One screen, no confirmation step.",
    );
  });

  test("a merged editor does not delete the merged-in change on its next save", async ({
    page,
  }) => {
    // The sharp edge of merging server-side: if the editor kept showing the
    // author's own text, their next save would pass the guard cleanly and
    // quietly remove the paragraph that was just merged in.
    await setup(page, REPO, { version: 1, writeMode: "direct" }, BASE);
    setRepoFiles(OWNER, REPO, {
      [SPEC_PATH]: sectionedSpec("Refunds take too long.", "One screen."),
    });

    await editAndSave(page, " Eleven days.", "Refunds take too long.");
    await expect(mergedNotice(page)).toBeVisible();

    await editAndSave(page, " And falling.", "Eleven days.");

    const raw = getRepoFiles(OWNER, REPO)[SPEC_PATH]!;
    expect(raw).toContain("And falling.");
    expect(raw).toContain("One screen.");
  });

  test("only a genuine overlap reaches the author, and it names the section", async ({
    page,
  }) => {
    await setup(page, REPO, { version: 1, writeMode: "direct" }, BASE);
    setRepoFiles(OWNER, REPO, {
      [SPEC_PATH]: sectionedSpec("Refunds are slow and customers churn.", "TBD."),
    });

    // Both rewrote Problem. There is no merge for that, and pretending there
    // is would be worse than asking.
    await editAndSave(page, " Eleven days, median.", "Refunds take too long.");

    await expect(
      page.getByText(/You and someone else both changed Problem/i),
    ).toBeVisible();
    // Nothing was written, and their draft is still theirs.
    expect(getRepoFiles(OWNER, REPO)[SPEC_PATH]).not.toContain("Eleven days");
    await expect(page.locator(".tiptap")).toContainText("Eleven days, median.");
  });
});

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
    // Named for where it happened. This spec has no headings, so the clash is
    // in the text above the first one.
    await expect(
      page.getByText(/You and someone else both changed the opening/i),
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
    await expect(conflictPanel(page)).toBeVisible();

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
    await expect(conflictPanel(page)).toBeHidden();
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
    await expect(conflictPanel(page)).toBeVisible();
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
      page.getByRole("status").filter({ hasText: /Saved\. .+ is live\./ }),
    ).toBeVisible();

    await editAndSave(page, " Second.");
    await expect(conflictPanel(page)).toBeHidden();
    const raw = getRepoFiles(OWNER, REPO)[SPEC_PATH];
    expect(raw).toContain("First.");
    expect(raw).toContain("Second.");
  });
});
