import { expect, test } from "@playwright/test";

import { getWorkspace } from "./helpers/db";

/**
 * The mobile shell: below `lg` the desktop rail is hidden and a top app bar with
 * a hamburger opens a left drawer that reuses the sidebar navigation. Runs at a
 * phone viewport so the responsive branches are active.
 */
test.describe("mobile navigation", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("hamburger opens the drawer, navigates, and closes", async ({ page }) => {
    const { slug } = await getWorkspace();
    await page.goto(`/${slug}/all/backlog`);

    // The desktop rail is hidden at this width; the top bar hamburger shows.
    await expect(page.locator("aside")).toBeHidden();
    const hamburger = page.getByRole("button", { name: "Open navigation menu" });
    await expect(hamburger).toBeVisible();
    await expect(hamburger).toHaveAttribute("aria-expanded", "false");

    // Open the drawer: the primary nav becomes reachable. (Radix makes the rest
    // of the page inert while the modal drawer is open, which is why we assert
    // on the drawer content rather than re-querying the now-hidden trigger.)
    await hamburger.click();
    const drawerNav = page.getByRole("navigation", { name: "Primary" });
    await expect(drawerNav).toBeVisible();

    // Following a nav link navigates and closes the drawer.
    await drawerNav.getByRole("link", { name: "Roadmap" }).click();
    await page.waitForURL(`**/${slug}/all/roadmap`);
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeHidden();
  });

  test("Escape closes the drawer", async ({ page }) => {
    const { slug } = await getWorkspace();
    await page.goto(`/${slug}/all/backlog`);

    await page.getByRole("button", { name: "Open navigation menu" }).click();
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeHidden();
  });
});
