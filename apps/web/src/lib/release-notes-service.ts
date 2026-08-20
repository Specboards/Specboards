import { canWriteProduct } from "@specboards/core";
import type { Database } from "@specboards/db";

import { estimatePromptTokens } from "@/lib/ai/estimate";
import type { ContextField } from "@/lib/ai/item-context";
import {
  assembleReleaseContext,
  type AssembledReleaseContext,
} from "@/lib/ai/release-context";
import { parseAnswer } from "@/lib/ai/proposals";
import { skillsForSurface, type Skill } from "@/lib/ai/skills";
import type { ModelErrorKind, ModelMessage, TokenUsage } from "@/lib/ai/provider";
import {
  activeSkill,
  contentVersion,
  isModelConnected,
  persistTurns,
  readThread,
  HISTORY_TURN_LIMIT,
  MAX_TURN_CHARS,
  type AssistantMessageView,
} from "@/lib/assistant-service";
import { statusLabel } from "@/lib/feature-helpers";
import { streamWithWorkspaceModel } from "@/lib/model-provider-service";
import { findEnabledSkill, listSkills } from "@/lib/skills-service";
import { groupReleaseItemsByLevel, type ReleaseItem } from "@/lib/release-items";
import { releaseStatusLabel } from "@/lib/release-status";
import { resolveWorkflowForProducts } from "@/lib/repo-config";
import { getStore } from "@/lib/store";
import type { WorkspaceScope } from "@/lib/store/types";

/**
 * The assistant conversation about a release, and the notes it can propose.
 *
 * The sibling of `assistant-service.ts`, which does the same job for an item.
 * Everything that is genuinely the same is shared rather than copied: the thread
 * is read and written by that module (see its `ThreadSubject`), the streaming
 * protocol, the history cap, the skill mechanism, the proposal parser and the
 * spend accounting are all the ones the item panel already uses. What lives here
 * is what is actually different: which subject is resolved, which permission
 * decides it, and what a proposal is a proposal *to*.
 *
 * ── Why nothing here writes to the release ──────────────────────────────────
 * This module has no path that changes a release. An answer may *contain* a
 * proposed set of notes, which is inert text until a person accepts it, and
 * applying one lives in `assistant-proposals.ts` beside the item equivalent,
 * going through the same `updateRelease` a person typing into the editor uses.
 * There is no code path from a model's output to a write. That matters more here
 * than on an item: these notes are the customer-facing document, and the failure
 * mode is not a bad paragraph but a bad paragraph nobody read before it shipped.
 *
 * ── Where authorization comes from ──────────────────────────────────────────
 * The release is resolved through the store, which applies product visibility,
 * and the item list is `listFeatures(scope)` filtered to the release, so a
 * portfolio release spanning products a caller cannot open contributes nothing
 * from those products. The list the assistant is given is therefore the same
 * list the flyout shows that person, which is worth more than it sounds: the
 * disclosure and the screen cannot disagree.
 *
 * ── Why asking needs write access, unlike an item ───────────────────────────
 * On an item, anyone who can read it can ask about it: a question is its own
 * end, and understanding a definition is ordinary product work. A release
 * assistant exists to produce one document, and someone who cannot save that
 * document is spending the workspace's money at their provider on something with
 * nowhere to go. So this one is gated on being able to write the release.
 */

/** The release does not exist, or the caller cannot see it. Routes map to 404. */
export class ReleaseNotFoundError extends Error {}
/** Nothing to write notes from, or the caller may not draft. Routes map by kind. */
export class ReleaseNotesInputError extends Error {}
/** The caller may read this release but not change it. Routes map to 403. */
export class ReleaseNotesForbiddenError extends Error {}


/** Everything a turn can fail with, from the panel's point of view. */
export type ReleaseAssistantErrorKind = ModelErrorKind | "not_configured" | "capped";

/** What the caller of a turn observes, in order. */
export type ReleaseAssistantEvent =
  | { kind: "delta"; text: string }
  | { kind: "done"; turns: AssistantMessageView[] }
  | {
      kind: "error";
      error: { kind: ReleaseAssistantErrorKind; message: string };
    };

