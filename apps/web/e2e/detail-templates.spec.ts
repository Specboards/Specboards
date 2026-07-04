import { expect, test } from "@playwright/test";

import { getWorkspace, resetDetailTemplates } from "./helpers/db";

/**
 * Admin-defined detail templates in Cards settings: create a template, assign
 * it as the default for a level, and confirm both persist across a reload.
 */
test.describe("settings: detail templates", () => {
  test.beforeEach(async () => {
    const ws = await getWorkspace();
    await resetDetailTemplates(ws.id);
  });

  test("admin creates a template and assigns it to a level", async ({
    page,
  }) => {
    const ws = await getWorkspace();
    await page.goto(`/${ws.slug}/settings/work-cards`);

    // Create a template. With none yet, the only Name field and rich-text
    // editor on the page belong to the create form.
    await page
      .getByRole("textbox", { name: "Name", exact: true })
      .fill("Feature spec");
    await page.locator(".tiptap").click();
    await page.keyboard.type("Problem to solve");
    const [createResp] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().endsWith("/api/v1/detail-templates") &&
          r.request().method() === "POST",
      ),
      page.getByRole("button", { name: "Add template" }).click(),
    ]);
    expect(createResp.ok()).toBeTruthy();
    const { template } = (await createResp.json()) as {
      template: { id: string };
    };

    await page.reload();
    await expect(
      page.getByRole("textbox", { name: "Name" }).first(),
    ).toHaveValue("Feature spec");

    // Assign it as the Feature level's default and save.
    await page
      .getByLabel("Template for Feature")
      .selectOption({ label: "Feature spec" });
    const [assignResp] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes("/api/v1/levels/templates") &&
          r.request().method() === "PUT",
      ),
      page.getByRole("button", { name: "Save assignments" }).click(),
    ]);
    expect(assignResp.ok()).toBeTruthy();

    // The assignment persists across a reload.
    await page.reload();
    await expect(page.getByLabel("Template for Feature")).toHaveValue(
      template.id,
    );
  });
});
