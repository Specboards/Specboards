import { expect, test } from "@playwright/test";

import { getWorkspace, resetBoard, seedRepository } from "./helpers/db";
import { getRepoFiles, resetFixture } from "./helpers/github";

/**
 * Creating a spec from the app, both ways it can happen.
 *
 * As with spec editing, the assertions that matter are about **git**: the spec
 * file is canonical and `spec_index` is a cache, so a test that only read the
 * screen could pass with nothing committed. Each case therefore reads the fake
 * repo's files back.
 *
 * The two cases are genuinely different outcomes, which is why both are here:
 *
 * - **Attach** must write the *existing item's own id* into the frontmatter.
 *   Get that wrong and the sync does not recognise the file as that row, so the
 *   board ends up with two cards for one piece of work and the original's
 *   status, assignee and history are stranded on the wrong one.
 * - **New spec under a card** must end up nested. The create and the parenting
 *   are two operations, and a spec left unparented lands at the top of the
 *   board under an auto-created grouping, which is tedious to untangle by hand.
 */

const OWNER = "acme";
const REPO = "widgets";

test.describe("spec creation: bring a spec into existence from the app", () => {
  test.beforeEach(async () => {
    const ws = await getWorkspace();
    await resetBoard(ws.id);
    resetFixture();
    await seedRepository({ workspaceId: ws.id, owner: OWNER, name: REPO });
  });

  test("attaches a spec to an existing card, keeping the card's identity and body", async ({
    page,
  }) => {
    const ws = await getWorkspace();

    // A leaf item somebody has been tracking in the app, with a description
    // they have already written into it.
    const created = await page.request.post("/api/v1/features", {
      data: {
        title: "Refund window",
        level: "work",
        details: "## Problem\n\nRefunds are capped at 30 days.\n",
      },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    const specId = (await created.json()).feature.specId as string;

    await page.goto(`/${ws.slug}/all/backlog/work/${specId}`);

    const attach = page.getByRole("button", { name: /Attach a spec/i });
    await expect(attach).toBeVisible();
    await attach.click();

    // Scoped to the form: the item's own header also renders a path once the
    // spec exists, so an unscoped match would be ambiguous after the write.
    const form = page.locator("form").filter({ hasText: /Commits a spec file/ });
    // The form names the exact file it is about to commit, so the author is
    // never guessing where their document went.
    await expect(form.getByText("specs/refund-window/spec.md")).toBeVisible();

    const [resp] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/v1/specs") && r.request().method() === "POST",
      ),
      form.getByRole("button", { name: /^Attach spec$/i }).click(),
    ]);
    expect(resp.ok(), await resp.text()).toBeTruthy();

    // What landed in git.
    const raw = getRepoFiles(OWNER, REPO)["specs/refund-window/spec.md"];
    expect(raw).toBeDefined();
    // The card's own id, not a fresh one: this is what makes the sync link the
    // file to the row that is already on the board instead of creating a second.
    expect(raw).toContain(`id: ${specId}`);
    expect(raw).toContain("Refund window");
    // The description the author had already written came with it. Once a spec
    // is attached the board reads the body from the file, so a description left
    // behind in the database would read as the app having eaten their work.
    expect(raw).toContain("Refunds are capped at 30 days.");
    // And the stub did not win: seeding replaced it rather than being appended.
    expect(raw).not.toContain("Describe this spec.");

    // One item, not two, and it is now spec-backed.
    const after = await page.request.get(`/api/v1/features/${specId}`);
    expect(after.ok()).toBeTruthy();
    const feature = (await after.json()).feature;
    expect(feature.isDbNative).toBe(false);
    expect(feature.path).toBe("specs/refund-window/spec.md");
  });

  test("carries a description typed in the same session into the spec", async ({
    page,
  }) => {
    const ws = await getWorkspace();

    // No description at create time: the author writes it on the page, then
    // attaches straight away. The client's copy of the item is stale by then,
    // which is exactly why the seeding is the server's job. An earlier version
    // sent the body from the browser and silently shipped the stub instead,
    // leaving the author's paragraph in a column nothing renders any more.
    const created = await page.request.post("/api/v1/features", {
      data: { title: "Dispute window", level: "work", details: "" },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    const specId = (await created.json()).feature.specId as string;

    await page.goto(`/${ws.slug}/all/backlog/work/${specId}`);

    const editor = page.locator(".tiptap");
    await editor.click();
    await page.keyboard.type("Disputes must be answerable for 60 days.");
    // The card's body autosaves; wait for it to land before attaching.
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: /Attach a spec/i }).click();
    const form = page.locator("form").filter({ hasText: /Commits a spec file/ });
    const [resp] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/v1/specs") && r.request().method() === "POST",
      ),
      form.getByRole("button", { name: /^Attach spec$/i }).click(),
    ]);
    expect(resp.ok(), await resp.text()).toBeTruthy();

    const raw = getRepoFiles(OWNER, REPO)["specs/dispute-window/spec.md"];
    expect(raw).toBeDefined();
    expect(raw).toContain("Disputes must be answerable for 60 days.");
    expect(raw).not.toContain("Describe this spec.");
  });

  test("creates a new spec under a parent card and nests it there", async ({
    page,
  }) => {
    const ws = await getWorkspace();

    const created = await page.request.post("/api/v1/features", {
      data: { title: "Payments", level: "feature" },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    const parentSpecId = (await created.json()).feature.specId as string;

    await page.goto(`/${ws.slug}/all/backlog/feature/${parentSpecId}`);

    // The child controls live in the collapsed Relationships section.
    await page.getByRole("button", { name: /Relationships/i }).click();
    await page.getByRole("button", { name: /New spec/i }).click();

    const form = page
      .locator("form")
      .filter({ hasText: /Creates a spec and nests it under/ });
    await form.getByRole("textbox").fill("Chargeback handling");
    await expect(
      form.getByText("specs/chargeback-handling/spec.md"),
    ).toBeVisible();

    const [resp] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/v1/specs") && r.request().method() === "POST",
      ),
      form.getByRole("button", { name: /^Create spec$/i }).click(),
    ]);
    expect(resp.ok(), await resp.text()).toBeTruthy();
    const body = await resp.json();
    // Nothing went half-done: had the parenting failed, the route would say so
    // here rather than silently leaving the spec at the top of the board.
    expect(body.parentWarning).toBeUndefined();

    const raw = getRepoFiles(OWNER, REPO)["specs/chargeback-handling/spec.md"];
    expect(raw).toBeDefined();
    expect(raw).toContain("Chargeback handling");

    // Nested under the card it was created from, in the same user action.
    const child = await page.request.get(
      `/api/v1/features/${body.spec.specId}`,
    );
    expect(child.ok()).toBeTruthy();
    expect((await child.json()).feature.parentSpecId).toBe(parentSpecId);
  });

  test("refuses a title whose file already exists, and says to rename it", async ({
    page,
  }) => {
    const ws = await getWorkspace();

    const first = await page.request.post("/api/v1/features", {
      data: { title: "Refund window", level: "work" },
    });
    const firstId = (await first.json()).feature.specId as string;
    const attachFirst = await page.request.post("/api/v1/specs", {
      data: { title: "Refund window", workItemId: firstId },
    });
    expect(attachFirst.ok(), await attachFirst.text()).toBeTruthy();

    // A second item whose title slugs to the same path.
    const second = await page.request.post("/api/v1/features", {
      data: { title: "Refund Window!", level: "work" },
    });
    const secondId = (await second.json()).feature.specId as string;

    await page.goto(`/${ws.slug}/all/backlog/work/${secondId}`);
    await page.getByRole("button", { name: /Attach a spec/i }).click();
    const form = page.locator("form").filter({ hasText: /Commits a spec file/ });
    await form.getByRole("button", { name: /^Attach spec$/i }).click();

    // The collision is reported next to the field the author has to change,
    // which is what makes it a rename prompt rather than a dead end. The form
    // stays open with their title in it, so renaming is one edit away.
    await expect(form.getByText(/already exists/i)).toBeVisible();
    await expect(form.getByText(/Pick a different title/i)).toBeVisible();

    // The first spec is untouched: a refused create must not overwrite it.
    const raw = getRepoFiles(OWNER, REPO)["specs/refund-window/spec.md"];
    expect(raw).toContain(`id: ${firstId}`);
  });
});
