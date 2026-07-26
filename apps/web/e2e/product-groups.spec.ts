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

    // Create a group. Creation starts as an "Add group" affordance (see the
    // "add" UX rule) that opens a drawer; fill and submit it.
    await page.getByRole("button", { name: "Add group" }).click();
    await page.getByLabel("Name").fill("Payments Platform");
    await page.getByRole("button", { name: "Create group" }).click();
    const groupRow = page
      .locator("li")
      .filter({ hasText: "Payments Platform" })
      .filter({ hasText: "products" });
    await expect(groupRow.getByText("0 products")).toBeVisible();

    // Assign the product to the group via the product's edit drawer (the
    // group select is unique page-wide: `name="groupId"`). The tree re-homes
    // the product under the group, so its roll-up count ticks up.
    const productRow = page.locator("li").filter({ hasText: "Payments API" });
    await productRow.getByRole("button", { name: "Edit" }).click();
    await page
      .locator('select[name="groupId"]')
      .selectOption({ label: "Payments Platform" });
    await page.getByRole("button", { name: "Save" }).click();
    // Fresh locator: groupRow above filters on "products" (plural), which no
    // longer matches once the count reads "1 product".
    await expect(
      page
        .locator("li")
        .filter({ hasText: "Payments Platform" })
        .getByText("1 product", { exact: true }),
    ).toBeVisible();

    // The switcher now offers the group scope; selecting it lands on the
    // group-scoped backlog under the `~key` segment.
    await page.getByLabel("Switch product").selectOption("~payments-platform");
    await expect(page).toHaveURL(new RegExp(`/${ws.slug}/~payments-platform/`));

    // A group scope unlocks a Group dashboard area in the sidebar (distinct from
    // the workspace-wide Dashboard above it); the roll-up shows the group with
    // its one product.
    await page.getByRole("link", { name: "Group dashboard" }).click();
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
    // Open the "Add group" affordance (a drawer) before filling the form.
    await page.getByRole("button", { name: "Add group" }).click();
    await page.getByLabel("Name").fill("Retail");
    await page.getByRole("button", { name: "Create group" }).click();
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
