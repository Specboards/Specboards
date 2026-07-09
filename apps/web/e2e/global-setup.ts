import { chromium } from "@playwright/test";

import { ADMIN, BASE_URL, ORG_NAME, STORAGE_STATE } from "./helpers/constants";
import { truncateAll } from "./helpers/db";
import { resetFixture } from "./helpers/github";

/**
 * Global setup: start from a clean database, provision the first user (who
 * becomes the workspace admin) through the real sign-up -> sign-in -> setup UI,
 * and save the authenticated browser state for every test to reuse. Under
 * SPECBOARD_E2E the email-verification gate is off, so sign-in works without a
 * mailbox. See docs/archive/PLAN-e2e-playwright.md.
 */
export default async function globalSetup() {
  await truncateAll();
  resetFixture();

  const browser = await chromium.launch();
  const page = await browser.newPage({ baseURL: BASE_URL });

  // Sign up. The form always lands on "check your email" (no session yet).
  await page.goto("/sign-up");
  await page.fill('input[name="name"]', ADMIN.name);
  await page.fill('input[name="email"]', ADMIN.email);
  await page.fill('input[name="password"]', ADMIN.password);
  await page.fill('input[name="confirmPassword"]', ADMIN.password);
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.getByText("Check your email").waitFor();

  // Sign in (verification gate is relaxed in E2E), then wait for the session.
  await page.goto("/sign-in");
  await page.fill('input[name="email"]', ADMIN.email);
  await page.fill('input[name="password"]', ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"));

  // First user with no workspace: name the org and start empty -> becomes admin.
  // The app redirects a session with no workspace to /setup on its own, and a
  // hard goto can race that in-flight redirect ("interrupted by another
  // navigation"), so prefer landing there via the app and only navigate
  // explicitly if we settled somewhere else.
  await page
    .waitForURL("**/setup", { timeout: 15_000 })
    .catch(() => page.goto("/setup"));
  await page.fill('input[name="name"]', ORG_NAME);
  await page.locator('input[name="start"][value="empty"]').check();
  await page.getByRole("button", { name: "Create organization" }).click();
  await page.waitForURL(
    (url) => !url.pathname.startsWith("/setup") && !url.pathname.startsWith("/sign-in"),
  );

  await page.context().storageState({ path: STORAGE_STATE });
  await browser.close();
}
