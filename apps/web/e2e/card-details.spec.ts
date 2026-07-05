import { expect, test } from "@playwright/test";

import { getWorkspace, resetBoard, resetReleases } from "./helpers/db";

/**
 * Creating a DB-native card from the Roadmap now captures a Details body (rich
 * text stored as Markdown) alongside title/status. This drives the real create
 * drawer end to end and confirms the body renders in the item preview panel that
 * a Roadmap card opens (the same in-context panel the Backlog board uses).
 */
test.describe("roadmap: create card with details", () => {
  test.beforeEach(async () => {
    const ws = await getWorkspace();
    await resetBoard(ws.id);
    await resetReleases(ws.id);
  });

  test("admin creates a feature with a details body that renders on the item", async ({
    page,
  }) => {
    const ws = await getWorkspace();
    // The Roadmap defaults to the Feature altitude, which is DB-native.
    await page.goto(`/${ws.slug}/all/roadmap`);

    await page.getByRole("button", { name: "New feature" }).click();
    await page.getByLabel("Title").fill("Login flow");

    // Type into the rich-text editor (contenteditable); it serializes to
    // Markdown behind the scenes and mirrors into the hidden `details` field.
    const editor = page.locator(".tiptap");
    await editor.click();
    await page.keyboard.type("Problem statement for the login flow.");

    const [createResp] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes("/api/v1/features") &&
          r.request().method() === "POST",
      ),
      page.getByRole("button", { name: "Create feature" }).click(),
    ]);
    expect(createResp.ok()).toBeTruthy();

    // The new card appears on the board; clicking its title opens the preview
    // panel (an in-context drawer, not a full-page navigation).
    await page.getByRole("button", { name: "Login flow", exact: true }).click();

    // The details body shows in the panel (in the editable rich-text surface,
    // since the admin can edit).
    await expect(
      page.getByText("Problem statement for the login flow."),
    ).toBeVisible();

    // Edit the details after creation. Saves are automatic (debounced), with no
    // Save button: typing into the editor triggers a PATCH on its own.
    const itemEditor = page.locator(".tiptap");
    await itemEditor.click();
    await page.keyboard.press("End");
    const [patchResp] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes("/api/v1/features/") &&
          r.request().method() === "PATCH",
      ),
      page.keyboard.type(" (updated)."),
    ]);
    expect(patchResp.ok()).toBeTruthy();

    // Reload wipes the client-only panel state; reopening the card re-fetches
    // from the API, proving the edit persisted server-side.
    await page.reload();
    await page.getByRole("button", { name: "Login flow", exact: true }).click();
    await expect(
      page.getByText("Problem statement for the login flow. (updated)."),
    ).toBeVisible();
  });
});
