import { expect, test } from "@playwright/test";

import { getWorkspace, resetBoard } from "./helpers/db";

/**
 * Opening an item with the Assistant section left expanded.
 *
 * The section's open/closed choice is remembered per browser, so this is the
 * ordinary state for anyone who has used the assistant once, on that device.
 * It used to take the whole item panel down: the conversation hook reset itself
 * on the loader's identity rather than on the subject it loads, so every render
 * handed it a key that had "changed", which set state during render, which
 * rendered again. React gave up with "Too many re-renders" and discarded the
 * tree; on iOS Safari the runaway loop got the tab's web process killed and the
 * reader saw "This page couldn't load".
 *
 * Two assertions, because the loop had two visible halves: the panel is gone,
 * and the thread is fetched once per render rather than once per item.
 */
test.describe("item panel with the Assistant section expanded", () => {
  test.beforeEach(async () => {
    const ws = await getWorkspace();
    await resetBoard(ws.id);
  });

  test("opens the item and loads the thread once", async ({ page }) => {
    const ws = await getWorkspace();

    // The section state lives in localStorage, so seed it before the app boots.
    await page.addInitScript(() => {
      window.localStorage.setItem(
        "specboard:item-detail:sections",
        JSON.stringify({ assistant: false }),
      );
    });

    const res = await page.request.post("/api/v1/features", {
      data: { title: "Assistant probe", level: "feature" },
    });
    expect(res.ok(), await res.text()).toBeTruthy();

    let threadRequests = 0;
    page.on("request", (r) => {
      if (/\/api\/v1\/assistant\/[^/]+$/.test(new URL(r.url()).pathname)) {
        threadRequests += 1;
      }
    });

    await page.goto(`/${ws.slug}/all/backlog`);
    await page.getByRole("link", { name: "Assistant probe" }).click();

    // The panel rendered, with the Assistant section open, rather than the tree
    // being torn down by the loop.
    await expect(
      page.getByRole("heading", { name: "Assistant probe" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Assistant" }),
    ).toHaveAttribute("aria-expanded", "true");

    // One thread load for the one item. The loop made this climb without bound
    // for as long as the panel stayed on screen.
    await page.waitForTimeout(1500);
    expect(threadRequests).toBeLessThan(3);
  });
});
