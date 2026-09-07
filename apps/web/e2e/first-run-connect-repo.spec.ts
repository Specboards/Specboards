import { expect, test } from "@playwright/test";

import { getWorkspace, resetBoard, seedRepository } from "./helpers/db";
import { resetFixture } from "./helpers/github";

/**
 * A fresh instance has to name its own next step.
 *
 * Found on an on-prem run: after creating the admin account, nothing anywhere
 * offered to connect a repository. The dashboard reported "0 items", the
 * backlog offered only "New feature" (which creates a card with no spec behind
 * it), and the sidebar had no setup entry. For a product whose premise is
 * git-backed specs, the empty state pointed at the one path that never involves
 * git, and an operator could build a whole board before being told out of band
 * that they had set it up wrong.
 *
 * The leaf board already said it. These are the two screens a new operator
 * actually lands on, which did not.
 */
test.describe("first run: connect a repository", () => {
  const PROMPT = /Connect a repository to finish setting up/i;

  test("offers it on the dashboard and the backlog while nothing is connected", async ({
    page,
  }) => {
    const ws = await getWorkspace();
    await resetBoard(ws.id); // no repositories, no items
    resetFixture();

    await page.goto(`/${ws.slug}/dashboard`);
    await expect(page.getByText(PROMPT)).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Connect a repository" }),
    ).toBeVisible();

    // The backlog opens on a non-leaf level, which is the empty board the
    // report described: "No feature items yet" and one button, "New feature".
    await page.goto(`/${ws.slug}/all/backlog`);
    await expect(page.getByText(PROMPT)).toBeVisible();

    // And the table view of the same empty level.
    await page.goto(`/${ws.slug}/all/backlog?view=list`);
    await expect(page.getByText(PROMPT)).toBeVisible();
  });

  test("takes the reader to the page that can connect one", async ({ page }) => {
    const ws = await getWorkspace();
    await resetBoard(ws.id);
    resetFixture();

    await page.goto(`/${ws.slug}/dashboard`);
    await page.getByRole("link", { name: "Connect a repository" }).click();

    // /settings/repositories is the stable entry point and lands on the
    // repositories tab of the integrations page. Assert on the destination's
    // own empty state: "Connect a repository" is the card heading there AND
    // the prompt's link text, so it names both while the navigation settles.
    await page.waitForURL(/\/settings\/(repositories|integrations)/);
    await expect(page.getByText("No repositories connected")).toBeVisible();
    await expect(page.getByText(PROMPT)).toHaveCount(0);
  });

  test("goes away once a repository is connected", async ({ page }) => {
    // The prompt is setup guidance, so it exists only while there is setup to
    // do. A workspace that has connected something must never see it again.
    const ws = await getWorkspace();
    await resetBoard(ws.id);
    resetFixture();
    await seedRepository({ workspaceId: ws.id, owner: "acme", name: "specs" });

    await page.goto(`/${ws.slug}/dashboard`);
    await expect(page.getByText(PROMPT)).toHaveCount(0);

    await page.goto(`/${ws.slug}/all/backlog`);
    await expect(page.getByText(PROMPT)).toHaveCount(0);
  });
});
