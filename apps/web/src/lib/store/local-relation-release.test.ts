import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalFileStore } from "./local";

/**
 * Local file mode's half of the release-on-a-relation contract.
 *
 * The question a relations list has to answer is "does this blocker ship before
 * me?", and it can only answer it if the edge carries the other end's release.
 * The field is on `FeatureRelation`, which both stores build, so both stores
 * have to fill it: a field one populates and the other leaves null is a bug
 * that appears in exactly one deployment shape and is invisible in the other.
 *
 * The db half is exercised against a real Postgres in the integration suite.
 * This one needs nothing, which is why it is worth having: local file mode had
 * no relation coverage at all, so its half of the shape was never checked.
 */

describe("LocalFileStore relations carry the other end's release", () => {
  let root: string;
  let store: LocalFileStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "specboard-rel-release-"));
    store = new LocalFileStore(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  /** Two items and an edge between them, with `blocker` optionally scheduled. */
  async function twoLinkedItems(releaseId: string | null) {
    const level = (await store.listLevels())[0]!.key;
    const subject = await store.createFeature({ title: "Subject", level });
    const blocker = await store.createFeature({
      title: "Blocker",
      level,
      releaseId,
    });
    await store.addRelation(subject.specId, {
      toSpecId: blocker.specId,
      direction: "blocked_by",
    });
    return { subject, blocker };
  }

  it("names the release the other end is scheduled into", async () => {
    const rel = await store.createRelease({ name: "v9.9.9" });
    const { subject, blocker } = await twoLinkedItems(rel.id);

    const detail = (await store.getFeature(subject.specId))!;
    const edge = detail.relations.find((r) => r.otherSpecId === blocker.specId)!;
    expect(edge.otherReleaseId).toBe(rel.id);
    expect(edge.otherReleaseName).toBe("v9.9.9");
  });

  it("leaves both halves null for an unscheduled relation", async () => {
    // The common case. The renderer draws nothing rather than "None", so a
    // populated id here would put a chip on most rows in the app.
    const { subject, blocker } = await twoLinkedItems(null);

    const detail = (await store.getFeature(subject.specId))!;
    const edge = detail.relations.find((r) => r.otherSpecId === blocker.specId)!;
    expect(edge.otherReleaseId).toBeNull();
    expect(edge.otherReleaseName).toBeNull();
  });

  it("drops the id too when the release it points at is gone", async () => {
    // Both halves are null together, so a caller never holds an id it cannot
    // render. Deleting a release unschedules its items, so reaching this needs
    // the release removed from the file underneath the item, which is what a
    // half-restored workspace or a hand-edited file looks like.
    const rel = await store.createRelease({ name: "v-doomed" });
    const { subject, blocker } = await twoLinkedItems(rel.id);
    await fs.writeFile(
      path.join(root, ".specboards", "local-releases.json"),
      "[]",
      "utf8",
    );

    const detail = (await store.getFeature(subject.specId))!;
    const edge = detail.relations.find((r) => r.otherSpecId === blocker.specId)!;
    expect(edge.otherReleaseName).toBeNull();
    expect(edge.otherReleaseId).toBeNull();
  });

  it("reports the release from whichever end is being read", async () => {
    // The edge is stored once and rendered from both sides, so the "other end"
    // is different depending on who is asking. Getting this backwards would
    // show an item its own release on every relation, which reads as correct
    // and is the reason this case is pinned.
    const rel = await store.createRelease({ name: "v-blocker" });
    const { subject, blocker } = await twoLinkedItems(rel.id);

    const fromBlocker = (await store.getFeature(blocker.specId))!;
    const edge = fromBlocker.relations.find(
      (r) => r.otherSpecId === subject.specId,
    )!;
    expect(edge.direction).toBe("blocks");
    // Subject is unscheduled, so reading from the blocker shows nothing.
    expect(edge.otherReleaseName).toBeNull();
  });
});
