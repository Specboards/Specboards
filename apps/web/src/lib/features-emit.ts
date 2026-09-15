import { isActiveAgent } from "@/lib/agents/identity";
import type { OutboxEmit } from "@/lib/store";
import type {
  FeatureDetail,
  FeaturePatch,
  WorkspaceScope,
} from "@/lib/store/types";

/**
 * Which events one patch to an item raises.
 *
 * Split out of `features-service.ts` when the agent-facing events landed and
 * pushed that module past the size cap `domain-services.test.ts` enforces.
 * The cap's own instruction is that the fix is a new module rather than a
 * larger number, and this is a real seam rather than a convenient cut: what a
 * write *is* (validate the patch, apply it) and who needs to hear about it are
 * two questions, and only the second one has to know that agents exist.
 *
 * Every event here is handed to the store and written in the SAME transaction
 * as the update, so a crash cannot leave the change persisted and the event
 * lost. The relay fans them out to webhooks and to people's inboxes
 * afterwards.
 *
 * ── Two audiences ──────────────────────────────────────────────────────────
 * `item.status_changed` and `item.assigned` are addressed to people and to
 * integrations mirroring the board. `item.stage_entered` and `run.requested`
 * are addressed to agents deciding whether to start work. They overlap in
 * time and not in payload; the note on `WEBHOOK_EVENT_TYPES` explains why
 * that is two events rather than one with more fields.
 */
export async function patchEvents(
  feature: FeatureDetail,
  patch: FeaturePatch,
  scope: WorkspaceScope | undefined,
): Promise<OutboxEmit[]> {
  // Record the events in the SAME transaction as the update (via the store's
  // outbox), so a crash can't leave the change persisted but the event lost.
  // The relay fans them out to webhooks and to people's inboxes afterward.
  //
  // A patch can be more than one event: a card moved and handed over in one
  // write is a status change and an assignment, and a consumer subscribed to
  // only one of them still needs to hear about it.
  const emit: OutboxEmit[] = [];
  if (patch.status !== undefined && patch.status !== feature.status) {
    emit.push({
      type: "item.status_changed",
      productId: feature.productId,
      data: {
        specId: feature.specId,
        title: patch.title ?? feature.title,
        level: feature.level,
        from: feature.status,
        to: patch.status,
      },
    });
  }
  // Only a change *to* somebody counts. Clearing an assignee is a real change
  // (the ledger records it) but there is nobody it is addressed to, and the
  // person losing the item is told by the item leaving their board.
  if (
    patch.assigneeId !== undefined &&
    patch.assigneeId !== null &&
    patch.assigneeId !== feature.assigneeId
  ) {
    emit.push({
      type: "item.assigned",
      productId: feature.productId,
      data: {
        specId: feature.specId,
        title: patch.title ?? feature.title,
        level: feature.level,
        assigneeId: patch.assigneeId,
        previousAssigneeId: feature.assigneeId,
      },
    });
  }

  // ── The agent-facing half ────────────────────────────────────────────────
  // Resolved once, from the effective assignee after this patch: an item can
  // be moved and handed over in the same write, and both events below need to
  // know whether the owner is a person or an agent.
  const effectiveAssignee =
    patch.assigneeId !== undefined ? patch.assigneeId : feature.assigneeId;
  const assigneeIsAgent =
    effectiveAssignee !== null &&
    scope !== undefined &&
    (await isActiveAgent(scope.workspaceId, effectiveAssignee));

  if (patch.status !== undefined && patch.status !== feature.status) {
    // Same moment as `item.status_changed`, different audience. See the note
    // on WEBHOOK_EVENT_TYPES for why these are two events and not one.
    emit.push({
      type: "item.stage_entered",
      productId: feature.productId,
      data: {
        specId: feature.specId,
        title: patch.title ?? feature.title,
        level: feature.level,
        stage: patch.status,
        assigneeId: effectiveAssignee,
        // So a dispatcher can decide whether this is its business without
        // reading the roster back. An agent subscribing to stage arrivals
        // across a busy board would otherwise make a call per event.
        assigneeIsAgent,
      },
    });
  }

  // Handing an item to an agent is the assignment trigger: the agent hears
  // "there is work" and opens a run. Deliberately separate from
  // `item.assigned`, which is addressed to people and fires for a human
  // assignee too. Nothing here starts the run; a request is a request, and
  // what the agent does with it is between the agent and `report_run`.
  if (
    assigneeIsAgent &&
    patch.assigneeId !== undefined &&
    patch.assigneeId !== null &&
    patch.assigneeId !== feature.assigneeId
  ) {
    emit.push({
      type: "run.requested",
      productId: feature.productId,
      data: {
        specId: feature.specId,
        title: patch.title ?? feature.title,
        level: feature.level,
        stage: patch.status ?? feature.status,
        agentId: patch.assigneeId,
        trigger: "assignment",
      },
    });
  }


  return emit;
}
