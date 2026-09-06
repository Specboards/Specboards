import { expect, test } from "@playwright/test";

import { getWorkspace, resetBoard, seedInstallation } from "./helpers/db";
import { resetFixture } from "./helpers/github";

test.describe("onboarding: one-click dedicated spec repo", () => {
  test("creates and connects a spec repo from the nudge", async ({ page }) => {
    const ws = await getWorkspace();
    await resetBoard(ws.id); // no connected repos
    resetFixture();

    // An organization installation bound to the workspace (as the setup
    // callback would persist it) unlocks the one-click create form.
    await seedInstallation({ workspaceId: ws.id, accountLogin: "acme" });

    await page.goto(`/${ws.slug}/settings/repositories`);

    const summary = page.getByText("Prefer a dedicated repo just for specs?");
    await expect(summary).toBeVisible();
    await summary.click();

    // The one-click form replaces the instructions-first experience.
    const nameInput = page.getByLabel("Repository name");
    await expect(nameInput).toHaveValue("specs");
    await page.getByRole("button", { name: /Create and connect/i }).click();

    // The repo is connected, so the import panel takes over with the guided
    // "create your first spec" empty state pointed at the new repo.
    await expect(
      page.getByText(/didn.?t find any specs in your connected repositories/i),
    ).toBeVisible();
    // Name the connected row, not any element mentioning the repo. The row's
    // heading is a <p> whose whole text is the repo name; the form's own
    // "Created and connected acme/specs..." confirmation (which now stays on
    // screen beside the row) links the same name inside a longer sentence, and
    // the write-mode control labels it too.
    await expect(
      page.locator("p").filter({ hasText: /^acme\/specs$/ }),
    ).toBeVisible();
  });

  test("lists the new repo without waiting for the server to re-render", async ({ page }) => {
    // The defect this guards: on a fresh instance the connected-repositories
    // panel kept saying "No repositories connected" next to the form's own
    // "Created and connected acme/specs", and only a manual reload fixed it.
    //
    // The test above does not catch that, because Playwright retries until the
    // eventual `router.refresh()` lands -- which is exactly the slow path a
    // person reads as broken. So this one holds the RSC refresh back and
    // asserts against the client state alone: if the created repo is not
    // handed up to the connected list, nothing here resolves in time.
    const ws = await getWorkspace();
    await resetBoard(ws.id);
    resetFixture();
    await seedInstallation({ workspaceId: ws.id, accountLogin: "acme" });

    await page.goto(`/${ws.slug}/settings/repositories`);
    await expect(page.getByText("No repositories connected")).toBeVisible();

    // Registered after the page has loaded, so the only remaining requests to
    // this path are the router.refresh() payloads. Holding them leaves the
    // client state as the only thing that can update the list.
    let refreshesHeld = 0;
    await page.route(
      // The repositories UI is a tab of the integrations page, so this is the
      // path router.refresh() re-fetches; /settings/repositories only redirects
      // here and is never requested again.
      (url) => url.pathname.includes("/settings/integrations"),
      async (route) => {
        refreshesHeld++;
        await new Promise((resolve) => setTimeout(resolve, 15_000));
        await route.continue();
      },
    );

    await page.getByText("Prefer a dedicated repo just for specs?").click();
    await page.getByRole("button", { name: /Create and connect/i }).click();

    await expect(page.getByText(/Created and connected/i)).toBeVisible();

    // The two statements that used to contradict each other, checked together.
    // "Re-sync" belongs to a connected repo row and the empty state has no
    // buttons, so it names the row rather than the success message's own link
    // to the same owner/name.
    await expect(page.getByRole("button", { name: "Re-sync" })).toBeVisible({
      timeout: 3000,
    });
    await expect(page.getByText("No repositories connected")).toHaveCount(0, {
      timeout: 3000,
    });

    // Guards the guard: if nothing was actually held back, the assertions above
    // could have been satisfied by the server re-render and would not prove
    // anything about the client state.
    expect(refreshesHeld).toBeGreaterThan(0);
  });

  test("keeps the manual instructions for personal-account installations", async ({ page }) => {
    const ws = await getWorkspace();
    await resetBoard(ws.id);
    resetFixture();

    await seedInstallation({ workspaceId: ws.id, accountLogin: "jane", accountType: "User" });

    await page.goto(`/${ws.slug}/settings/repositories`);

    const summary = page.getByText("Prefer a dedicated repo just for specs?");
    await summary.click();

    // No create form (GitHub can't create repos under a personal account via
    // installation tokens), but the deep-link fallback is there.
    await expect(page.getByRole("button", { name: /Create and connect/i })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Create a repo on GitHub/i })).toBeVisible();
  });
});
