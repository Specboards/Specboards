import { and, eq, features, type Database } from "@specboards/db";

import { asUser } from "@/lib/db-scope";
import { canEditItem } from "@/lib/assistant-service";
import { patchFeature } from "@/lib/features-service";
import { canEditRelease } from "@/lib/release-notes-service";
import { updateSpecContent } from "@/lib/spec-content";
import { getStore } from "@/lib/store";
import { StaleWriteError } from "@/lib/store/precondition";
import type {
  FeatureDetail,
  FeaturePatch,
  ReleaseRecord,
  WorkspaceScope,
} from "@/lib/store/types";

import {
  ProposalForbiddenError,
  ProposalInvalidError,
  ProposalNotFoundError,
  ProposalStaleError,
} from "./errors";
import {
  assertMetadataNotStale,
  assertNotStale,
  assertSentWhole,
  bodyFitsWhole,
  notesFitWhole,
} from "./guards";
import type { ProposalRow } from "./store";
import {
  parseItemMetadata,
  parseSpecContent,
  type ItemMetadataPayload,
} from "./types";

/**
 * What each kind of proposal does when somebody applies it.
 *
 * ── The rule this file exists to keep ──────────────────────────────────────
 * No handler writes anything. Every `apply` below calls exactly one of the
 * functions a human edit already goes through: `updateSpecContent`,
 * `patchFeature`, `store.updateRelease`. That is the invariant
 * `lib/assistant-proposals.ts` was built around, restated here because this is
 * where it would be easiest to break: a handler holds the target and the new
 * value, so writing directly would save a permission check and two round
 * trips, and would create a second way to change an item that no audit, write
 * mode or stage gate applies to.
 *
 * ── Why prepare and apply are separate ─────────────────────────────────────
 * The claim has to sit between them. Resolving the target, checking the caller
 * may change it and running the staleness guards all happen BEFORE the
 * proposal is claimed, so a refusal leaves it actionable rather than needing
 * to be un-claimed. Then the claim decides who won, and only then does anyone
 * write. `prepare` returns an opaque handle that `apply` is handed back, so
 * the orchestration in `service.ts` never has to know what a kind resolved.
 */

/** What applying produced. Recorded on the row after the write succeeds. */
export interface ApplyOutcome {
  /** The target's text after the change, for the caller to re-render. */
  body?: string;
  /** Where an applied edit landed in git, when it landed there directly. */
  commitSha?: string | null;
  /**
   * Set when the repo takes spec changes as pull requests. The change is then
   * proposed to *git* and not yet live, which the person who applied has to be
   * told about: the board still shows the old text.
   */
  pullRequest?: { number: number; url: string; created: boolean };
  /** Other people's changes the apply merged with on its way in. */
  mergedWith?: number;
}

/**
 * A reviewer's edit, applied on top of what was proposed.
 *
 * "Edit before accepting": the person read the diff, changed their mind about
 * a line, and what lands is their text. It is still recorded as applied,
 * because the question the record answers is "did a human decide this", and
 * they did. The target's own history holds what actually landed.
 */
export interface ApplyOverride {
  body?: string;
}

interface ProposalHandler {
  /**
   * Resolve the target, refuse anyone who may not change it, parse the
   * payload and run the guards. Throws on any refusal. Never writes.
   */
  prepare(
    db: Database,
    scope: WorkspaceScope,
    row: ProposalRow,
    override?: ApplyOverride,
  ): Promise<unknown>;
  /** Apply it. Only ever called after the claim succeeded. */
  apply(
    db: Database,
    scope: WorkspaceScope,
    row: ProposalRow,
    prepared: unknown,
  ): Promise<ApplyOutcome>;
}

/**
 * The item a proposal targets, found by row id.
 *
 * `target_id` holds `features.id`, not `specId`, matching what
 * `assistant_messages.feature_id` has always held and what the RLS policy in
 * migration 0015 joins on. The rest of the service layer speaks `specId`, so
 * this is where the two meet.
 */
async function resolveFeature(
  db: Database,
  scope: WorkspaceScope,
  featureId: string,
): Promise<{ feature: FeatureDetail; specId: string }> {
  const [row] = await asUser(db, scope.userId, (tx) =>
    tx
      .select({ specId: features.specId })
      .from(features)
      .where(
        and(
          eq(features.id, featureId),
          eq(features.workspaceId, scope.workspaceId),
        ),
      )
      .limit(1),
  );
  // Unknown item and invisible item read the same from outside, deliberately:
  // telling them apart would let a caller probe for items in products they
  // cannot see.
  if (!row) throw new ProposalNotFoundError("That item is no longer here.");

  const store = await getStore();
  const feature = await store.getFeature(row.specId, scope);
  if (!feature) throw new ProposalNotFoundError("That item is no longer here.");

  if (!(await canEditItem(scope, feature))) {
    throw new ProposalForbiddenError(
      "Your role does not permit changing this item.",
    );
  }
  return { feature, specId: row.specId };
}