/**
 * Upper bound on a generated answer.
 *
 * Release notes that run past this are not release notes, and the bound is what
 * turns "the model decided to write an essay" from a surprise on the invoice
 * into an answer that stops. It also feeds the spend check, which is asked about
 * prompt plus this, so a call is admitted on what it could cost rather than on
 * what it probably will.
 */
export const ANSWER_MAX_TOKENS = 2_000;

/**
 * Whether this scope may change this release.
 *
 * Advisory in the same way `canEditItem` is: it decides what to offer and what
 * to tell the model, and `updateRelease` still decides what actually happens. A
 * disagreement costs a refused click, not a bad write.
 */
export async function canEditRelease(
  scope: WorkspaceScope,
  productId: string | null,
): Promise<boolean> {
  const store = await getStore();
  const access = await store.getProductAccess(scope);
  // A portfolio release belongs to no product, so there is no per-product grant
  // that could authorize it; org admin is the only answer. The same rule an
  // item with no product follows.
  return productId === null
    ? access.isOrgAdmin
    : access.isOrgAdmin || canWriteProduct(access, productId);
}

/** The release, checked for visibility and for write access. */
async function resolveRelease(scope: WorkspaceScope, releaseId: string) {
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
  return release;
}

/**
 * An assembled context plus the version of the notes it was assembled from.
 *
 * The version travels with the context because it has to be the version of the
 * text the model was actually shown. Recomputing it later, from a fresh read,
 * answers a different question: see the note in `run()` below.
 */
export interface AssembledReleaseTurnContext extends AssembledReleaseContext {
  /**
   * `contentVersion` of the notes body that went into `systemPrompt`. What a
   * proposal drafted from this context is checked against on accept.
   */
  notesVersion: string;
}

/**
 * Everything the prompt is built from, resolved and assembled.
 *
 * Separate from the streaming below so the disclosure can be read without
 * spending anything: "here is what asking would send" is a question the panel
 * needs to answer before, not after.
 */
export async function buildReleaseContext(
  scope: WorkspaceScope,
  releaseId: string,
  skill: Skill | null = null,
): Promise<AssembledReleaseTurnContext> {
  const release = await resolveRelease(scope, releaseId);
  const store = await getStore();

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

  // One bulk read rather than a getFeature per item: a forty-item release would
  // otherwise be forty round trips, several of them reading spec content. The
  // store applies the same product-visibility check it applies to a single
  // read, so an item the caller cannot see is simply absent from the map.
  const bodies = await store.listFeatureBodies(
    items.map((i) => i.specId),
    scope,
  );

  // A portfolio release can hold work from several products, each of which may
  // define its own stages. Resolving the union means a status reads as its own
  // product's word for it rather than as whatever the workspace default calls
  // that key.
  const productIds = [
    ...new Set(items.map((i) => i.productId).filter((id): id is string => Boolean(id))),
  ];
  const workflow = await resolveWorkflowForProducts(scope, productIds);

  const notesBody = release.releaseNotesBody ?? "";

  return {
    ...assembleReleaseContext(
      {
        name: release.name,
        statusLabel: releaseStatusLabel(release.status),
        targetDate: release.targetDate,
        shippedDate: release.shippedDate,
        groups: groupReleaseItemsByLevel(items, levels).map((group) => ({
          levelLabel: group.levelLabel,
          items: group.items.map((item) => ({
            title: item.title,
            statusLabel: statusLabel(item.status, workflow),
            description: bodies.get(item.specId) ?? "",
          })),
        })),
        notesBody,
        // Resolved above: nobody reaches here without it.
        canEdit: true,
      },
      skill,
    ),
    // The same string the prompt was built from, hashed here rather than
    // re-read later, so the accept check is against what the model saw.
    notesVersion: contentVersion(notesBody),
  };
}

