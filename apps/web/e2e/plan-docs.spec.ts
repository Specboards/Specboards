import { expect, test } from "@playwright/test";

import { getWorkspace, resetDocs } from "./helpers/db";

/**
 * The Plan section: the restructured Plan / Build / Ship sidebar plus the new
 * doc areas. Strategy holds Specboard pages with autosaving rich-text editing;
 * Research (and Architecture) first choose a doc source: an external
 * repository we link out to, or pages held in Specboard. The workspace has the
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

  test("research: connect external, link out, then switch to Specboard", async ({
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

    // Switch the source to Specboard-held pages and create the first page.
    await page.getByRole("button", { name: "Change source" }).click();
    await page.getByRole("button", { name: "Use Specboard" }).click();
    await page.getByRole("button", { name: "New page" }).click();
    await page.getByLabel("New page title").fill("User interviews");
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("button", { name: "User interviews" }),
    ).toBeVisible();
  });

  test("architecture: offers the same source chooser", async ({ page }) => {
    const ws = await getWorkspace();
    await page.goto(`/${ws.slug}/all/architecture`);
    await expect(
      page.getByText("Where does your architecture live?"),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Use Specboard" })).toBeVisible();
  });
});
