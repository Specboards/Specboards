import { canWriteProduct } from "@specboards/core";
import type { Database } from "@specboards/db";

import {
  assembleReleaseContext,
  type AssembledReleaseContext,
} from "@/lib/ai/release-context";
import type { ModelErrorKind, ModelMessage } from "@/lib/ai/provider";
import { statusLabel } from "@/lib/feature-helpers";
import { streamWithWorkspaceModel } from "@/lib/model-provider-service";
import { groupReleaseItemsByLevel, type ReleaseItem } from "@/lib/release-items";
import { releaseStatusLabel } from "@/lib/release-status";
import { resolveWorkflowForProducts } from "@/lib/repo-config";
import { getStore } from "@/lib/store";
import type { WorkspaceScope } from "@/lib/store/types";

/**
 * Drafting a release's customer-facing notes from the work scheduled into it.
 *
 * ── Why this writes nothing ─────────────────────────────────────────────────
 * The draft is streamed to the browser and lands in the notes editor exactly
 * where a person's own typing would. Nothing is persisted here, and there is no
 * code path from this module to a write. A generated document that saves itself
 * into a customer-facing field is the one place this product must not be clever:
 * the failure mode is not a bad paragraph, it is a bad paragraph nobody read
 * before it was published.
 *
 * That is also why there is no thread. A one-shot draft has nothing to persist,
 * so it needs no schema of its own, and this whole feature ships without a
 * migration. The conversation about a release is the next feature, and it is
 * deliberately the one that pays the migration cost.
 *
 * ── Where authorization comes from ──────────────────────────────────────────
 * The release is resolved through the store, which applies product visibility,
 * and the item list is `listFeatures(scope)` filtered to the release, so a
 * portfolio release spanning products a caller cannot open contributes nothing
 * from those products. The list drafted from is therefore the same list the
 * flyout shows that person, which is worth more than it sounds: the disclosure
 * and the screen cannot disagree.
 */

/** The release does not exist, or the caller cannot see it. Routes map to 404. */
export class ReleaseNotFoundError extends Error {}
/** Nothing to write notes from, or the caller may not draft. Routes map by kind. */
export class ReleaseNotesInputError extends Error {}
/** The caller may read this release but not change it. Routes map to 403. */
export class ReleaseNotesForbiddenError extends Error {}

/** Everything the draft endpoint can fail with, as the browser sees it. */
export type DraftErrorKind = ModelErrorKind | "not_configured" | "capped";

/** What the caller of a draft observes, in order. */
export type DraftEvent =
  /** A fragment of the draft, to append to what is in the editor. */
  | { kind: "delta"; text: string }
  /** The draft finished. `context` is what was sent, for the disclosure. */
  | {
      kind: "done";
      itemsIncluded: number;
      itemsOmitted: number;
    }
  | { kind: "error"; error: { kind: DraftErrorKind; message: string } };

/**
 * Upper bound on the generated draft.
 *
 * Release notes that run past this are not release notes, and the bound is what
 * turns "the model decided to write an essay" from a surprise on the invoice
 * into a draft that stops. It also feeds the spend check: the cap is asked about
 * prompt plus this, so a call is admitted on what it could cost rather than on
 * what it probably will.
 */
export const DRAFT_MAX_TOKENS = 2_000;

/**
 * Whether this scope may change this release.
 *
 * The same shape of check the release write path makes, asked early, and for a
 * reason beyond tidiness: drafting spends the workspace's money at their
 * provider. Offering it to somebody who could not save the result would be
 * spending on a draft with nowhere to go.
 *
 * Advisory, like `canEditItem`: it decides what to offer, and the release
 * mutation still decides what happens.
 */
export async function canEditRelease(
  scope: WorkspaceScope,
  productId: string | null,
): Promise<boolean> {
  const store = await getStore();
  const access = await store.getProductAccess(scope);
  // A portfolio release belongs to no product, so there is no per-product grant
  // that could authorize it; org admin is the only answer. Same rule as an item
  // with no product.
  return productId === null
    ? access.isOrgAdmin
    : access.isOrgAdmin || canWriteProduct(access, productId);
}

/**
 * Everything the prompt is built from, resolved and assembled.
 *
 * Separate from the streaming below so the disclosure can be read without
 * spending anything: "here is what asking would send" is a question the UI needs
 * to answer before, not after.
 */
