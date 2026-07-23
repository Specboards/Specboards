import { test } from "@playwright/test";

import { getWorkspace, resetBoard } from "./helpers/db";

const OUT =
  "/private/tmp/claude-501/-Users-jonathanbutler-Documents-Development-Specboards-Specboards/2ba27264-44f9-4c1f-84d2-657f71a92e4a/scratchpad";

test("debug drag", async ({ page }) => {
  const ws = await getWorkspace();
  await resetBoard(ws.id);
  for (let i = 1; i <= 8; i++) {
    await page.request.post("/api/v1/features", {
      data: { title: `Tall card ${i}`, level: "feature" },
    });
  }
  page.on("console", (m) => {
    if (m.text().includes("[dragEnd]")) console.log("BROWSER:", m.text());
  });
  await page.goto(`/${ws.slug}/all/backlog`);

  const backlog = page
    .locator("[data-board-column]")
    .filter({ has: page.getByText("Backlog", { exact: true }) });
  const defining = page
    .locator("[data-board-column]")
    .filter({ has: page.getByText("Defining", { exact: true }) });

  const moveButtons = backlog.locator('button[aria-label^="Move Tall card"]');
  const count = await moveButtons.count();
  const bottomLabel = await moveButtons.nth(count - 1).getAttribute("aria-label");
  const bottomTitle = bottomLabel!.replace(/^Move /, "");
  console.log("BOTTOM TITLE:", bottomTitle, "CARD COUNT:", count);

  const card = backlog
    .locator("div.group")
    .filter({ has: page.getByText(bottomTitle, { exact: true }) });
  const cardBox = (await card.boundingBox())!;
  const targetBox = (await defining.boundingBox())!;
  console.log("CARD BOX:", JSON.stringify(cardBox));
  console.log("TARGET BOX:", JSON.stringify(targetBox));

  const startX = cardBox.x + 24;
  const startY = cardBox.y + cardBox.height - 8;
  const dropX = targetBox.x + targetBox.width / 2;
  const dropY = targetBox.y + targetBox.height - 40;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 12, startY + 6, { steps: 5 });
  await page.waitForTimeout(150);
  // Measure the Defining column and its inner droppable during the drag.
  const rects = await defining.evaluate((col) => {
    const kids = Array.from(col.children).map((c) => {
      const r = c.getBoundingClientRect();
      return {
        cls: (c as HTMLElement).className.slice(0, 40),
        y: Math.round(r.y),
        h: Math.round(r.height),
      };
    });
    const cr = col.getBoundingClientRect();
    return { col: { y: Math.round(cr.y), h: Math.round(cr.height) }, kids };
  });
  console.log("DEFINING RECTS:", JSON.stringify(rects));
  const dropCenter = await defining
    .locator("div.min-h-12")
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
  console.log("DROP CENTER:", JSON.stringify(dropCenter));
  // Is a drag overlay present?
  const overlay1 = await page
    .locator("[data-dnd-kit-drag-overlay], [role='status']")
    .count()
    .catch(() => -1);
  const dragging = await page.evaluate(
    () => document.querySelectorAll("[aria-pressed='true'], .cursor-grabbing").length,
  );
  console.log("AFTER ACTIVATE — overlayish:", overlay1, "grabbingish:", dragging);
  await page.screenshot({ path: `${OUT}/drag-1-activate.png` });

  await page.mouse.move(dropCenter.x, dropCenter.y, { steps: 20 });
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${OUT}/drag-2-overtarget.png` });
  const lastCollide = await page.evaluate(
    () => (window as unknown as { __lastCollide?: string }).__lastCollide,
  );
  console.log("LASTCOLLIDE:", lastCollide);

  await page.mouse.up();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/drag-3-afterdrop.png` });
});
