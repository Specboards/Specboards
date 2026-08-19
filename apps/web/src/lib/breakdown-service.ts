import type { Database } from "@specboards/db";

import {
  parseBreakdown,
  type ProposedChild,
} from "@/lib/ai/breakdown";
import { estimatePromptTokens } from "@/lib/ai/estimate";
import { assembleBreakdownContext } from "@/lib/ai/item-context";
import type { ModelErrorKind } from "@/lib/ai/provider";
import {
  canEditItem,
  resolveAssistantItem,
  AssistantItemError,
} from "@/lib/assistant-service";
import { statusLabel } from "@/lib/feature-helpers";
import { completeWithWorkspaceModel } from "@/lib/model-provider-service";
import { resolveWorkflowFor } from "@/lib/repo-config";
import { getStore } from "@/lib/store";
import type { FeatureDetail, WorkspaceScope } from "@/lib/store/types";

/**
 * Asking the assistant to propose the level below an item.
 *
 * ── Why this proposes and does not create ───────────────────────────────────
 * Same rule as an edit proposal, for the same reason: nothing a model produces
 * becomes real without a person accepting it. What comes back from here is a
 * list of titles. Creating them is the caller's job, through `createWorkItem`,
 * which is the identical path the manual "Generate {child}" form already uses.
 * That is deliberate and worth defending: an accepted breakdown must be
 * indistinguishable from cards someone typed, because it *is* cards someone
 * agreed to, and a second create path would have its own defaults, its own
 * validation and its own bugs.
 *
 * ── Why this is not streamed ────────────────────────────────────────────────
 * Unlike an answer in the panel, a breakdown is only useful once it is whole:
 * the question it answers is "does this set cover the parent". Streaming it
 * would mean reparsing a partial list on every token and showing tick boxes
 * that appear, rename themselves and reorder while the reviewer reads them.
 * A short wait for a finished list is the better trade, and it is the one place
 * in the assistant where that is true.
 *
 * ── Why the result is not persisted ─────────────────────────────────────────
 * A rejected breakdown leaves nothing behind, and an accepted one leaves the
 * child items, which carry their own history and are a far better record than a
 * copy of the list that produced them. This differs from a spec proposal on
 * purpose: there, the artefact is text that would otherwise vanish, so the
 * conversation has to hold it.
 */

/**
 * Upper bound on one breakdown.
 *
 * Higher than an assistant answer because the output here is a structured list
 * of child items rather than a reply, and a wide epic legitimately produces a
 * long one. Still bounded, and the spend cap is asked about prompt plus this,
 * so the call is admitted on what it could cost. This is the runaway case the
 * cap was built for: a breakdown over a large tree is the single most expensive
 * thing the product can be asked to do, and until now the check reserved the
 * prompt and treated the generated list as free.
 */
export const BREAKDOWN_MAX_TOKENS = 4_000;

/** The item cannot be broken down: it is already at the lowest level. */
export class BreakdownLevelError extends Error {}
/** The caller may read the item but not add children to it. Routes map to 403. */
export class BreakdownForbiddenError extends Error {}

export type BreakdownOutcome =
  | {
      ok: true;
      /** The model's sentence about how it divided the work. */
      prose: string;
      children: ProposedChild[];
      /** The level these would be created at, in the workspace's own words. */
      childLevelKey: string;
      childLevelLabel: string;
    }
  | {
      ok: false;
      error: { kind: ModelErrorKind | "not_configured" | "capped"; message: string };
    };

/**
 * Roughly what asking for a breakdown will send, before anybody asks.
 *
 * ── Why breakdowns get this and ordinary questions get it differently ───────
 * A question in the panel is typed, so the person is already thinking about
 * what they are about to send, and the panel shows the running figure beside
 * the disclosure. A breakdown is one button, pressed on an item somebody may
 * never have opened, over a context that grows with the size of the item and
 * everything under it. It is the operation in the product most likely to cost
 * far more than the person pressing it expects, which is exactly the case the
 * spend feature exists for.
 *
 * Does the same work {@link proposeBreakdown} does to build its prompt, and
 * measures the result, rather than approximating the approximation. The whole
 * point is that the number describes the request that would actually be made.
 * The cost is a handful of local reads, against a call that would otherwise
 * cost the customer money at a vendor.
 */
export async function estimateBreakdown(
  db: Database,
  scope: WorkspaceScope,
  specId: string,
): Promise<{ estimatedPromptTokens: number; childLevelLabel: string } | null> {
  const { feature } = await resolveAssistantItem(db, scope, specId);
  const child = await childLevelOf(scope, feature);
  if (!child) return null;

  const { systemPrompt } = await buildContext(scope, feature, child.label);
  return {
    estimatedPromptTokens: estimatePromptTokens([
      { content: systemPrompt },
      { content: `Break this ${feature.level} down into ${child.label} items.` },
    ]),
    childLevelLabel: child.label,
  };
}

