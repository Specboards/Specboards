import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalFileStore } from "./local";

/**
 * Local file mode's half of the stage-replacement contract.
 *
 * The db store re-homes any item left in a stage that no longer exists, and
 * said so in a comment; this one wrote the new stages, dropped orphaned gates,
 * and left the work where it was. A removed stage therefore stranded items on a
 * board with no column to draw them in, recoverable only by editing
 * `.specboards/local-metadata.json` by hand.
 *
 * Both places a status can live are covered, because they are written by
 * different code paths and only one of them is obvious: a DB-native item keeps
 * its status in the items file, a spec-backed one in the metadata map, and a
 * spec nobody has moved has no stored status at all and resolves to the first
 * stage on read.
 */

const STAGES = [
  { key: "backlog", label: "Backlog" },
  { key: "doing", label: "Doing" },
  { key: "done", label: "Done" },
];

describe("LocalFileStore.replaceStatuses re-homes stranded work", () => {
  let root: string;
  let store: LocalFileStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "specboard-statuses-"));
    store = new LocalFileStore(root);
    await store.replaceStatuses(STAGES);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  /**
   * A spec on disk, which is how a git-backed item exists in local mode. The
   * walker only picks up files named `spec.md`, one per directory.
   */
  async function writeSpec(id: string, slug: string, title: string): Promise<void> {
    const dir = path.join(root, "specs", slug);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "spec.md"),
      `---\nid: ${id}\ntitle: ${title}\nkind: feature\n---\n\nBody.\n`,
      "utf8",
    );
  }

  it("moves a DB-native item off a stage that was removed", async () => {
    const item = await store.createFeature({
      title: "Work on a doomed stage",
      level: "feature",
    });
    await store.updateFeature(item.specId, { status: "doing" });
    expect(
      (await store.getFeature(item.specId))?.status,
    ).toBe("doing");

    // "doing" is gone from the workflow.
    await store.replaceStatuses([
      { key: "backlog", label: "Backlog" },
      { key: "done", label: "Done" },
    ]);

    expect((await store.getFeature(item.specId))?.status).toBe("backlog");
  });

  it("moves a spec-backed item, whose status lives in the metadata map", async () => {
    const specId = "11111111-1111-4111-8111-111111111111";
    await writeSpec(specId, "doomed", "A spec on a doomed stage");
    await store.updateFeature(specId, { status: "doing" });

    await store.replaceStatuses([
      { key: "backlog", label: "Backlog" },
      { key: "done", label: "Done" },
    ]);

    expect((await store.getFeature(specId))?.status).toBe("backlog");
  });

  it("leaves work alone when its stage survives the edit", async () => {
    const item = await store.createFeature({
      title: "Work that should not move",
      level: "feature",
    });
    await store.updateFeature(item.specId, { status: "done" });

    // A rename of a different stage, and a reorder. `done` is untouched.
    await store.replaceStatuses([
      { key: "backlog", label: "Inbox" },
      { key: "done", label: "Done" },
      { key: "doing", label: "In flight" },
    ]);

    expect((await store.getFeature(item.specId))?.status).toBe("done");
  });

  it("keeps archived items archived rather than sweeping them onto the board", async () => {
    const item = await store.createFeature({
      title: "Archived work",
      level: "feature",
    });
    await store.updateFeature(item.specId, { status: "archived" });

    await store.replaceStatuses([
      { key: "triage", label: "Triage" },
      { key: "shipped", label: "Shipped" },
    ]);

    expect((await store.getFeature(item.specId))?.status).toBe("archived");
  });

  it("re-homes against the built-in vocabulary when every stage is removed", async () => {
    const item = await store.createFeature({
      title: "Work with no configured workflow left",
      level: "feature",
    });
    await store.updateFeature(item.specId, { status: "doing" });

    // No stages configured means the board falls back to the built-in set, so
    // `doing` is still not a column and `backlog` is the one to land on.
    await store.replaceStatuses([]);

    expect(await store.listStatuses()).toEqual([]);
    expect((await store.getFeature(item.specId))?.status).toBe("backlog");
  });

  it("resolves an unmoved spec to the first stage, not the literal backlog", async () => {
    const specId = "22222222-2222-4222-8222-222222222222";
    await writeSpec(specId, "unmoved", "Never moved by anyone");
    // No status was ever stored for it, so there is nothing to re-home: the
    // only fix is for the read to resolve it to a stage that exists.
    expect((await store.getFeature(specId))?.status).toBe("backlog");

    await store.replaceStatuses([
      { key: "triage", label: "Triage" },
      { key: "shipped", label: "Shipped" },
    ]);

    expect((await store.getFeature(specId))?.status).toBe("triage");
  });
});
