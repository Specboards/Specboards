import { expect, test } from "@playwright/test";

import { getWorkspace, resetProductGroups } from "./helpers/db";

/**
 * Product groups lifecycle: create a group in Settings, assign a product,
 * scope the app to the group via the switcher (`~key` product segment), and
 * read the roll-up on the group dashboard. Runs entirely on the seeded
 * workspace (no repo connection needed); the admin from global setup drives
 * the real settings forms.
 */
test.describe("settings: product groups", () => {
  test.beforeEach(async () => {
    const ws = await getWorkspace();
    await resetProductGroups(ws.id);
  });

  test("admin can create a group, assign a product, and see the roll-up", async ({
    page,
  }) => {
    const ws = await getWorkspace();
    await page.goto(`/${ws.slug}/settings/products`);

    // Create a second product so the switcher has something to group.
    await page.getByRole("button", { name: "New product" }).click();
    await page.getByLabel("Name").fill("Payments API");
    await page.getByRole("button", { name: "Create product" }).click();
    await expect(
      page.locator("li").filter({ hasText: "Payments API" }),
    ).toBeVisible();

    // Create a group in the Groups card. The form starts as an "Add group"
    // affordance (see the "add" UX rule); open it before filling.
    await page.getByRole("button", { name: "Add group" }).click();
    await page.getByPlaceholder("New group name").fill("Payments Platform");
    await page.getByRole("button", { name: "Add group" }).click();
    const groupRow = page
      .locator("li")
      .filter({ hasText: "Payments Platform" })
      .filter({ hasText: "products" });
    await expect(groupRow.getByText("0 products")).toBeVisible();

    // Assign the product to the group via the product's inline editor. In edit
    // mode the row's name lives in an input (not text), so re-locating by text
    // fails; the group select is unique page-wide (`name="groupId"`; the
    // groups card's own selects use aria-label/parentId).
    const productRow = page.locator("li").filter({ hasText: "Payments API" });
    await productRow.getByRole("button", { name: "Edit" }).click();
    await page
      .locator('select[name="groupId"]')
      .selectOption({ label: "Payments Platform" });
    await page.getByRole("button", { name: "Save" }).click();
    await expect(
      productRow.getByText("Payments Platform", { exact: true }),
    ).toBeVisible();

    // The switcher now offers the group scope; selecting it lands on the
    // group-scoped backlog under the `~key` segment.
    await page.getByLabel("Switch product").selectOption("~payments-platform");
    await expect(page).toHaveURL(new RegExp(`/${ws.slug}/~payments-platform/`));

    // A group scope unlocks the Dashboard area in the sidebar; the roll-up
    // shows the group with its one product.
    await page.getByRole("link", { name: "Dashboard" }).click();
    await expect(
      page.getByRole("heading", { name: "Payments Platform" }),
    ).toBeVisible();
    await expect(page.getByText("1 product ·")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Payments API" }),
    ).toBeVisible();
  });

  test("deleting a populated group is blocked until it is emptied", async ({
    page,
  }) => {
    const ws = await getWorkspace();
    await page.goto(`/${ws.slug}/settings/products`);

    // Group with a member product (created through the real forms). Wait for
    // the product row before touching the group form: creation triggers a
    // router refresh that would wipe a fill raced against it.
    await page.getByRole("button", { name: "New product" }).click();
    await page.getByLabel("Name").fill("Cards");
    await page.getByRole("button", { name: "Create product" }).click();
    const cardsRow = page.locator("li").filter({ hasText: "Cards" });
    await expect(cardsRow).toBeVisible();
    // Open the "Add group" affordance before filling the group form.
    await page.getByRole("button", { name: "Add group" }).click();
    await page.getByPlaceholder("New group name").fill("Retail");
    await page.getByRole("button", { name: "Add group" }).click();
    await cardsRow.getByRole("button", { name: "Edit" }).click();
    await page
      .locator('select[name="groupId"]')
      .selectOption({ label: "Retail" });
    await page.getByRole("button", { name: "Save" }).click();

    // The group row's Delete stays disabled while it holds a product.
    const retailRow = page
      .locator("li")
      .filter({ hasText: "Retail" })
      .filter({ hasText: "1 product" });
    await expect(
      retailRow.getByRole("button", { name: "Delete" }),
    ).toBeDisabled();

    // Move the product out; Delete unlocks and removes the group.
    await cardsRow.getByRole("button", { name: "Edit" }).click();
    await page
      .locator('select[name="groupId"]')
      .selectOption({ label: "No group" });
    await page.getByRole("button", { name: "Save" }).click();
    const emptyRetailRow = page
      .locator("li")
      .filter({ hasText: "Retail" })
      .filter({ hasText: "0 products" });
    await emptyRetailRow.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText("Retail")).toHaveCount(0);
  });
});