/**
 * The level immediately below this item's, or null when there is none.
 *
 * Read from the workspace's configured levels rather than assumed. A hardcoded
 * initiative/epic/feature/work ladder would propose at a level that does not
 * exist in a workspace that renamed or removed one, and the failure would
 * arrive from `createWorkItem` as a complaint about a level key the person has
 * never seen.
 */
async function childLevelOf(
  scope: WorkspaceScope,
  feature: FeatureDetail,
): Promise<{ key: string; label: string } | null> {
  const store = await getStore();
  const levels = await store.listLevels(scope, feature.productId);
  const own = levels.findIndex((l) => l.key === feature.level);
  if (own === -1) return null;
  const child = levels[own + 1];
  return child ? { key: child.key, label: child.label } : null;
}

/**
 * Propose a decomposition of `specId` into the level below it.
 *
 * Authorization is the item's own write permission, checked before anything is
 * spent: proposing children for an item you cannot add children to wastes the
 * workspace's money to produce a list with no button under it.
 */
export async function proposeBreakdown(
  db: Database,
  scope: WorkspaceScope,
  specId: string,
): Promise<BreakdownOutcome> {
  const { feature } = await resolveAssistantItem(db, scope, specId);
  if (!(await canEditItem(scope, feature))) {
    throw new BreakdownForbiddenError(
      "Your role does not permit adding items under this one.",
    );
  }

  const child = await childLevelOf(scope, feature);
  if (!child) {
    throw new BreakdownLevelError(
      "This is already the lowest level in this workspace, so there is nothing to break it down into.",
    );
  }

  const { systemPrompt } = await buildContext(scope, feature, child.label);
  const outcome = await completeWithWorkspaceModel(
    db,
    scope.workspaceId,
    {
      messages: [
        { role: "system", content: systemPrompt },
        // A user turn as well as the system one, because a chat endpoint given
        // only a system message is a shape several runtimes handle badly, and
        // the instruction is the whole request here.
        {
          role: "user",
          content: `Break this ${feature.level} down into ${child.label} items.`,
        },
      ],
      maxTokens: BREAKDOWN_MAX_TOKENS,
    },
    { userId: scope.userId, feature: "breakdown" },
  );

  if (!outcome.ok) {
    if (outcome.error.kind === "capped") {
      return { ok: false, error: { kind: "capped", message: outcome.error.message } };
    }
    return {
      ok: false,
      error:
        outcome.error.kind === "not_configured"
          ? {
              kind: "not_configured",
              message:
                "No model is connected for this workspace. An admin can connect one in Settings under Integrations.",
            }
          : outcome.error,
    };
  }

  const { prose, children } = parseBreakdown(outcome.text);
  return {
    ok: true,
    prose,
    children: dedupe(children, feature.children.map((c) => c.title)),
    childLevelKey: child.key,
    childLevelLabel: child.label,
  };
}

/**
 * Drop anything that repeats a child already under the parent, or repeats
 * another proposal.
 *
 * The prompt asks for the gap and mostly gets it. This is the backstop, because
 * the cost of it being wrong is asymmetric: a duplicate that slips through
 * becomes a second card with the same name that somebody has to notice and
 * delete, while a near-duplicate wrongly dropped is one line a person can ask
 * for again. Compared loosely, on case and punctuation, since "Connect a
 * provider" and "Connect a provider." are the same card.
 */
function dedupe(children: ProposedChild[], existing: string[]): ProposedChild[] {
  const normalise = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const seen = new Set(existing.map(normalise));
  const out: ProposedChild[] = [];
  for (const c of children) {
    const key = normalise(c.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/** The same item facts the panel sends, aimed at a breakdown. */
async function buildContext(
  scope: WorkspaceScope,
  feature: FeatureDetail,
  childLevelLabel: string,
) {
  const store = await getStore();
  const [workflow, levels, goals] = await Promise.all([
    resolveWorkflowFor(scope, feature.productId),
    store.listLevels(scope, feature.productId),
    store.listItemGoals(feature.specId, scope),
  ]);
  const ownIndex = levels.findIndex((l) => l.key === feature.level);

  return assembleBreakdownContext(
    {
      // Not used by the breakdown rules, which never offer to edit the body.
      canEdit: false,
      title: feature.title,
      levelLabel: levels[ownIndex]?.label ?? feature.level,
      statusLabel: statusLabel(feature.status, workflow),
      body: feature.content,
      parentTitle: feature.parentTitle,
      parentLevelLabel:
        ownIndex > 0 ? (levels[ownIndex - 1]?.label ?? null) : null,
      children: feature.children.map((c) => ({
        title: c.title,
        statusLabel: statusLabel(c.status, workflow),
      })),
      goals: goals.map((g) => g.title),
      tags: feature.tags,
    },
    childLevelLabel,
  );
}

export { AssistantItemError };