/** Everything the panel needs to render, in one release resolution. */
export interface ReleaseAssistantPanelData {
  messages: AssistantMessageView[];
  context: ContextField[];
  modelConnected: boolean;
  canEdit: boolean;
  canPropose: boolean;
  /** The notes as they stand, which is what a proposal is diffed against. Sent
   * from here rather than read off the page so the diff shown and the text the
   * accept is guarded against come from one place. */
  body: string;
  /** The release's skills, in button order, disabled ones already dropped. */
  skills: Skill[];
  activeSkillKey: string | null;
  /** Roughly what the next question sends, in tokens: this release's context
   * plus the replayed thread. An estimate, and labelled as one wherever it is
   * shown; see `lib/ai/estimate.ts`. */
  estimatedPromptTokens: number;
  /** How many of the release's items reached the prompt, and how many were
   * dropped for budget. Non-zero omissions are worth saying out loud: notes
   * written from two thirds of a release are missing a third of it, and nothing
   * in the prose would ever reveal that. */
  itemsIncluded: number;
  itemsOmitted: number;
  /** How many items' descriptions were sent, and how many were shortened to
   * fit. The second is the one a reader cannot infer from the draft. */
  descriptionsIncluded: number;
  descriptionsShortened: number;
}

export async function getReleaseAssistantPanelData(
  db: Database,
  scope: WorkspaceScope,
  releaseId: string,
): Promise<ReleaseAssistantPanelData> {
  const release = await resolveRelease(scope, releaseId);
  const [messages, assembled, modelConnected, allSkills] = await Promise.all([
    readThread(db, scope, { kind: "release", releaseId }),
    buildReleaseContext(scope, releaseId),
    isModelConnected(db, scope),
    listSkills(db, scope),
  ]);

  // Only this surface's skills. An item's "Grill me" on a release would produce
  // a confident interrogation of the wrong thing.
  const offered = skillsForSurface(allSkills, "release").filter((s) => s.enabled);
  const running = activeSkill(messages);

  return {
    messages,
    context: assembled.fields,
    modelConnected,
    canEdit: true,
    canPropose: assembled.canPropose,
    body: release.releaseNotesBody ?? "",
    // Built from the same pieces the request is, and windowed the same way, so
    // the number shown is the number that will actually be sent.
    estimatedPromptTokens: estimatePromptTokens([
      { content: assembled.systemPrompt },
      ...messages.slice(-HISTORY_TURN_LIMIT).map((m) => ({ content: m.content })),
    ]),
    skills: offered,
    // Only reported as running if it is still something that can be run. A
    // skill switched off mid-thread would otherwise leave the panel holding a
    // key that every later turn is refused for.
    activeSkillKey: offered.some((s) => s.key === running) ? running : null,
    itemsIncluded: assembled.itemsIncluded,
    itemsOmitted: assembled.itemsOmitted,
    descriptionsIncluded: assembled.descriptionsIncluded,
    descriptionsShortened: assembled.descriptionsShortened,
  };
}

/**
 * A past turn as the model is shown it again.
 *
 * A rejected proposal is annotated for the reason the item thread annotates one:
 * otherwise the model reads its own rejected draft sitting in the history, has
 * no way to know a person turned it down, and folds it straight back into the
 * next proposal. Reject that has to be pressed repeatedly is Reject that does
 * not mean anything.
 */
function replayed(m: AssistantMessageView): string {
  if (m.role !== "assistant" || m.proposal?.outcome !== "rejected") {
    return m.content;
  }
  return `${m.content}\n\n[This proposed change was reviewed and not accepted. Do not include it in a later proposal unless you are asked for it again.]`;
}

/**
 * Begin a turn: authorize, validate, and return the stream of what happens.
 *
 * Eager setup, lazy tokens, for the reason `startAssistantTurn` documents at
 * length: a generator runs nothing until it is first pulled, which would put
 * "no such release" inside a response body whose 200 was already committed.
 * Everything knowable before the endpoint is called happens here and throws
 * here, so the route can still answer 404, 403 or 422 properly.
 *
 * Cancelling keeps nothing, also for the reason that module gives: a
 * half-sentence in a thread is replayed as context into every later question and
 * drags the answers with it, and an aborted stream never reaches the chunk
 * carrying the usage numbers, so a row written for it would claim a cost we
 * cannot know.
 */
