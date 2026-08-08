import { expect, test } from "@playwright/test";

import { getWorkspace, resetBoard, seedRepository } from "./helpers/db";
import { getRepoFiles, resetFixture, setRepoFiles } from "./helpers/github";

/**
 * The per-repository write mode override.
 *
 * The setting belongs in the repo's own `.specboards/config.yml`, versioned
 * with the code. This exists for when that home is out of reach: an admin who
 * connects a repository they cannot commit to would otherwise have to open a
 * pull request in order to change how pull requests get made.
 *
 * What is asserted is the effect, not the form control. A setting that renders
 * correctly and does not reach the write path is worse than no setting, because
 * it reports a state the repo is not in.
 */

const OWNER = "acme";
const REPO = "ledgers";
const SPEC_ID = "66666666-6666-4666-8666-666666666666";
const SPEC_PATH = "specs/statements/spec.md";

function statementsSpec(): string {
  return [
    "---",
    `id: ${SPEC_ID}`,
    'title: "Statements"',
    "kind: feature",
    "---",
    "",
    "# Statements",
    "",
    "The original body.",
    "",
  ].join("\n");
}

test.describe("settings: how spec edits reach a repository", () => {
  test("an admin override beats the repo's own config, and can be given back", async ({
    page,
  }) => {
    const ws = await getWorkspace();
    await resetBoard(ws.id);
    resetFixture();
    await seedRepository({ workspaceId: ws.id, owner: OWNER, name: REPO });
    // The repo asks for review. This is the setting an admin who cannot commit
    // to the repo would be stuck with.
    setRepoFiles(OWNER, REPO, {
      ".specboards/config.yml": "version: 1\nwriteMode: pr\n",
      [SPEC_PATH]: statementsSpec(),
    });

    await page.goto(`/${ws.slug}/settings/repositories`);
    await page.getByRole("button", { name: /Create 1 card/i }).click();
    await expect(page.getByText(/Imported\s+1\s+spec/i)).toBeVisible();

    // The settings page says what happens and where the decision came from,
    // so nobody has to open a YAML file to find out.
    await expect(
      page.getByText(/open a pull request for review \(from \.specboards/i),
    ).toBeVisible();

    const control = page.getByLabel(`Write mode for ${OWNER}/${REPO}`);
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes("/api/v1/repositories/") &&
          r.request().method() === "PATCH",
      ),
      control.selectOption("direct"),
    ]);
    await expect(
      page.getByText(/commit straight to the default branch \(set here\)/i),
    ).toBeVisible();

    // The override reaches the write path: this save commits rather than
    // proposing, which is the only thing that makes the setting real.
    await page.goto(`/${ws.slug}/all/backlog/work/${SPEC_ID}`);
    const commit = page.getByRole("button", { name: /Commit changes/i });
    await expect(commit).toBeVisible();
    await page.locator(".tiptap").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Committed directly.");
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes(`/api/v1/features/${SPEC_ID}/content`) &&
          r.request().method() === "PUT",
      ),
      commit.click(),
    ]);
    expect(getRepoFiles(OWNER, REPO)[SPEC_PATH]).toContain("Committed directly.");

    // Clearing the override hands the decision back to the repo, rather than
    // leaving the admin's choice baked in with no way to undo it.
    await page.goto(`/${ws.slug}/settings/repositories`);
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes("/api/v1/repositories/") &&
          r.request().method() === "PATCH",
      ),
      page.getByLabel(`Write mode for ${OWNER}/${REPO}`).selectOption(""),
    ]);
    await expect(
      page.getByText(/open a pull request for review \(from \.specboards/i),
    ).toBeVisible();

    await page.goto(`/${ws.slug}/all/backlog/work/${SPEC_ID}`);
    await expect(
      page.getByRole("button", { name: /Send for review/i }),
    ).toBeVisible();
  });
});
