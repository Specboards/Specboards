import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalFileStore } from "./local";
import { ReleaseError } from "./types";

/**
 * Local file mode's half of the ship-date contract.
 *
 * `shipped_date` describes the shipped state rather than the transition that
 * reached it, but both stores only ever stamped it on the transition. A release
 * created as `shipped` was therefore stored shipped with no ship date, and
 * every reader treats that date as authoritative: the roadmap draws its bar
 * from it, the detail sheet prints it, and `compareReleases` sorts on it before
 * falling back to the target date.
 *
 * The db half of this is in releases.int.test.ts, which needs a Postgres. This
 * one needs nothing, which is the point: the two implementations of one
 * interface are only honest if both are checked, and the local one had no
 * release coverage at all.
 */

describe("LocalFileStore release ship dates", () => {
  let root: string;
  let store: LocalFileStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "specboard-releases-"));
    store = new LocalFileStore(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("stamps a release created already shipped", async () => {
    const rel = await store.createRelease({
      name: "v-born-shipped",
      status: "shipped",
    });
    expect(rel.status).toBe("shipped");
    expect(rel.shippedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // Persisted, not just present in the return value: the record is written to
    // `.specboards/local-releases.json` and read back from it.
    const listed = (await store.listReleases()).find((r) => r.id === rel.id)!;
    expect(listed.shippedDate).toBe(rel.shippedDate);
  });

  it("leaves the ship date empty for the other creation states", async () => {
    for (const status of ["planned", "in_progress"] as const) {
      const rel = await store.createRelease({ name: `v-${status}`, status });
      expect(rel.shippedDate).toBeNull();
    }
    // And for a release created with no status at all, which defaults to
    // planned.
    const bare = await store.createRelease({ name: "v-bare" });
    expect(bare.status).toBe("planned");
    expect(bare.shippedDate).toBeNull();
  });

  it("records a release that shipped in the past", async () => {
    const rel = await store.createRelease({
      name: "v-historical",
      status: "shipped",
      shippedDate: "2026-07-13",
    });
    expect(rel.shippedDate).toBe("2026-07-13");

    const listed = (await store.listReleases()).find((r) => r.id === rel.id)!;
    expect(listed.shippedDate).toBe("2026-07-13");
  });

  it("corrects a ship date that was stamped on the wrong day", async () => {
    const rel = await store.createRelease({
      name: "v-wrong",
      status: "shipped",
    });
    const stampedToday = rel.shippedDate;

    const fixed = await store.updateRelease(rel.id, {
      shippedDate: "2026-07-13",
    });
    expect(fixed.shippedDate).toBe("2026-07-13");
    expect(fixed.shippedDate).not.toBe(stampedToday);
    // Correcting the date does not disturb the status.
    expect(fixed.status).toBe("shipped");
  });

  it("ships a release with a past date in one call", async () => {
    const rel = await store.createRelease({ name: "v-late-entry" });
    const shipped = await store.updateRelease(rel.id, {
      status: "shipped",
      shippedDate: "2026-07-13",
    });
    expect(shipped.status).toBe("shipped");
    // The named date wins over today's stamp.
    expect(shipped.shippedDate).toBe("2026-07-13");
  });

  it("refuses a ship date on a release that has not shipped", async () => {
    await expect(
      store.createRelease({ name: "v-not-shipped", shippedDate: "2026-07-13" }),
    ).rejects.toThrow(ReleaseError);

    const rel = await store.createRelease({ name: "v-planned" });
    await expect(
      store.updateRelease(rel.id, { shippedDate: "2026-07-13" }),
    ).rejects.toThrow(ReleaseError);
  });

  it("refuses to clear the ship date of a shipped release", async () => {
    const rel = await store.createRelease({
      name: "v-clear",
      status: "shipped",
    });
    await expect(
      store.updateRelease(rel.id, { shippedDate: null }),
    ).rejects.toThrow(ReleaseError);
  });

  it("stamps on ship, keeps the stamp across edits, and clears it on reopen", async () => {
    const rel = await store.createRelease({
      name: "v-ship",
      targetDate: "2026-08-01",
    });
    expect(rel.shippedDate).toBeNull();

    const shipped = await store.updateRelease(rel.id, { status: "shipped" });
    expect(shipped.shippedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The planned target date is a different fact and is left alone.
    expect(shipped.targetDate).toBe("2026-08-01");
    const stampedOn = shipped.shippedDate;

    const edited = await store.updateRelease(rel.id, { notes: "shipped it" });
    expect(edited.shippedDate).toBe(stampedOn);

    const reopened = await store.updateRelease(rel.id, { status: "planned" });
    expect(reopened.status).toBe("planned");
    expect(reopened.shippedDate).toBeNull();
  });
});
