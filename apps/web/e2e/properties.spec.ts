import { expect, test } from "@playwright/test";

import {
  getWorkspace,
  resetDetailTemplates,
  resetProperties,
} from "./helpers/db";

/**
 * Custom properties CRUD in Cards settings (admin-only). Drives the real
 * create -> edit -> delete flow in the properties manager; a select-typed
 * property also exercises the options field. Each phase asserts the API
 * response and reloads before the next, so an in-flight router.refresh() from
 * the previous step can't remount a row and clobber typed input.
 */
test.describe("settings: custom properties", () => {
  test.beforeEach(async () => {
    const ws = await getWorkspace();
    await resetProperties(ws.id);
    // The Cards settings page also lists detail templates; clear any left by
    // another spec so this page has a single "Save" (the property row).
    await resetDetailTemplates(ws.id);
  });

  test("admin can create, rename, and delete a custom property", async ({
    page,
  }) => {
    const ws = await getWorkspace();
    await page.goto(`/${ws.slug}/settings/work-cards`);

    // Cards settings sections are collapsed by default; open Fields to reach the
    // custom-properties manager. The choice persists (localStorage) across the
    // reloads below.
    await page.getByRole("button", { name: /^Fields/ }).click();

    // Adding starts as an "Add property" affordance (see the "add" UX rule);
    // open the create form before filling it.
    await page.getByRole("button", { name: "Add property" }).click();

    // Create a select-typed property with options.
    const createForm = page.getByRole("group", { name: "New property" });
    await createForm.getByLabel("Label").fill("Effort");
    await createForm.getByLabel("Type").selectOption("select");
    await createForm.getByLabel("Options (comma-separated)").fill("S, M, L");
    const [createResp] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes("/api/v1/properties") &&
          r.request().method() === "POST",
      ),
      createForm.getByRole("button", { name: "Add property" }).click(),
    ]);
    expect(createResp.ok()).toBeTruthy();
    await page.reload();

    // The saved property surfaces as an editable row above the create form, so
    // its label input is the first "Label" textbox on the page.
    const rowLabel = page.getByRole("textbox", { name: "Label" }).first();
    await expect(rowLabel).toHaveValue("Effort");

    // Rename it and save; assert the PATCH persisted, then reload to read it back.
    await rowLabel.fill("Sizing");
    const [saveResp] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes("/api/v1/properties/") &&
          r.request().method() === "PATCH",
      ),
      page.getByRole("button", { name: "Save", exact: true }).click(),
    ]);
    expect(saveResp.ok()).toBeTruthy();
    await page.reload();
    await expect(
      page.getByRole("textbox", { name: "Label" }).first(),
    ).toHaveValue("Sizing");

    // Delete it (confirm dialog auto-accepted). With no properties left the
    // manager collapses back to the empty state (no open form), so no "Label"
    // textbox remains.
    page.once("dialog", (dialog) => dialog.accept());
    const [deleteResp] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes("/api/v1/properties/") &&
          r.request().method() === "DELETE",
      ),
      page.getByRole("button", { name: "Delete", exact: true }).click(),
    ]);
    expect(deleteResp.ok()).toBeTruthy();
    await page.reload();
    await expect(page.getByText("No custom properties yet")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Label" })).toHaveCount(0);
  });
});
