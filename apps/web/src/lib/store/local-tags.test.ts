import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalFileStore } from "./local";

/**
 * Local file mode's half of the tag writes that reach items: merge, delete, and
 * the usage counts the delete confirmation is sized from.
 *
 * The db store does this in SQL and is covered by `tags-bulk.int.test.ts`; this
 * is the same contract carried out by rewriting a JSON file, and the two must
 * not drift. Both cases worth guarding are ones a naive implementation gets
 * wrong: an item carrying both spellings has to come out of a merge with the
 * survivor once, and an item losing its only tag has to come out of a delete
 * with an empty list rather than a missing one.
 */

const ITEMS = "local-items.json";

describe("LocalFileStore tag writes", () => {
  let root: string;
  let store: LocalFileStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "specboard-tags-"));
    store = new LocalFileStore(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  /** Seed the items file with one row per tag list. */
  async function seedItems(lists: string[][]): Promise<void> {
    await fs.mkdir(path.join(root, ".specboards"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".specboards", ITEMS),
      JSON.stringify(
        lists.map((tags, i) => ({ id: `item-${i}`, tags })),
        null,
        2,
      ),
      "utf8",
    );
  }

  async function tagsOnItems(): Promise<string[][]> {
    const raw = await fs.readFile(
      path.join(root, ".specboards", ITEMS),
      "utf8",
    );
    return (JSON.parse(raw) as { tags: string[] }[]).map((i) => i.tags);
  }

  /** Merge the first seeded tag into the second, by name. */
  async function merge(from: string, to: string) {
    const tags = await store.listTags();
    const source = tags.find((t) => t.name === from)!;
    const target = tags.find((t) => t.name === to)!;
    return store.mergeTags(source.id, target.id);
  }

  it("re-tags items and drops the merged definition", async () => {
    await store.ensureTags(["SF", "Salesforce"]);
    await seedItems([["SF", "tier-1"], ["tier-1"]]);

    await merge("SF", "Salesforce");

    expect(await tagsOnItems()).toEqual([["Salesforce", "tier-1"], ["tier-1"]]);
    expect((await store.listTags()).map((t) => t.name)).toEqual(["Salesforce"]);
  });

  it("does not leave the survivor on an item twice", async () => {
    await store.ensureTags(["SF", "Salesforce"]);
    await seedItems([["SF", "tier-1", "Salesforce"]]);

    await merge("SF", "Salesforce");

    expect(await tagsOnItems()).toEqual([["Salesforce", "tier-1"]]);
  });

  it("keeps the order the item's author left", async () => {
    await store.ensureTags(["SF", "Salesforce"]);
    await seedItems([["zeta", "SF", "alpha"]]);

    await merge("SF", "Salesforce");

    expect(await tagsOnItems()).toEqual([["zeta", "Salesforce", "alpha"]]);
  });

  it("picks up a legacy casing that predates the registry", async () => {
    await store.ensureTags(["SF", "Salesforce"]);
    await seedItems([["sf"]]);

    await merge("SF", "Salesforce");

    expect(await tagsOnItems()).toEqual([["Salesforce"]]);
  });

  it("refuses to merge a tag into itself", async () => {
    await store.ensureTags(["SF"]);
    const [sf] = await store.listTags();
    await expect(store.mergeTags(sf!.id, sf!.id)).rejects.toThrow(/itself/);
  });

  it("refuses an unknown tag rather than reporting a silent success", async () => {
    await store.ensureTags(["SF"]);
    const [sf] = await store.listTags();
    await expect(store.mergeTags(sf!.id, "nope")).rejects.toThrow(/Unknown tag/);
    await expect(store.mergeTags("nope", sf!.id)).rejects.toThrow(/Unknown tag/);
  });

  it("takes a deleted tag off the items that carry it", async () => {
    // Deleting used to leave item values alone. It cascades now, and bulk
    // delete is a loop over this, so it inherits the same behaviour.
    await store.ensureTags(["retired"]);
    await seedItems([["retired", "tier-1"], ["tier-1"]]);
    const [retired] = await store.listTags();

    const changed = await store.deleteTag(retired!.id);

    expect(changed).toBe(1);
    expect(await store.listTags()).toEqual([]);
    expect(await tagsOnItems()).toEqual([["tier-1"], ["tier-1"]]);
  });

  it("strips a legacy casing, and keeps what it leaves in order", async () => {
    await store.ensureTags(["Mid"]);
    await seedItems([["zeta", "MID", "alpha"]]);
    const [mid] = await store.listTags();

    await store.deleteTag(mid!.id);

    expect(await tagsOnItems()).toEqual([["zeta", "alpha"]]);
  });

  it("leaves an item with an empty tag list, not a missing one", async () => {
    await store.ensureTags(["only"]);
    await seedItems([["only"]]);
    const [only] = await store.listTags();

    await store.deleteTag(only!.id);

    expect(await tagsOnItems()).toEqual([[]]);
  });

  it("refuses an unknown tag", async () => {
    await expect(store.deleteTag("nope")).rejects.toThrow(/Unknown tag/);
  });

  it("counts items per tag, case-insensitively and once per item", async () => {
    await seedItems([["area:web", "tier-1"], ["AREA:WEB"], ["dup", "DUP"]]);

    const counts = await store.tagUsageCounts();

    expect(counts["area:web"]).toBe(2);
    expect(counts["tier-1"]).toBe(1);
    expect(counts["dup"]).toBe(1);
    expect(counts["unused"]).toBeUndefined();
  });
});
