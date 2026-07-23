import { expect, test } from "@playwright/test";

import { getWorkspace, resetBoard } from "./helpers/db";

/**
 * Board drag-and-drop: the "drop window" fix. Dragging a card from the bottom of
 * a tall column into a short/empty column must land it there, not snap it back
 * to the source. The board used `closestCorners`, which measured against the
 * nearest card rect: from the bottom of a tall column toward a near-empty one,
 * the nearest corner stayed a source-column card, so the drop no-oped. The fix
 * uses a pointer-based, column-aware collision plus a full-height column drop
 * target. See card "UX Bug: Column drop window fix".
 */
test.describe("board drag-and-drop", () => {
  let workspaceId: string;
  let slug: string;
  test.beforeAll(async () => {
    const ws = await getWorkspace();
    workspaceId = ws.id;
    slug = ws.slug;
  });

  test("drops a bottom-of-tall-column card into an empty column", async ({
    page,
  }) => {
    await resetBoard(workspaceId);

    // Seed a tall Backlog column: every new item defaults to the first status.
    for (let i = 1; i <= 8; i++) {
      const res = await page.request.post("/api/v1/features", {
        data: { title: `Tall card ${i}`, level: "feature" },
      });
      expect(res.ok(), await res.text()).toBeTruthy();
    }

    await page.goto(`/${slug}/all/backlog`);

    const backlog = page.locator('[data-board-column]').filter({
      has: page.getByText("Backlog", { exact: true }),
    });
    const defining = page.locator('[data-board-column]').filter({
      has: page.getByText("Defining", { exact: true }),
    });
    await expect(backlog).toBeVisible();
    await expect(defining).toBeVisible();

    // The Move menu's accessible name carries each card's title; the last one in
    // the Backlog column is the bottom card, the worst case for the old bug.
    const moveButtons = backlog.locator('button[aria-label^="Move Tall card"]');
    await expect(moveButtons.first()).toBeAttached();
    const count = await moveButtons.count();
    const bottomLabel = await moveButtons
      .nth(count - 1)
      .getAttribute("aria-label");
    const bottomTitle = bottomLabel!.replace(/^Move /, "");

    // Drag start: the card wrapper, grabbed low-and-left so the pointerdown lands
    // on the draggable body, not the title <Link> (it stops pointer propagation)
    // nor the Move button (top-right).
    const card = backlog
      .locator("div.group")
      .filter({ has: page.getByText(bottomTitle, { exact: true }) });
    const cardBox = (await card.boundingBox())!;
    const startX = cardBox.x + 24;
    const startY = cardBox.y + cardBox.height - 8;

    // Start the drag: dnd-kit's PointerSensor activates after a 6px move. The
    // page reflows/auto-scrolls once a card lifts, so the target column's live
    // position is measured *after* activation, not from a pre-drag box.
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 10, startY + 6, { steps: 5 });
    await page.waitForTimeout(100);

    // Aim at the center of the target column's drop area (its full height, the
    // "drop across the whole column" case). Feed intermediate moves with a beat
    // between them so the rAF-driven collision tracks the pointer into the
    // target before release.
    const drop = await defining.locator("div.min-h-12").evaluate((el) => {
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.x + r.width / 2),
        y: Math.round(r.y + r.height / 2),
      };
    });
    await page.mouse.move((startX + drop.x) / 2, (startY + drop.y) / 2, {
      steps: 10,
    });
    await page.waitForTimeout(100);
    await page.mouse.move(drop.x, drop.y, { steps: 10 });
    await page.waitForTimeout(150);

    // The drop persists via PATCH; assert it moved to `defining`.
    const [patch] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes("/api/v1/features/") &&
          r.request().method() === "PATCH",
      ),
      page.mouse.up(),
    ]);
    expect(patch.ok(), await patch.text()).toBeTruthy();
    const body = patch.request().postDataJSON() as { status?: string };
    expect(body.status).toBe("defining");

    // And it now lives in the Defining column, not back in Backlog.
    await expect(defining.getByText(bottomTitle, { exact: true })).toBeVisible();
    await expect(
      backlog.getByText(bottomTitle, { exact: true }),
    ).toHaveCount(0);
  });
});