export async function startReleaseTurn(
  db: Database,
  scope: WorkspaceScope,
  releaseId: string,
  text: string,
  opts: { signal?: AbortSignal; skillKey?: string | null } = {},
): Promise<AsyncGenerator<ReleaseAssistantEvent>> {
  // Resolved before anything is validated, because a skill launched with no
  // typed message supplies the message: pressing "Draft the notes" is a
  // question, and the turn it writes has to read as one in the thread.
  const skill = opts.skillKey
    ? await findEnabledSkill(db, scope, opts.skillKey)
    : null;
  if (opts.skillKey && !skill) {
    throw new ReleaseNotesInputError(
      "That skill is no longer available in this workspace.",
    );
  }
  if (skill && skill.surface !== "release") {
    // A key from the item panel, sent at a release. Refused rather than run: the
    // instructions are written about a different subject entirely, and running
    // them here produces a confident answer about something that is not on the
    // screen.
    throw new ReleaseNotesInputError("That skill does not apply to a release.");
  }

  const typed = text.trim();
  // The skill's own name, never a label the client chose: the recorded turn is
  // what the thread and every later replay say happened.
  const question = typed || skill?.name || "";
  if (!question) throw new ReleaseNotesInputError("A message is required.");
  if (question.length > MAX_TURN_CHARS) {
    throw new ReleaseNotesInputError(
      `A message can be at most ${MAX_TURN_CHARS.toLocaleString()} characters.`,
    );
  }

  const context = await buildReleaseContext(scope, releaseId, skill);
  const history = await readThread(db, scope, {
    kind: "release",
    releaseId,
  });

  const messages: ModelMessage[] = [
    { role: "system", content: context.systemPrompt },
    // Oldest turns are dropped rather than newest: the recent exchange is what
    // the next answer has to be coherent with.
    ...history.slice(-HISTORY_TURN_LIMIT).map((m) => ({
      role: m.role,
      content: replayed(m),
    })),
    { role: "user", content: question },
  ];

  return run();

  async function* run(): AsyncGenerator<ReleaseAssistantEvent> {
    let answer = "";
    let model: string | null = null;
    let usage: TokenUsage = {
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
    };
    let finished = false;

    for await (const event of streamWithWorkspaceModel(
      db,
      scope.workspaceId,
      {
        messages,
        maxTokens: ANSWER_MAX_TOKENS,
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
      // Attribution, not telemetry: the record of whose behalf the workspace's
      // money was spent on. Its own feature label rather than `assistant_turn`,
      // so a workspace reading its usage can tell writing release notes apart
      // from asking questions about items, and can see which one costs them.
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
        answer += event.text;
        yield { kind: "delta", text: event.text };
        continue;
      }
      model = event.model;
      usage = event.usage;
      finished = true;
    }

    // The stream ended without a terminal event, which is how the adapter
    // reports a cancel. Nothing is written; see the note above.
    if (!finished) return;

    yield {
      kind: "done",
      turns: await persistTurns(
        db,
        scope,
        { kind: "release", releaseId },
        question,
        answer,
        model,
        usage,
        {
          // A release's notes are a database column, so there is no blob sha to
          // record. There is still a version: the notes themselves. Hashing
          // them gives the accept path something to check, which is what stops
          // a proposal drafted this morning from silently replacing an edit
          // somebody made this afternoon.
          //
          // From the context, captured BEFORE the stream, not from a fresh read
          // taken after it. This used to re-read here, on the reasoning that
          // the honest base was "the notes as they stand at the moment the
          // draft is recorded". That reasoning is backwards. The base is what
          // the model was shown, because that is what the proposal is a
          // modification of. Re-reading afterwards records an edit made during
          // generation as though the model had seen it, and the accept then
          // overwrites that edit without ever detecting a conflict, which is
          // precisely what #286 exists to refuse. The item path has always got
          // this right (`feature`, resolved before its stream).
          baseSha: context.notesVersion,
          skillKey: skill?.key ?? null,
        },
      ),
    };
  }
}

/** Whether an answer carried a proposal, for callers that only have the text. */
export function answerHasProposal(answer: string): boolean {
  return parseAnswer(answer).proposal !== null;
}