/** The release a proposal targets, resolved through the caller's own listing. */
async function resolveRelease(
  scope: WorkspaceScope,
  releaseId: string,
): Promise<ReleaseRecord> {
  const store = await getStore();
  // Through `listReleases` rather than a direct read, so an id the caller
  // cannot see is indistinguishable from one that does not exist.
  const release = (await store.listReleases(scope)).find(
    (r) => r.id === releaseId,
  );
  if (!release) {
    throw new ProposalNotFoundError("That release is no longer here.");
  }
  if (!(await canEditRelease(scope, release.productId))) {
    throw new ProposalForbiddenError(
      "Your role does not permit changing this release.",
    );
  }
  return release;
}

/**
 * The patch keys each apply below sends, named once.
 *
 * The precondition is taken over exactly the fields the write will set, so
 * these have to be the same list in both places. Two literals that had to
 * agree is precisely the kind of thing that stops agreeing: naming them once
 * means a field added to the patch and not to the precondition is a change to
 * one constant, not a silent hole.
 */
const CARD_BODY_FIELDS = ["details"] as const;
const RELEASE_NOTES_FIELDS = ["releaseNotesMode", "releaseNotesBody"] as const;

/**
 * Re-raise the store's refusal as the one the review surface already knows.
 *
 * `StaleWriteError` is the write predicate firing: between `prepare` deciding
 * this proposal was safe to apply and the write going in, somebody changed
 * the same fields. It is the same event as the prepare-time staleness check,
 * caught a few milliseconds later and by the database rather than by us, so
 * the reviewer should see the same thing: a 409, and what the target says
 * now. Nothing was written, so the claim is released and the proposal is
 * actionable again.
 *
 * `current` is a thunk because the re-read only happens on the rare path.
 */
async function asStaleProposal(
  err: unknown,
  current: () => Promise<string>,
): Promise<never> {
  if (!(err instanceof StaleWriteError)) throw err;
  throw new ProposalStaleError(err.message, await current());
}

interface PreparedSpecContent {
  body: string;
  /**
   * The target's fingerprint over the fields this apply will write, taken
   * during prepare and handed to the write so it can refuse rather than
   * overwrite. Absent for a git-backed spec, which carries a blob sha down
   * its own write path and can merge rather than refuse.
   */
  expect?: string;
  feature?: FeatureDetail;
  specId?: string;
  release?: ReleaseRecord;
}

/**
 * A whole replacement body: an item's description, a spec, or release notes.
 *
 * The kind that existed before this table did. Its behaviour is unchanged,
 * including the asymmetry between a card and a spec: a card has no blob so a
 * stale draft is refused outright, while a spec carries a blob sha down to the
 * write path, which can three-way merge and only refuses a genuine overlap.
 */
const specContent: ProposalHandler = {
  async prepare(db, scope, row, override) {
    const proposed = parseSpecContent(row.payload).body;
    const body = (override?.body ?? proposed).trim();
    if (!body) {
      // Emptying a description is a legitimate thing for a person to do, but
      // not through this door and not as the outcome of clicking Apply.
      throw new ProposalInvalidError(
        "An applied proposal cannot be empty. Edit the target directly to clear it.",
      );
    }

    if (row.targetType === "release") {
      const release = await resolveRelease(scope, row.targetId);
      assertNotStale(row.baseVersion, release.releaseNotesBody ?? "", "release");
      assertSentWhole(notesFitWhole(release.releaseNotesBody), "release");
      const store = await getStore();
      const expect = await store.writePrecondition(
        { kind: "release", id: release.id },
        RELEASE_NOTES_FIELDS,
        scope,
      );
      return {
        body,
        release,
        ...(expect === null ? {} : { expect }),
      } satisfies PreparedSpecContent;
    }

    if (row.targetType !== "feature") {
      throw new ProposalInvalidError(
        "A text proposal must target an item or a release.",
      );
    }

    const { feature, specId } = await resolveFeature(db, scope, row.targetId);
    if (feature.isDbNative) {
      assertNotStale(row.baseVersion, feature.content ?? "", "item");
    }
    // Applies to a spec as well as a card: a blob sha lets a merge resolve
    // concurrent edits, and says nothing about whether the model ever saw the
    // whole document.
    assertSentWhole(bodyFitsWhole(feature.content), "item");
    // Only the card. A spec's body is not a column, so there is nothing here
    // to fingerprint, and it does not need one: `expectedBlobSha` below is
    // this same guarantee, further down the same write.
    if (!feature.isDbNative) {
      return { body, feature, specId } satisfies PreparedSpecContent;
    }
    const store = await getStore();
    const expect = await store.writePrecondition(
      { kind: "feature", specId },
      CARD_BODY_FIELDS,
      scope,
    );
    return {
      body,
      feature,
      specId,
      ...(expect === null ? {} : { expect }),
    } satisfies PreparedSpecContent;
  },

  async apply(db, scope, _row, prepared) {
    const p = prepared as PreparedSpecContent;

    if (p.release) {
      const store = await getStore();
      try {
        await store.updateRelease(
          p.release.id,
          { releaseNotesMode: "in_app", releaseNotesBody: p.body },
          scope,
          undefined,
          p.expect,
        );
      } catch (err) {
        await asStaleProposal(err, async () => {
          const now = (await store.listReleases(scope)).find(
            (r) => r.id === p.release!.id,
          );
          return now?.releaseNotesBody ?? "";
        });
      }
      return { body: p.body };
    }

    const feature = p.feature!;
    const specId = p.specId!;

    if (feature.isDbNative) {
      // A card's body is a database column, so the human path is the ordinary
      // patch and so is this one. `patchFeature` does its own product-write
      // check and writes the change ledger, which is where the item's history
      // of this edit comes from.
      try {
        await patchFeature(specId, { details: p.body }, scope, {
          expect: p.expect,
        });
      } catch (err) {
        await asStaleProposal(err, async () => {
          const store = await getStore();
          const now = await store.getFeature(specId, scope);
          return now?.content ?? "";
        });
      }
      return { body: p.body };
    }

    const result = await updateSpecContent(db, scope, specId, p.body, {
      // Not a pre-built message: the write path decides whether the acting
      // user also needs a co-author trailer, which depends on whose token
      // authors the commit, and that is not knowable here.
      assistantDrafted: true,
      // Guarded against the version the drafter was shown, not whatever is
      // there now. A spec someone edited in the meantime is merged with,
      // exactly as it would be for a human whose editor had been open that
      // long, and only a genuine overlap is refused.
      ...(_row.baseVersion ? { expectedBlobSha: _row.baseVersion } : {}),
    });
    return {
      body: result.mergedBody ?? p.body,
      commitSha: result.commitSha,
      ...(result.pullRequest
        ? {
            pullRequest: {
              number: result.pullRequest.number,
              url: result.pullRequest.url,
              created: result.pullRequest.created,
            },
          }
        : {}),
      ...(result.mergedWith ? { mergedWith: result.mergedWith } : {}),
    };
  },
};

