import { expect, test } from "@playwright/test";

/**
 * Form semantics (WCAG 1.3.1, 3.3.1, 4.1.3). Complements the axe sweep with
 * behavioural checks the static scan cannot make: that controls resolve to their
 * visible label, and that a validation error is exposed as an announced status.
 */
test.describe("form semantics", () => {
  // The auth forms are the public surface; scan them logged out.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("sign-in fields resolve to their visible labels", async ({ page }) => {
    await page.goto("/sign-in");
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  });

  test("mismatched passwords surface an announced alert", async ({ page }) => {
    await page.goto("/sign-up");
    await page.getByLabel("Name").fill("Test User");
    await page.getByLabel("Email").fill("test@example.com");
    await page.getByLabel("Password", { exact: true }).fill("password123");
    await page.getByLabel("Confirm password").fill("different456");
    await page.getByRole("button", { name: "Sign up" }).click();

    // FormError renders role="alert" (assertive live region) with the message.
    // Next.js mounts its own empty route-announcer alert, so match by text.
    await expect(
      page.getByRole("alert").filter({ hasText: "Passwords don't match." }),
    ).toBeVisible();
  });
});
