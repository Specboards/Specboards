import { describe, expect, it, vi } from "vitest";

import { optionalLimit, type McpContext } from "./types";

/**
 * The filters and caps on the list tools, added after driving these flows on a
 * real workspace as an outside agent would.
 *
 * Two gaps this covers. `list_items` reported every item's `releaseId` and
 * `cycleId` but could not filter by either, so "what is in this release" meant
 * pulling the whole workspace and filtering client-side. And neither list tool
 * was bounded: on a 185-item, 33-release board the unfiltered calls returned
 * ~100KB and ~70KB, enough to exhaust an agent's context before it had learned
 * anything about the board.
 */

function feature(
  specId: string,
  over: { releaseId: string | null; cycleId: string | null },
) {
  return {
    specId,
    title: `Item ${specId}`,
    level: "work",
    isDbNative: true,
    status: "done",
    tags: [],
    productId: "p1",
    assigneeId: null,
    parentSpecId: null,
    childCount: 0,
    childDoneCount: 0,
    blocksCount: 0,
    blockedByCount: 0,
    path: "",
    ...over,
  };
}

const FEATURES = [
  feature("a", { releaseId: "r1", cycleId: "c1" }),
  feature("b", { releaseId: "r2", cycleId: "c1" }),
  feature("c", { releaseId: null, cycleId: null }),
  feature("d", { releaseId: "r1", cycleId: null }),
];

const RELEASES = [
  {
    id: "r1",
    name: "v1",
    productId: "p1",
    status: "shipped",
    startDate: null,
    targetDate: null,
    shippedDate: null,
    notes: "a".repeat(5000),
    releaseNotesMode: "none",
    releaseNotesBody: "b".repeat(5000),
    releaseNotesUrl: null,
    customFields: {},
    itemCount: 2,
  },
  {
    id: "r2",
    name: "v2",
    productId: "p2",
    status: "planned",
    startDate: null,
    targetDate: null,
    shippedDate: null,
    notes: null,
    releaseNotesMode: "none",
    releaseNotesBody: null,
    releaseNotesUrl: null,
    customFields: {},
    itemCount: 1,
  },
];

vi.mock("@/lib/store", () => ({
  getStore: async () => ({
    listFeatures: async () => FEATURES,
    listProducts: async () => [
      { id: "p1", key: "atlas", name: "Atlas", groupId: null },
      { id: "p2", key: "beacon", name: "Beacon", groupId: null },
    ],
    listProductGroups: async () => [],
    listReleases: async () => RELEASES,
  }),
}));

const { TOOLS } = await import("./tools");

const ctx: McpContext = {
  scope: { userId: "u", workspaceId: "w" },
  role: "member",
  isLocal: false,
  scopes: [],
};

const run = (name: string, args: Record<string, unknown>) =>
  TOOLS.find((t) => t.name === name)!.run(args, ctx);

describe("optionalLimit", () => {
  it("treats absent as no cap", () => {
    expect(optionalLimit(undefined, 500)).toBeNull();
    expect(optionalLimit(null, 500)).toBeNull();
  });

  it("accepts a whole number in range", () => {
    expect(optionalLimit(1, 500)).toBe(1);
    expect(optionalLimit(500, 500)).toBe(500);
  });

  it("refuses a bad limit loudly rather than ignoring it", () => {
    // Silently dropping it would look to the caller like the cap did not work.
    for (const bad of [0, -1, 501, 1.5, "ten", {}]) {
      expect(() => optionalLimit(bad, 500), String(bad)).toThrow(/between 1 and 500/);
    }
  });
});

describe("list_items", () => {
  it("filters to a release", async () => {
    const rows = (await run("list_items", { release: "r1" })) as { specId: string }[];
    expect(rows.map((r) => r.specId).sort()).toEqual(["a", "d"]);
  });

  it("filters to a cycle, independently of the release", async () => {
    const rows = (await run("list_items", { cycle: "c1" })) as { specId: string }[];
    expect(rows.map((r) => r.specId).sort()).toEqual(["a", "b"]);
  });

  it("combines a release and a cycle", async () => {
    const rows = (await run("list_items", {
      release: "r1",
      cycle: "c1",
    })) as { specId: string }[];
    expect(rows.map((r) => r.specId)).toEqual(["a"]);
  });

  it("caps the rows after filtering, not before", async () => {
    const rows = (await run("list_items", { release: "r1", limit: 1 })) as unknown[];
    expect(rows).toHaveLength(1);
    // Without the cap the same filter yields two, so the limit did not simply
    // truncate the workspace before the filter ran.
    expect((await run("list_items", { release: "r1" })) as unknown[]).toHaveLength(2);
  });

  it("still returns everything when nothing is asked for", async () => {
    expect((await run("list_items", {})) as unknown[]).toHaveLength(4);
  });
});

describe("list_releases", () => {
  it("leaves out the long-form prose by default", async () => {
    const rows = (await run("list_releases", {})) as Record<string, unknown>[];
    expect(rows[0]).not.toHaveProperty("notes");
    expect(rows[0]).not.toHaveProperty("releaseNotesBody");
  });

  it("says the prose exists rather than just omitting it", async () => {
    // An agent that cannot see `notes` must not conclude there are none.
    const rows = (await run("list_releases", {})) as Record<string, unknown>[];
    expect(rows[0]!.notesOmitted).toMatch(/verbose: true/);
    // The release with no notes says nothing, so the hint means something.
    expect(rows[1]!.notesOmitted).toBeUndefined();
  });

  it("returns the prose when asked", async () => {
    const rows = (await run("list_releases", { verbose: true })) as Record<
      string,
      unknown
    >[];
    expect(rows[0]!.notes).toHaveLength(5000);
    expect(rows[0]!.releaseNotesBody).toHaveLength(5000);
  });

  it("filters by product and by status", async () => {
    const byProduct = (await run("list_releases", { productId: "p1" })) as {
      id: string;
    }[];
    expect(byProduct.map((r) => r.id)).toEqual(["r1"]);
    const byStatus = (await run("list_releases", { status: "planned" })) as {
      id: string;
    }[];
    expect(byStatus.map((r) => r.id)).toEqual(["r2"]);
  });
});
