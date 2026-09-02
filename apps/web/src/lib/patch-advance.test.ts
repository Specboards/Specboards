import { beforeEach, describe, expect, it, vi } from "vitest";

import { defaultWorkflow, workflowFromStages } from "@specboards/core";

/**
 * The advance walk in patchFeature: the fix for a customer having to make four
 * update_item calls to move a card from backlog to in_review on a strict
 * workflow. The path arithmetic is covered in @specboards/core; this covers what
 * the service does with it - one hop at a time, gates enforced per hop, an event
 * per hop, and an error that says how far it got.
 */

/** A feature row the fake store hands back, mutated as hops are applied. */
let current: {
  specId: string;
  status: string;
  productId: string;
  title: string;
  level: string;
  isDbNative: boolean;
  tags: string[];
};

/** Every patch the service pushed into the store, in order. */
let applied: { status?: string; tags?: string[] }[];
/** Outbox events emitted alongside those writes. */
let emitted: { from: string; to: string }[];
/** Statuses whose gate check should fail, simulating an incomplete checklist. */
let blockedStages: Set<string>;
let workflow = defaultWorkflow;

const store = {
  getFeature: vi.fn(async () => ({ ...current })),
  updateFeature: vi.fn(
    async (
      _specId: string,
      patch: { status?: string; tags?: string[] },
      _scope: unknown,
      emit?: { data: { from: string; to: string } },
    ) => {
      applied.push({ ...patch });
      if (emit) emitted.push({ from: emit.data.from, to: emit.data.to });
      if (patch.status) current = { ...current, status: patch.status };
      if (patch.tags) current = { ...current, tags: patch.tags };
    },
  ),
  listProperties: vi.fn(async () => []),
  listLevels: vi.fn(async () => []),
  // One gate per blocked stage, never completed, so a forward move over it fails.
  listStageGates: vi.fn(async () =>
    [...blockedStages].map((stageKey) => ({
      id: `gate-${stageKey}`,
      stageKey,
      label: `${stageKey} checklist`,
      position: 0,
    })),
  ),
  listGateCompletions: vi.fn(async () => [] as string[]),
};

vi.mock("@/lib/store", () => ({ getStore: async () => store }));
vi.mock("@/lib/repo-config", () => ({
  resolveWorkflowFor: async () => workflow,
}));
vi.mock("@/lib/webhooks/events", () => ({ notifyOutbox: () => {} }));

const { InvalidPatchError } = await import("./service-errors");
const { patchFeature } = await import("./features-service");

beforeEach(() => {
  current = {
    specId: "spec-1",
    status: "backlog",
    productId: "prod-1",
    title: "A card",
    level: "feature",
    isDbNative: true,
    tags: [],
  };
  applied = [];
  emitted = [];
  blockedStages = new Set();
  workflow = defaultWorkflow;
  vi.clearAllMocks();
});

describe("patchFeature without advance", () => {
  it("still rejects a multi-stage jump, and says how to recover", async () => {
    await expect(
      patchFeature("spec-1", { status: "in_review" }),
    ).rejects.toThrow(/Illegal transition: backlog -> in_review/);
    expect(applied).toEqual([]);
  });

  it("applies a legal single step", async () => {
    await patchFeature("spec-1", { status: "defining" });
    expect(applied).toEqual([{ status: "defining" }]);
    expect(emitted).toEqual([{ from: "backlog", to: "defining" }]);
  });
});

describe("patchFeature with advance", () => {
  it("walks every stage between the current status and the target", async () => {
    await patchFeature("spec-1", { status: "in_review" }, undefined, {
      advance: true,
    });
    expect(applied.map((p) => p.status)).toEqual([
      "defining",
      "ready",
      "in_progress",
      "in_review",
    ]);
  });

  it("emits one status_changed per hop, so the trail shows the real path", async () => {
    await patchFeature("spec-1", { status: "in_review" }, undefined, {
      advance: true,
    });
    expect(emitted).toEqual([
      { from: "backlog", to: "defining" },
      { from: "defining", to: "ready" },
      { from: "ready", to: "in_progress" },
      { from: "in_progress", to: "in_review" },
    ]);
  });

  it("carries the rest of the patch on the final hop only", async () => {
    await patchFeature("spec-1", { status: "ready", tags: ["ux"] }, undefined, {
      advance: true,
    });
    expect(applied).toEqual([
      { status: "defining" },
      { status: "ready", tags: ["ux"] },
    ]);
  });

  it("is an ordinary patch when the move is already a single step", async () => {
    await patchFeature("spec-1", { status: "defining" }, undefined, {
      advance: true,
    });
    expect(applied).toEqual([{ status: "defining" }]);
  });

  it("is an ordinary patch on a flexible workflow, which needs no walk", async () => {
    workflow = workflowFromStages(
      [
        { key: "backlog", label: "Backlog" },
        { key: "defining", label: "Defining" },
        { key: "ready", label: "Ready" },
        { key: "in_progress", label: "In progress" },
        { key: "in_review", label: "In review" },
      ],
      "flexible",
    )!;
    await patchFeature("spec-1", { status: "in_review" }, undefined, {
      advance: true,
    });
    expect(applied).toEqual([{ status: "in_review" }]);
  });

  it("stops at a gated stage and reports how far it got", async () => {
    // "ready" has an unfinished checklist, so the walk cannot pass over it.
    blockedStages = new Set(["ready"]);
    await expect(
      patchFeature("spec-1", { status: "in_review" }, undefined, {
        advance: true,
      }),
    ).rejects.toThrow(
      /Advanced backlog -> ready on the way to in_review, then stopped:.*checklist/s,
    );
    // The hops before the gate stand: the walk is not atomic, by design.
    expect(applied.map((p) => p.status)).toEqual(["defining", "ready"]);
  });

  it("surfaces a first-hop failure as itself, with no misleading progress claim", async () => {
    blockedStages = new Set(["backlog"]);
    await expect(
      patchFeature("spec-1", { status: "in_review" }, undefined, {
        advance: true,
      }),
    ).rejects.toThrow(/^This item can't advance/);
    expect(applied).toEqual([]);
  });

  it("rejects a status outside the workflow rather than walking anywhere", async () => {
    await expect(
      patchFeature("spec-1", { status: "nonsense" }, undefined, {
        advance: true,
      }),
    ).rejects.toThrow(/is not a status in this workspace/);
    expect(applied).toEqual([]);
  });

  it("does nothing when the item is already at the target", async () => {
    current = { ...current, status: "in_review" };
    await patchFeature("spec-1", { status: "in_review" }, undefined, {
      advance: true,
    });
    expect(emitted).toEqual([]);
  });

  it("is inert without a status in the patch", async () => {
    await patchFeature("spec-1", { tags: ["ux"] }, undefined, { advance: true });
    expect(applied).toEqual([{ tags: ["ux"] }]);
  });

  it("raises InvalidPatchError, so routes keep mapping it to 422", async () => {
    blockedStages = new Set(["ready"]);
    await expect(
      patchFeature("spec-1", { status: "done" }, undefined, { advance: true }),
    ).rejects.toBeInstanceOf(InvalidPatchError);
  });
});
