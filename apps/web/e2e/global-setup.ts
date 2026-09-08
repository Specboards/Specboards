import { chromium } from "@playwright/test";

import { ADMIN, BASE_URL, ORG_NAME, STORAGE_STATE } from "./helpers/constants";
import { truncateAll } from "./helpers/db";
import { resetFixture } from "./helpers/github";

/**
 * Global setup: start from a clean database, provision the first user (who
 * becomes the workspace admin) through the real sign-up -> sign-in -> setup UI,
 * and save the authenticated browser state for every test to reuse. Under
 * SPECBOARDS_E2E the email-verification gate is off, so sign-in works without a
 * mailbox.
 */
export default async function globalSetup() {
  await truncateAll();
  resetFixture();

  const browser = await chromium.launch();
  const page = await browser.newPage({ baseURL: BASE_URL });

  // Sign up. Where verification is not required, and it is not here, the
  // response carries a session and the app moves straight on. It used to stop
  // on "check your email" even in E2E because the form discarded that session
  // and showed the wall unconditionally, which is the same bug that locked the
  // first admin out of a self-host with no mail transport.
  await page.goto("/sign-up");
  // The instance is unclaimed, so the first account has to present the
  // first-run token. The field only renders while that is true.
  const tokenField = page.locator('input[name="signUpCode"]');
  if (await tokenField.count()) {
    await tokenField.fill(process.env.SPECBOARDS_BOOTSTRAP_TOKEN!);
  }
  await page.fill('input[name="name"]', ADMIN.name);
  await page.fill('input[name="email"]', ADMIN.email);
  await page.fill('input[name="password"]', ADMIN.password);
  await page.fill('input[name="confirmPassword"]', ADMIN.password);
  // The submit button is "Sign up" normally and "Create admin account" on a
  // first run (no users yet), which is exactly what a truncated database is.
  //
  // Matching only "Sign up" happened to work in CI for a reason worth writing
  // down: `hasAnyUser` caches its answer in a module-level flag, and the rows
  // the integration suite leaves in this same database prime that cache to
  // "yes" when Playwright health-checks the web server, before `truncateAll`
  // below runs. On a genuinely clean database -- a contributor running the E2E
  // suite locally -- the first-run copy renders and setup could not get past
  // this line. Accept both rather than depend on that accident.
  await page
    .getByRole("button", { name: /^(Sign up|Create admin account)$/ })
    .click();
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-up"));

  // Fallback for a configuration that does gate on verification, where sign-up
  // lands on the verify screen and the session has to be picked up separately.
  if (new URL(page.url()).pathname.startsWith("/sign-in")) {
    await page.fill('input[name="email"]', ADMIN.email);
    await page.fill('input[name="password"]', ADMIN.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"));
  }

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
    (url) =>
      !url.pathname.startsWith("/setup") &&
      !url.pathname.startsWith("/sign-in"),
  );

  await page.context().storageState({ path: STORAGE_STATE });
  await browser.close();
}
