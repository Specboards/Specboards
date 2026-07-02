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
    await expect(page.getByText("acme/specs")).toBeVisible();
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