interface PreparedItemMetadata {
  patch: ItemMetadataPayload;
  specId: string;
  /** See {@link PreparedSpecContent.expect}. */
  expect?: string;
}

/**
 * A change set over an item's metadata: stage, tags, assignee, schedule.
 *
 * New with the harness. The payload is a deliberately fixed list of fields
 * (see `types.ts`), not "whatever `FeaturePatch` accepts", so a column added
 * later does not silently become something an agent may propose.
 *
 * Stage changes are allowed. That decision came with a promise that the review
 * row says what applying one will fire, which `consequencesOf` supplies.
 */
const itemMetadata: ProposalHandler = {
  async prepare(db, scope, row) {
    if (row.targetType !== "feature") {
      throw new ProposalInvalidError(
        "A metadata proposal must target an item.",
      );
    }
    const patch = parseItemMetadata(row.payload);
    const { feature, specId } = await resolveFeature(db, scope, row.targetId);

    // Staleness over the fields being changed, rather than over a document.
    // Without this a proposal to move an item to `ready`, applied after
    // somebody already shipped it, would quietly walk the board backwards.
    assertMetadataNotStale(row.baseVersion, feature, Object.keys(patch));

    // The same question the line above asks, asked again at the write and
    // answered by the database. That one compares against what the agent was
    // shown when it drafted, which can be days ago; this one compares against
    // what was there a moment ago, and closes the window between the two.
    const store = await getStore();
    const expect = await store.writePrecondition(
      { kind: "feature", specId },
      Object.keys(patch),
      scope,
    );

    return {
      patch,
      specId,
      ...(expect === null ? {} : { expect }),
    } satisfies PreparedItemMetadata;
  },

  async apply(_db, scope, _row, prepared) {
    const { patch, specId, expect } = prepared as PreparedItemMetadata;
    // Straight down the ordinary patch path, which runs the product-write
    // check, validates the stage transition against the workflow and its
    // gates, writes the change ledger and raises the outbox event. Everything
    // that makes a stage change loud happens because this is the same call a
    // person's own edit makes.
    try {
      await patchFeature(specId, patch as FeaturePatch, scope, { expect });
    } catch (err) {
      await asStaleProposal(err, async () => {
        const store = await getStore();
        const now = await store.getFeature(specId, scope);
        const snapshot: Record<string, unknown> = {};
        for (const field of Object.keys(patch).sort()) {
          snapshot[field] =
            (now as unknown as Record<string, unknown> | null)?.[field] ?? null;
        }
        return JSON.stringify(snapshot, null, 2);
      });
    }
    return {};
  },
};

/**
 * The registry.
 *
 * `item_batch` and `doc_draft` are declared in the schema's CHECK and have no
 * handler yet: nothing can produce one until agent runs exist, and a kind with
 * a handler but no producer is code nobody has ever run. They land with the
 * cards that need them.
 */
const HANDLERS: Partial<Record<string, ProposalHandler>> = {
  spec_content: specContent,
  item_metadata: itemMetadata,
};

export function handlerFor(kind: string): ProposalHandler {
  const handler = HANDLERS[kind];
  if (!handler) {
    throw new ProposalInvalidError(
      `This version of Specboards cannot apply a "${kind}" proposal.`,
    );
  }
  return handler;
}