export async function buildReleaseContext(
  scope: WorkspaceScope,
  releaseId: string,
): Promise<AssembledReleaseContext> {
  const store = await getStore();

  // Resolved through the store's own listing, so an id the caller cannot see is
  // indistinguishable from one that does not exist.
  const releases = await store.listReleases(scope);
  const release = releases.find((r) => r.id === releaseId);
  if (!release) throw new ReleaseNotFoundError("Release not found.");

  if (!(await canEditRelease(scope, release.productId))) {
    throw new ReleaseNotesForbiddenError(
      "You do not have permission to write this release's notes.",
    );
  }

  const [features, levels] = await Promise.all([
    store.listFeatures(scope),
    store.listLevels(scope),
  ]);

  const items: ReleaseItem[] = features
    .filter((f) => f.releaseId === releaseId)
    .map((f) => ({
      specId: f.specId,
      title: f.title,
      level: f.level,
      status: f.status,
      productId: f.productId,
    }));

  if (items.length === 0) {
    // Refused here rather than sent, because the honest answer costs nothing.
    // Asking a model to observe that a release is empty spends the customer's
    // money to be told something we already know, and invites it to fill the
    // silence.
    throw new ReleaseNotesInputError(
      "Nothing is scheduled into this release yet, so there is nothing to write notes from.",
    );
  }

  // A portfolio release can hold work from several products, each of which may
  // define its own stages. Resolving the union means a status reads as its own
  // product's word for it rather than as whatever the workspace default calls
  // that key.
  const productIds = [
    ...new Set(items.map((i) => i.productId).filter((id): id is string => Boolean(id))),
  ];
  const workflow = await resolveWorkflowForProducts(scope, productIds);

  return assembleReleaseContext({
    name: release.name,
    statusLabel: releaseStatusLabel(release.status),
    targetDate: release.targetDate,
    shippedDate: release.shippedDate,
    groups: groupReleaseItemsByLevel(items, levels).map((group) => ({
      levelLabel: group.levelLabel,
      items: group.items.map((item) => ({
        title: item.title,
        statusLabel: statusLabel(item.status, workflow),
      })),
    })),
  });
}

/**
 * Begin a draft: authorize, assemble, and return the stream of what happens.
 *
 * Eager setup, lazy tokens, for the reason `startAssistantTurn` documents: a
 * generator runs nothing until it is first pulled, which would put "no such
 * release" inside a response body whose 200 was already committed. Everything
 * knowable before the endpoint is called happens here and throws here, so the
 * route can still answer 404, 403 or 422 properly.
 */
export async function startReleaseNotesDraft(
  db: Database,
  scope: WorkspaceScope,
  releaseId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<AsyncGenerator<DraftEvent>> {
  const context = await buildReleaseContext(scope, releaseId);

  const messages: ModelMessage[] = [
    { role: "system", content: context.systemPrompt },
    // A user turn as well as the system turn, rather than the system turn
    // alone. Several small local runtimes answer a system-only conversation
    // with a greeting, or with nothing at all: the shape they are trained on is
    // "somebody asked for something", and this is the cheapest way to give them
    // one.
    { role: "user", content: "Draft the release notes for this release." },
  ];

  return run();

  async function* run(): AsyncGenerator<DraftEvent> {
    let finished = false;

    for await (const event of streamWithWorkspaceModel(
      db,
      scope.workspaceId,
      {
        messages,
        maxTokens: DRAFT_MAX_TOKENS,
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
      // Attribution, not telemetry: the record of whose behalf the workspace's
      // money was spent on. Its own feature label rather than `assistant_turn`,
      // so a workspace reading its usage can tell drafting notes apart from
      // asking questions about items, and can see which one is costing them.
      { userId: scope.userId, feature: "release_notes_draft" },
    )) {
      if (event.kind === "capped") {
        yield { kind: "error", error: { kind: "capped", message: event.message } };
        return;
      }
      if (event.kind === "not_configured") {
        yield {
          kind: "error",
          error: {
            kind: "not_configured",
            message:
              "No model is connected for this workspace. An admin can connect one in Settings under Integrations.",
          },
        };
        return;
      }
      if (event.kind === "error") {
        yield { kind: "error", error: event.error };
        return;
      }
      if (event.kind === "delta") {
        yield { kind: "delta", text: event.text };
        continue;
      }
      finished = true;
    }

    // The stream ended with no terminal event, which is how the adapter reports
    // a cancel. The text already delivered stays in the editor: the person
    // stopped it themselves and can see exactly what they got, which is not the
    // same situation as a thread, where a half-sentence would be replayed into
    // every later question.
    if (!finished) return;

    yield {
      kind: "done",
      itemsIncluded: context.itemsIncluded,
      itemsOmitted: context.itemsOmitted,
    };
  }
}
