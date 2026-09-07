import { planConversion, type ConversionPlan } from "@/lib/convert-item";
import { statusLabel } from "@/lib/feature-helpers";
import { resolveWorkflowFor } from "@/lib/repo-config";
import { FeatureNotFoundError, InvalidPatchError } from "@/lib/service-errors";
import {
  type FeatureDetail,
  getStore,
  type OutboxEmit,
  type WorkspaceScope,
} from "@/lib/store";
import { notifyOutbox } from "@/lib/webhooks/events";

/**
 * Convert an item to another hierarchy level, in place.
 *
 * `previewConversion` answers "what would this do"; `convertItem` does it. Both
 * go through the same `planConversion`, so what the user confirmed is exactly
 * what is enforced. Two code paths that agreed today would disagree the first
 * time either changed, and the one that matters here is the refusal.
 *
 * Available to anybody who can edit the item, not admins only. The refusals are
 * the safety, and they are the same refusals whoever is signed in; making this
 * admin-only would mean the person who worked out that a Feature is really an
 * Epic has to go and find somebody else to press the button.
 */
export async function previewConversion(
  specId: string,
  to: string,
  scope?: WorkspaceScope,
): Promise<ConversionPlan> {
  return (await buildPlan(specId, to, scope)).plan;
}

export async function convertItem(
  specId: string,
  to: string,
  scope?: WorkspaceScope,
): Promise<FeatureDetail> {
  const { plan, feature } = await buildPlan(specId, to, scope);
  if (plan.blockers.length > 0) {
    // The message carries every blocker, not the first: a user who fixes one
    // and is then told about the next has been made to do the work twice.
    throw new InvalidPatchError(plan.blockers.map((b) => b.message).join(" "));
  }

  const store = await getStore();
  const emit: OutboxEmit = {
    type: "item.converted",
    productId: feature.productId,
    data: {
      specId: feature.specId,
      title: feature.title,
      from: plan.from,
      to: plan.to,
      detachedParent: plan.detachesParent,
    },
  };
  await store.convertFeatureLevel(
    specId,
    { level: to, detachParent: plan.detachesParent },
    scope,
    emit,
  );
  // A consumer's copy of the item would otherwise silently disagree about its
  // level, which is worse than not knowing: it looks like current data.
  notifyOutbox();

  const updated = await store.getFeature(specId, scope);
  if (!updated) throw new FeatureNotFoundError(specId);
  return updated;
}

/** Everything `planConversion` needs, read once for both entry points. */
async function buildPlan(
  specId: string,
  to: string,
  scope?: WorkspaceScope,
): Promise<{ plan: ConversionPlan; feature: FeatureDetail }> {
  const store = await getStore();
  const feature = await store.getFeature(specId, scope);
  if (!feature) throw new FeatureNotFoundError(specId);

  const [levels, properties, gates, completedGateIds, workflow, parent] =
    await Promise.all([
      store.listLevels(scope),
      // Resolved for the item's own product, matching how gates and the
      // workflow are resolved: a product with its own property set would
      // otherwise be planned against the workspace default.
      store.listProperties(scope, "item", feature.productId),
      store.listStageGates(scope, feature.productId),
      store.listGateCompletions(specId, scope),
      resolveWorkflowFor(scope ?? null, feature.productId),
      feature.parentSpecId
        ? store.getFeature(feature.parentSpecId, scope)
        : Promise.resolve(null),
    ]);

  const plan = planConversion({
    item: {
      specId: feature.specId,
      title: feature.title,
      level: feature.level,
      status: feature.status,
      // A spec-backed item is one with a file behind it; `path` is where.
      specPath: feature.isDbNative ? null : feature.path || null,
      parentSpecId: feature.parentSpecId,
    },
    to,
    record: feature,
    parent: parent
      ? { specId: parent.specId, title: parent.title, level: parent.level }
      : null,
    children: feature.children.map((c) => ({
      specId: c.specId,
      title: c.title,
      level: c.level,
    })),
    levels,
    properties,
    gates,
    completedGateIds,
    statuses: workflow.statuses,
    statusLabels: Object.fromEntries(
      workflow.statuses.map((s) => [s, statusLabel(s, workflow)]),
    ),
  });
  return { plan, feature };
}
