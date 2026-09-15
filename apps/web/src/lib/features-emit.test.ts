import { beforeEach, describe, expect, it, vi } from "vitest";

import { defaultWorkflow } from "@specboards/core";

/**
 * Which events a patch records.
 *
 * One write can be several things happening at once: dragging a card to the
 * next column while handing it to somebody is a status change *and* an
 * assignment, and the notification fan-out subscribes to those separately. A
 * patch that collapsed them into one event would mean the person being given
 * the item hears nothing, which is the exact gap this release exists to close.
 *
 * The other half is what does *not* emit. Clearing an assignee is a real change
 * and is recorded in the ledger, but there is nobody it is addressed to, and a
 * "you were unassigned" notice for a field going empty is noise.
 */

let current: {
  specId: string;
  status: string;
  productId: string;
  title: string;
  level: string;
  isDbNative: boolean;
  tags: string[];
  assigneeId: string | null;
};

/** Every outbox event the service passed to the store, in order. */
let emitted: { type: string; data: Record<string, unknown> }[];

const store = {
  getFeature: vi.fn(async () => ({ ...current })),
  updateFeature: vi.fn(
    async (
      _specId: string,
      patch: { status?: string; assigneeId?: string | null },
      _scope: unknown,
      emit?: { type: string; data: Record<string, unknown> }[],
    ) => {
      emitted.push(...(emit ?? []));
      current = { ...current, ...patch };
    },
  ),
  listProperties: vi.fn(async () => []),
  listTags: vi.fn(async () => []),
  ensureTags: vi.fn(async () => []),
  listLevels: vi.fn(async () => []),
  listStageGates: vi.fn(async () => []),
  listGateCompletions: vi.fn(async () => [] as string[]),
};

vi.mock("@/lib/store", () => ({ getStore: async () => store }));
vi.mock("@/lib/repo-config", () => ({
  resolveWorkflowFor: async () => defaultWorkflow,
}));
vi.mock("@/lib/webhooks/events", () => ({ notifyOutbox: () => {} }));
/** Which user ids the workspace considers agents, for the dispatch tests. */
let agents: Set<string>;
vi.mock("@/lib/agents/identity", () => ({
  isActiveAgent: async (_ws: string, userId: string) => agents.has(userId),
}));

const { patchFeature } = await import("@/lib/features-service");

beforeEach(() => {
  current = {
    specId: "spec-1",
    status: "backlog",
    productId: "prod-1",
    title: "Checkout flow",
    level: "work",
    isDbNative: true,
    tags: [],
    assigneeId: null,
  };
  emitted = [];
  agents = new Set();
  store.updateFeature.mockClear();
});

/** A caller with a workspace, which the agent lookup needs to run at all. */
const SCOPE = { userId: "u-me", workspaceId: "ws-1" } as never;

describe("patchFeature outbox events", () => {
  it("records the move and the handover separately when both happen at once", async () => {
    await patchFeature("spec-1", { status: "defining", assigneeId: "u-mate" });

    // Human-facing events first, then the agent-facing ones. A stage arrival
    // is announced to both audiences, in their own shapes; see the note on
    // WEBHOOK_EVENT_TYPES for why that is two events rather than one.
    expect(emitted.map((e) => e.type)).toEqual([
      "item.status_changed",
      "item.assigned",
      "item.stage_entered",
    ]);
    expect(emitted[1]!.data).toMatchObject({
      specId: "spec-1",
      assigneeId: "u-mate",
      previousAssigneeId: null,
    });
  });

  it("carries who had it before, so a handover can name both ends", async () => {
    current.assigneeId = "u-old";
    await patchFeature("spec-1", { assigneeId: "u-new" });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.data).toMatchObject({
      assigneeId: "u-new",
      previousAssigneeId: "u-old",
    });
  });

  it("says nothing when the assignee is cleared", async () => {
    // A real change, and the ledger records it. There is simply no one to tell:
    // the person losing the item finds out by it leaving their board.
    current.assigneeId = "u-old";
    await patchFeature("spec-1", { assigneeId: null });

    expect(emitted).toEqual([]);
  });

  it("says nothing when a patch re-sends the assignee it already has", async () => {
    // Re-saving a form. Emitting here would notify somebody every time anyone
    // touched an unrelated field on their item.
    current.assigneeId = "u-mate";
    await patchFeature("spec-1", { assigneeId: "u-mate", title: "Renamed" });

    expect(emitted).toEqual([]);
  });

  // ── Dispatch ──────────────────────────────────────────────────────────────

  it("tells agents a stage was entered, and whether the owner is one", async () => {
    // So a dispatcher can ignore what is not its business without reading the
    // roster back on every event.
    agents = new Set(["a-bot"]);
    await patchFeature("spec-1", { status: "defining" }, SCOPE);

    const entered = emitted.find((e) => e.type === "item.stage_entered");
    expect(entered!.data).toMatchObject({
      specId: "spec-1",
      stage: "defining",
      assigneeId: null,
      assigneeIsAgent: false,
    });
  });

  it("says the owner is an agent when it is", async () => {
    agents = new Set(["a-bot"]);
    current.assigneeId = "a-bot";
    await patchFeature("spec-1", { status: "defining" }, SCOPE);

    expect(
      emitted.find((e) => e.type === "item.stage_entered")!.data,
    ).toMatchObject({ assigneeId: "a-bot", assigneeIsAgent: true });
  });

  it("asks for a run when work is handed to an agent", async () => {
    agents = new Set(["a-bot"]);
    await patchFeature("spec-1", { assigneeId: "a-bot" }, SCOPE);

    expect(emitted.map((e) => e.type)).toEqual([
      "item.assigned",
      "run.requested",
    ]);
    expect(emitted[1]!.data).toMatchObject({
      specId: "spec-1",
      agentId: "a-bot",
      trigger: "assignment",
    });
  });

  it("asks for no run when work is handed to a person", async () => {
    // `item.assigned` still fires: a handover to a colleague is news. What
    // must not happen is the board asking software to start on it.
    agents = new Set(["a-bot"]);
    await patchFeature("spec-1", { assigneeId: "u-mate" }, SCOPE);

    expect(emitted.map((e) => e.type)).toEqual(["item.assigned"]);
  });

  it("asks for no run when the agent already had it", async () => {
    // Re-saving a card, or changing its tags, must not re-dispatch work the
    // agent is already doing.
    agents = new Set(["a-bot"]);
    current.assigneeId = "a-bot";
    await patchFeature("spec-1", { assigneeId: "a-bot" }, SCOPE);

    expect(emitted).toHaveLength(0);
  });
});
