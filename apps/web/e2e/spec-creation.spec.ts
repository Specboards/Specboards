import { expect, test } from "@playwright/test";

import {
  getWorkspace,
  resetBoard,
  resetDetailTemplates,
  seedRepository,
} from "./helpers/db";
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
 * - **New Work Item under a card** must end up nested. The create and the parenting
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
    const form = page.locator("form").filter({ hasText: /Documents this item/ });
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
    const form = page.locator("form").filter({ hasText: /Documents this item/ });
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
    await page.getByRole("button", { name: /New Work Item/i }).click();

    const form = page
      .locator("form")
      .filter({ hasText: /Creates a new Work Item under/ });
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

  test("starts a new spec from the picked template, and from the level default", async ({
    page,
  }) => {
    const ws = await getWorkspace();
    await resetDetailTemplates(ws.id);

    // Two templates: one the author picks, one the workspace has assigned to
    // the leaf level as its default.
    const picked = await page.request.post("/api/v1/detail-templates", {
      data: { name: "Bug report", body: "## Steps to reproduce\n\n1. \n" },
    });
    expect(picked.ok(), await picked.text()).toBeTruthy();
    const pickedId = (await picked.json()).template.id as string;

    const fallback = await page.request.post("/api/v1/detail-templates", {
      data: { name: "House style", body: "## Problem\n\n## Out of scope\n" },
    });
    expect(fallback.ok(), await fallback.text()).toBeTruthy();
    const fallbackId = (await fallback.json()).template.id as string;

    const assign = await page.request.put("/api/v1/levels/templates", {
      data: { templates: { work: fallbackId } },
    });
    expect(assign.ok(), await assign.text()).toBeTruthy();

    const parent = await page.request.post("/api/v1/features", {
      data: { title: "Payments", level: "feature" },
    });
    const parentSpecId = (await parent.json()).feature.specId as string;

    await page.goto(`/${ws.slug}/all/backlog/feature/${parentSpecId}`);
    await page.getByRole("button", { name: /Relationships/i }).click();
    await page.getByRole("button", { name: /New Work Item/i }).click();

    const form = page
      .locator("form")
      .filter({ hasText: /Creates a new Work Item under/ });
    await form.getByRole("textbox").fill("Card declines");
    await form.getByLabel(/Start from/i).selectOption({ label: "Bug report" });

    const [resp] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/v1/specs") && r.request().method() === "POST",
      ),
      form.getByRole("button", { name: /^Create spec$/i }).click(),
    ]);
    expect(resp.ok(), await resp.text()).toBeTruthy();

    const withTemplate = getRepoFiles(OWNER, REPO)["specs/card-declines/spec.md"];
    expect(withTemplate).toContain("## Steps to reproduce");
    // The template replaced the stub rather than being tacked on beside it.
    expect(withTemplate).not.toContain("Describe this spec.");
    // And the picked template won over the level's default.
    expect(withTemplate).not.toContain("## Out of scope");
    expect(pickedId).not.toBe(fallbackId);

    // Leaving the picker on "Workspace default" falls through to the template
    // the level is configured with, which is the whole point of the default:
    // an author who chooses nothing still gets the team's sections.
    await page.getByRole("button", { name: /New Work Item/i }).click();
    const second = page
      .locator("form")
      .filter({ hasText: /Creates a new Work Item under/ });
    await second.getByRole("textbox").fill("Refund latency");
    const [resp2] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/v1/specs") && r.request().method() === "POST",
      ),
      second.getByRole("button", { name: /^Create spec$/i }).click(),
    ]);
    expect(resp2.ok(), await resp2.text()).toBeTruthy();

    const withDefault = getRepoFiles(OWNER, REPO)["specs/refund-latency/spec.md"];
    expect(withDefault).toContain("## Problem");
    expect(withDefault).toContain("## Out of scope");
    expect(withDefault).not.toContain("Describe this spec.");
  });

  test("a template never displaces what the author already wrote", async ({
    page,
  }) => {
    const ws = await getWorkspace();
    await resetDetailTemplates(ws.id);

    const tpl = await page.request.post("/api/v1/detail-templates", {
      data: { name: "House style", body: "## Problem\n\n## Out of scope\n" },
    });
    const tplId = (await tpl.json()).template.id as string;
    const assign = await page.request.put("/api/v1/levels/templates", {
      data: { templates: { work: tplId } },
    });
    expect(assign.ok(), await assign.text()).toBeTruthy();

    // A card with a real description, attached. The level default must not
    // overwrite it: a skeleton replacing someone's writing would be far worse
    // than no template at all.
    const created = await page.request.post("/api/v1/features", {
      data: {
        title: "Chargeback SLA",
        level: "work",
        details: "We answer chargebacks within five working days.",
      },
    });
    const specId = (await created.json()).feature.specId as string;

    await page.goto(`/${ws.slug}/all/backlog/work/${specId}`);
    await page.getByRole("button", { name: /Attach a spec/i }).click();
    const form = page.locator("form").filter({ hasText: /Documents this item/ });
    // No template picker on attach: the card's description is the body, so a
    // control that could not change the outcome is not offered.
    await expect(form.getByLabel(/Start from/i)).toHaveCount(0);

    const [resp] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/v1/specs") && r.request().method() === "POST",
      ),
      form.getByRole("button", { name: /^Attach spec$/i }).click(),
    ]);
    expect(resp.ok(), await resp.text()).toBeTruthy();

    const raw = getRepoFiles(OWNER, REPO)["specs/chargeback-sla/spec.md"];
    expect(raw).toContain("We answer chargebacks within five working days.");
    expect(raw).not.toContain("## Out of scope");
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
    const form = page.locator("form").filter({ hasText: /Documents this item/ });
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

  /**
   * A grouping card has no "Attach a spec", and for a long time said nothing
   * about why. The neighbouring control creates a *different* card beneath it,
   * so an author who wanted to document the card in front of them got one they
   * did not ask for and no warning either way.
   *
   * Both halves of the fix are asserted here because either alone is still a
   * trap: copy that explains the absence, and copy that actually reaches the
   * control it names. The control lives inside a collapsed section, so a
   * sentence ending "below" would point at nothing a reader can see.
   */
  test("a grouping card explains why it cannot take a spec, and gets you to the control that can", async ({
    page,
  }) => {
    const ws = await getWorkspace();
    const created = await page.request.post("/api/v1/features", {
      data: { title: "Billing", level: "feature" },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    const specId = (await created.json()).feature.specId as string;

    await page.goto(`/${ws.slug}/all/backlog/feature/${specId}`);

    // No attach control at this altitude, and the reason is on the page.
    await expect(
      page.getByRole("button", { name: /Attach a spec/i }),
    ).toHaveCount(0);
    await expect(page.getByText(/Specs live on Work Items/i)).toBeVisible();

    // The control it points at is behind a collapsed section to start with.
    const create = page.getByRole("button", { name: /New Work Item/i });
    await expect(create).toHaveCount(0);

    await page.getByRole("button", { name: /break it down into one/i }).click();
    await expect(create).toBeVisible();
  });
});
