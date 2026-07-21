import { expect, test } from "@playwright/test";

import { getWorkspace, resetBoard, resetDocs, seedInstallation } from "./helpers/db";
import { getRepoFiles, resetFixture, setRepoFiles } from "./helpers/github";

/**
 * The Plan section: the restructured Plan / Build / Ship sidebar plus the new
 * doc areas. Strategy holds Specboards pages with autosaving rich-text editing;
 * Research (and Architecture) first choose a doc source: an external
 * repository we link out to, or pages held in Specboards. The workspace has the
 * single default product, so the `all` product segment resolves to it.
 */
test.describe("plan section: nav, strategy pages, research source", () => {
  test.beforeEach(async () => {
    const ws = await getWorkspace();
    await resetDocs(ws.id);
  });

  test("sidebar shows Plan / Build / Ship groups with the new areas", async ({
    page,
  }) => {
    const ws = await getWorkspace();
    await page.goto(`/${ws.slug}/all/backlog`);

    const nav = page.getByRole("navigation");
    for (const group of ["Plan", "Build", "Ship"]) {
      await expect(nav.getByText(group, { exact: true })).toBeVisible();
    }
    for (const area of ["Strategy", "Research", "Architecture"]) {
      await expect(nav.getByRole("link", { name: area })).toBeVisible();
    }
    // Adoption is a "Soon" placeholder: visible but not a link.
    await expect(nav.getByText("Adoption")).toBeVisible();
    await expect(nav.getByRole("link", { name: "Adoption" })).toHaveCount(0);
  });

  test("strategy: starter pages with autosaving rich-text editing", async ({
    page,
  }) => {
    const ws = await getWorkspace();
    await page.goto(`/${ws.slug}/all/strategy`);

    // Empty area offers one-click starter pages.
    await page.getByRole("button", { name: "Create starter pages" }).click();
    for (const title of ["Overview", "Goals", "How we build"]) {
      await expect(page.getByRole("button", { name: title })).toBeVisible();
    }

    // The first starter is selected; edit its body via the Raw surface (a
    // plain textarea, deterministic for tests) and wait for the autosave.
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
    await page.getByRole("button", { name: "Raw" }).click();
    await page
      .locator("textarea")
      .fill("Our mission is to ship tracer bullets.");
    await expect(page.getByRole("status")).toHaveText("Saved");

    // The content survives a full reload (persisted, not just local state).
    await page.reload();
    await expect(page.locator(".tiptap")).toContainText(
      "Our mission is to ship tracer bullets.",
    );

    // Pages can be organized under folders.
    await page.getByRole("button", { name: "Folder" }).click();
    await page.getByLabel("New folder name").fill("Archive");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Archive" })).toBeVisible();
  });

  test("research: connect external, link out, then switch to Specboards", async ({
    page,
  }) => {
    const ws = await getWorkspace();
    await page.goto(`/${ws.slug}/all/research`);

    // First visit shows the source chooser; connect an external repository.
    await expect(page.getByText("Where does your research live?")).toBeVisible();
    await page
      .getByLabel("External repository URL")
      .fill("https://example.sharepoint.com/sites/research");
    await page.getByRole("button", { name: "Connect" }).click();

    // The area now links out instead of hosting pages.
    const openLink = page.getByRole("link", { name: "Open repository" });
    await expect(openLink).toBeVisible();
    await expect(openLink).toHaveAttribute(
      "href",
      "https://example.sharepoint.com/sites/research",
    );

    // Switch the source to Specboards-held pages and create the first page.
    await page.getByRole("button", { name: "Change source" }).click();
    await page.getByRole("button", { name: "Use Specboards" }).click();
    await page.getByRole("button", { name: "New page" }).click();
    await page.getByLabel("New page title").fill("User interviews");
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("button", { name: "User interviews" }),
    ).toBeVisible();
  });

  test("research: a GitHub docs repo; pages commit back to the repo", async ({
    page,
  }) => {
    const ws = await getWorkspace();
    // Clean repo/installation state, then bind the org installation the
    // create-repo flow needs (mirrors the onboarding create-repo test).
    await resetBoard(ws.id);
    resetFixture();
    await seedInstallation({ workspaceId: ws.id, accountLogin: "acme" });

    await page.goto(`/${ws.slug}/all/research`);

    // Create the docs repo from the chooser's GitHub option.
    await page.getByLabel("New repository name").fill("research-docs");
    await page.getByRole("button", { name: "Create repository" }).click();

    // The area becomes a file workspace on the (empty) new repo.
    await expect(page.getByRole("link", { name: "acme/research-docs" })).toBeVisible();
    await expect(page.getByText("No Markdown files yet.")).toBeVisible();

    // Creating a page commits the initial file to the repo.
    await page.getByRole("button", { name: "New page" }).click();
    await page.getByLabel("New page title").fill("Interview notes");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "interview-notes" })).toBeVisible();
    expect(getRepoFiles("acme", "research-docs")["interview-notes.md"]).toBe(
      "# Interview notes\n",
    );

    // Editing and saving commits the update.
    await page.getByRole("button", { name: "Raw" }).click();
    await page.locator("textarea").fill("# Interview notes\n\nJane said hello.");
    await expect(page.getByText("Unsaved changes")).toBeVisible();
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("status")).toHaveText("Saved");
    expect(getRepoFiles("acme", "research-docs")["interview-notes.md"]).toContain(
      "Jane said hello.",
    );
  });

  test("research: connect an existing repo; rename, delete, conflict guard", async ({
    page,
  }) => {
    const ws = await getWorkspace();
    await resetBoard(ws.id);
    resetFixture();
    await seedInstallation({ workspaceId: ws.id, accountLogin: "acme" });
    // The repo already exists with Markdown in it; we connect, not create.
    setRepoFiles("acme", "handbook", {
      "guides/onboarding.md": "# Onboarding\n",
      "readme.md": "# Readme\n",
    });

    await page.goto(`/${ws.slug}/all/research`);

    // Pick the existing repo from the chooser's lazy-loaded picker.
    await page.getByRole("button", { name: "Or connect an existing repository" }).click();
    await expect(page.getByLabel("Existing repository")).toHaveValue(/handbook/);
    await page.getByRole("button", { name: "Connect repository" }).click();

    // The area lists the repo's files; the first (alphabetical) is selected.
    await expect(page.getByRole("link", { name: "acme/handbook" })).toBeVisible();
    await expect(page.getByRole("button", { name: "onboarding" })).toBeVisible();
    await expect(page.getByRole("button", { name: "readme" })).toBeVisible();

    // Rename the selected page; the repo gets the new path, loses the old.
    await page.getByRole("button", { name: "Rename page" }).click();
    await page.getByLabel("New file path").fill("guides/getting-started.md");
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(page.getByRole("button", { name: "getting-started" })).toBeVisible();
    const afterRename = getRepoFiles("acme", "handbook");
    expect(afterRename["guides/getting-started.md"]).toBe("# Onboarding\n");
    expect(afterRename["guides/onboarding.md"]).toBeUndefined();

    // Delete a page (with a commit); it leaves the list and the repo.
    await page.getByRole("button", { name: "readme" }).click();
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Delete page" }).click();
    await expect(page.getByRole("button", { name: "readme" })).toHaveCount(0);
    expect(getRepoFiles("acme", "handbook")["readme.md"]).toBeUndefined();

    // Concurrent-edit guard: the file changes on GitHub behind the editor,
    // so saving the now-stale page is rejected instead of overwriting.
    setRepoFiles("acme", "handbook", {
      ...getRepoFiles("acme", "handbook"),
      "guides/getting-started.md": "# Changed on GitHub\n",
    });
    await page.getByRole("button", { name: "Raw" }).click();
    await page.locator("textarea").fill("# Onboarding\n\nMy stale edit.");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(/changed on GitHub since you loaded it/)).toBeVisible();
    expect(getRepoFiles("acme", "handbook")["guides/getting-started.md"]).toBe(
      "# Changed on GitHub\n",
    );
  });

  test("architecture: offers the same source chooser", async ({ page }) => {
    const ws = await getWorkspace();
    await page.goto(`/${ws.slug}/all/architecture`);
    await expect(
      page.getByText("Where does your architecture live?"),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Use Specboards" })).toBeVisible();
  });
});
