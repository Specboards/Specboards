import { canWriteProduct } from "@specboards/core";
import {
  alias,
  and,
  asc,
  assistantMessages,
  eq,
  features,
  modelProviders,
  users,
  type Database,
} from "@specboards/db";

import { assembleItemContext, type ContextField } from "@/lib/ai/item-context";
import { parseAnswer } from "@/lib/ai/proposals";
import type { ModelErrorKind, ModelMessage, TokenUsage } from "@/lib/ai/provider";
import { statusLabel } from "@/lib/feature-helpers";
import { streamWithWorkspaceModel } from "@/lib/model-provider-service";
import { resolveWorkflowFor } from "@/lib/repo-config";
import { getStore } from "@/lib/store";
import type { FeatureDetail, WorkspaceScope } from "@/lib/store/types";

/**
 * The assistant conversation about one item: read it, and add a turn to it.
 *
 * ── Where authorization comes from ──────────────────────────────────────────
 * Every entry point resolves the item through the store first
 * ({@link resolveAssistantItem}), which is what applies product visibility. That
 * read is heavier than a bare existence check, and it is deliberate: the
 * conversation is about the item's content, so "may this person read this item"
 * and "may this person read this thread" have to be one decision made in one
 * place. Two checks that agree today are two checks that can disagree later.
 *
 * ── Why nothing here writes to the item ─────────────────────────────────────
 * This module has no path that changes a spec, a card, or anything else about
 * the item, and that is the epic's hard constraint rather than an accident. An
 * answer may *contain* a proposed edit, which is inert text until a person
 * accepts it; applying one lives in `assistant-proposals.ts`, deliberately
 * beside this rather than inside it, and goes through the same write path a
 * human edit takes. There is no code path from a model's output to a write.
 */

/** The item does not exist, or the caller cannot see it. Routes map to 404. */
export class AssistantItemError extends Error {}
/** A bad turn (empty, or longer than an endpoint will take). Routes map to 422. */
export class AssistantInputError extends Error {}

/**
 * What became of a proposed edit carried by a turn.
 *
 * The proposed text itself is deliberately absent: it is already in `content`,
 * and the browser parses it out with the same function the server does. Sending
 * it twice would create two copies of one string that can drift, where the one
 * that is rendered and the one that would be applied stop being the same text.
 */
export interface ProposalState {
  /** Null while nobody has decided. */
  outcome: "accepted" | "rejected" | null;
  resolvedByName: string | null;
  resolvedAt: string | null;
  /** Where an accepted edit landed, for a git-backed spec. */
  commitSha: string | null;
}

/** One persisted turn, as the browser sees it. */
export interface AssistantMessageView {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** The human this turn belongs to: who typed it, or who asked for it. */
  authorId: string;
  authorName: string | null;
  /** What answered, as the endpoint reported it. Null on a user turn. */
  model: string | null;
  createdAt: string;
  /** Present only when this turn actually contains a proposal. */
  proposal: ProposalState | null;
}

export type AssistantSendOutcome =
  | { ok: true; turns: AssistantMessageView[] }
  | {
      ok: false;
      error: { kind: ModelErrorKind | "not_configured"; message: string };
    };

/**
 * How many past turns are replayed to the model.
 *
 * A thread that grows without bound eventually exceeds any context window, and
 * the first customer to hit it is the one running a small model on their own
 * hardware, which is the case this epic exists to serve. Capping by turn count
 * rather than by characters keeps the boundary somewhere a person can predict:
 * "the last twenty messages" is explicable, "however much fitted" is not.
 */
export const HISTORY_TURN_LIMIT = 20;

/**
 * Longest question accepted. Generous enough to paste a section of a document
 * into, short enough that the failure arrives from us with an explanation
 * rather than from the endpoint as a 400.
 */
export const MAX_TURN_CHARS = 8_000;

function toView(row: {
  id: string;
  role: string;
  content: string;
  authorId: string;
  authorName: string | null;
  model: string | null;
  createdAt: Date;
  proposalOutcome?: string | null;
  proposalResolvedByName?: string | null;
  proposalResolvedAt?: Date | null;
  proposalCommitSha?: string | null;
}): AssistantMessageView {
  // Whether there is a proposal is decided by reading the content, never by the
  // outcome column, which is null both for "not decided yet" and for "there was
  // never one". The content is the only place that distinction lives.
  const hasProposal =
    row.role === "assistant" && parseAnswer(row.content).proposal !== null;
  return {
    id: row.id,
    role: row.role === "assistant" ? "assistant" : "user",
    content: row.content,
    authorId: row.authorId,
    authorName: row.authorName,
    model: row.model,
    createdAt: row.createdAt.toISOString(),
    proposal: hasProposal
      ? {
          outcome:
            row.proposalOutcome === "accepted" || row.proposalOutcome === "rejected"
              ? row.proposalOutcome
              : null,
          resolvedByName: row.proposalResolvedByName ?? null,
          resolvedAt: row.proposalResolvedAt?.toISOString() ?? null,
          commitSha: row.proposalCommitSha ?? null,
        }
      : null,
  };
}

/**
 * The item, checked for visibility, plus the internal row id the thread hangs
 * off. `getFeature` returns null both for "no such item" and "not yours",
 * which is the right conflation to preserve: distinguishing them would let a
 * caller enumerate items in products they cannot see.
 */
export async function resolveAssistantItem(
  db: Database,
  scope: WorkspaceScope,
  specId: string,
): Promise<{ feature: FeatureDetail; featureId: string }> {
  const store = await getStore();
  const feature = await store.getFeature(specId, scope);
  if (!feature) throw new AssistantItemError(`Unknown item: ${specId}`);

  const [row] = await db
    .select({ id: features.id })
    .from(features)
    .where(
      and(
        eq(features.specId, specId),
        eq(features.workspaceId, scope.workspaceId),
      ),
    )
    .limit(1);
  if (!row) throw new AssistantItemError(`Unknown item: ${specId}`);
  return { feature, featureId: row.id };
}

/**
 * Who accepted or rejected a proposal, joined separately from who asked. Two
 * aliases of `users` rather than one, because they are routinely different
 * people: that is the whole shape of a review.
 */
const resolvers = alias(users, "proposal_resolvers");

async function readThread(
  db: Database,
  workspaceId: string,
  featureId: string,
): Promise<AssistantMessageView[]> {
  const rows = await db
    .select({
      id: assistantMessages.id,
      role: assistantMessages.role,
      content: assistantMessages.content,
      authorId: assistantMessages.authorId,
      model: assistantMessages.model,
      createdAt: assistantMessages.createdAt,
      authorName: users.name,
      proposalOutcome: assistantMessages.proposalOutcome,
      proposalResolvedAt: assistantMessages.proposalResolvedAt,
      proposalCommitSha: assistantMessages.proposalCommitSha,
      proposalResolvedByName: resolvers.name,
    })
    .from(assistantMessages)
    .leftJoin(users, eq(users.id, assistantMessages.authorId))
    .leftJoin(resolvers, eq(resolvers.id, assistantMessages.proposalResolvedBy))
    .where(
      and(
        eq(assistantMessages.workspaceId, workspaceId),
        eq(assistantMessages.featureId, featureId),
      ),
    )
    .orderBy(asc(assistantMessages.createdAt));
  return rows.map(toView);
}

/** The whole thread for an item, oldest first. Empty when nobody has asked. */
export async function listAssistantThread(
  db: Database,
  scope: WorkspaceScope,
  specId: string,
): Promise<AssistantMessageView[]> {
  const { featureId } = await resolveAssistantItem(db, scope, specId);
  return readThread(db, scope.workspaceId, featureId);
}

/** Everything the panel needs to render, in one item resolution. */
export interface AssistantPanelData {
  messages: AssistantMessageView[];
  context: ContextField[];
  modelConnected: boolean;
  /**
   * Whether this person may accept a proposal. The accept route checks for
   * itself; this is so the panel does not offer a button that would be refused,
   * and so the model is not told it can propose to someone who cannot accept.
   */
  canEdit: boolean;
  /**
   * Whether the assistant will be invited to propose an edit at all. False for
   * someone who cannot write, and false when the description is too long to
   * send whole: a replacement body drafted from a shortened description would
   * delete everything past the cut. The panel says so rather than leaving
   * someone asking why the assistant has stopped offering.
   */
  canPropose: boolean;
  /**
   * The item's description as it is right now, which is what a proposal is
   * diffed against. Sent from here rather than read off the page so the diff
   * shown and the text the accept is guarded against come from one place.
   */
  body: string;
}

/**
 * Whether this scope may change this item's description.
 *
 * The same check the write paths make, asked early. Duplicating a permission
 * check is usually how they drift, so this one is only ever advisory: it decides
 * what to *offer*, and `updateSpecContent` / `patchFeature` still decide what
 * happens. A disagreement between them costs a refused click, not a bad write.
 */
export async function canEditItem(
  scope: WorkspaceScope,
  feature: FeatureDetail,
): Promise<boolean> {
  const store = await getStore();
  const access = await store.getProductAccess(scope);
  return feature.productId === null
    ? access.isOrgAdmin
    : access.isOrgAdmin || canWriteProduct(access, feature.productId);
}

/**
 * What the panel opens with.
 *
 * One function rather than the caller composing `listAssistantThread` and
 * `assistantContextFor`, because each of those resolves the item to authorize
 * itself and doing both would pay for that twice on the one request a person
 * actually waits for.
 */
export async function getAssistantPanelData(
  db: Database,
  scope: WorkspaceScope,
  specId: string,
): Promise<AssistantPanelData> {
  const { feature, featureId } = await resolveAssistantItem(db, scope, specId);
  const canEdit = await canEditItem(scope, feature);
  const [messages, assembled, modelConnected] = await Promise.all([
    readThread(db, scope.workspaceId, featureId),
    buildContext(scope, feature, canEdit),
    isModelConnected(db, scope.workspaceId),
  ]);
  return {
    messages,
    context: assembled.fields,
    modelConnected,
    canEdit,
    canPropose: assembled.canPropose,
    body: feature.content,
  };
}

/**
 * Whether this workspace has a usable model connection.
 *
 * A boolean, not the connection: reading the endpoint a workspace sends its
 * inference to is owner-only (see the model-provider route), and this is
 * answered for every member. "Something is connected" is what the panel needs
 * to know, and it tells the caller nothing about where or with whose key.
 *
 * Worth the extra query because without it the empty state has to guess. The
 * honest thing to show a workspace with no model is "connect one first", not an
 * inviting composer that fails on the first question.
 */
export async function isModelConnected(
  db: Database,
  workspaceId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: modelProviders.id })
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.workspaceId, workspaceId),
        eq(modelProviders.enabled, true),
      ),
    )
    .limit(1);
  return Boolean(row);
}

async function buildContext(
  scope: WorkspaceScope,
  feature: FeatureDetail,
  canEdit: boolean,
) {
  const store = await getStore();
  const [workflow, levels, goals] = await Promise.all([
    resolveWorkflowFor(scope, feature.productId),
    store.listLevels(scope, feature.productId),
    store.listItemGoals(feature.specId, scope),
  ]);

  const ownIndex = levels.findIndex((l) => l.key === feature.level);

  return assembleItemContext({
    canEdit,
    title: feature.title,
    levelLabel: levels[ownIndex]?.label ?? feature.level,
    statusLabel: statusLabel(feature.status, workflow),
    body: feature.content,
    parentTitle: feature.parentTitle,
    // Levels are ordered top to leaf, so the parent's label is the entry above
    // this one. Resolved from the list rather than assumed, because the set is
    // configurable and a workspace may have renamed or removed a level.
    parentLevelLabel:
      ownIndex > 0 ? (levels[ownIndex - 1]?.label ?? null) : null,
    children: feature.children.map((c) => ({
      title: c.title,
      statusLabel: statusLabel(c.status, workflow),
    })),
    goals: goals.map((g) => g.title),
    tags: feature.tags,
  });
}

/**
 * A past turn as the model is shown it again.
 *
 * A rejected proposal is annotated, because otherwise a rejection is invisible
 * to every later turn: the model reads its own draft sitting in the history,
 * has no way to know a person turned it down, and folds it back into the next
 * proposal. Observed on the first thread that rejected anything, where the very
 * next proposal quietly reinstated the rejected line. The reviewer does see it
 * in the diff, so nothing lands unnoticed, but Reject that has to be pressed
 * repeatedly is Reject that does not mean anything.
 *
 * An *accepted* proposal is left alone. Its text is the description now, and
 * the description is already in the system prompt, so saying so again would be
 * telling the model something it can read.
 */
function replayed(m: AssistantMessageView): string {
  if (m.role !== "assistant" || m.proposal?.outcome !== "rejected") {
    return m.content;
  }
  return `${m.content}\n\n[This proposed change was reviewed and not accepted. Do not include it in a later proposal unless you are asked for it again.]`;
}

/** What the caller of a turn observes, in order. */
export type AssistantEvent =
  /** A fragment of the answer, to append to what is on screen. */
  | { kind: "delta"; text: string }
  /** The answer finished and both turns are now in the thread. */
  | { kind: "done"; turns: AssistantMessageView[] }
  | {
      kind: "error";
      error: { kind: ModelErrorKind | "not_configured"; message: string };
    };

/**
 * Begin a turn: authorize, validate, and return the stream of what happens.
 *
 * ── Why the setup is eager and only the tokens are lazy ─────────────────────
 * A generator runs nothing until it is first pulled, which would put "you
 * cannot see this item" and "that message is too long" *inside* the response
 * body, long after the HTTP status was chosen. So everything that can be known
 * before the endpoint is called happens here and throws here, and the caller
 * gets back an iterator that only ever produces the events below. The route can
 * therefore still answer 404 or 422 properly, and once it starts streaming it
 * is committed to a 200 that it can honour.
 *
 * ── What is persisted, and when ─────────────────────────────────────────────
 * Both turns are written together after the answer completes, never before. A
 * question written up front would sit in the thread with no answer under it
 * whenever the endpoint failed: that reads as the assistant ignoring someone,
 * it replays into the next request as an unanswered turn, and a retry looks
 * like the person asked twice.
 *
 * ── What cancelling does ────────────────────────────────────────────────────
 * Nothing is kept. Cancel means "stop, this is not what I wanted", and the
 * half-sentence it stopped on is worse than useless in a thread: it would be
 * replayed as context into every later question and drag the answers with it.
 * It is also the only option the protocol leaves us, since an aborted stream
 * never reaches the chunk that carries the usage numbers, so a row written for
 * it would claim a cost we cannot know. The tokens already produced are still
 * billed by the provider; that is inherent in stopping a generation, and no
 * bookkeeping on our side changes it.
 */
export async function startAssistantTurn(
  db: Database,
  scope: WorkspaceScope,
  specId: string,
  text: string,
  opts: { signal?: AbortSignal } = {},
): Promise<AsyncGenerator<AssistantEvent>> {
  const question = text.trim();
  if (!question) throw new AssistantInputError("A message is required.");
  if (question.length > MAX_TURN_CHARS) {
    throw new AssistantInputError(
      `A message can be at most ${MAX_TURN_CHARS.toLocaleString()} characters.`,
    );
  }

  const { feature, featureId } = await resolveAssistantItem(db, scope, specId);
  const canEdit = await canEditItem(scope, feature);
  const { systemPrompt } = await buildContext(scope, feature, canEdit);
  const history = await readThread(db, scope.workspaceId, featureId);

  const messages: ModelMessage[] = [
    { role: "system", content: systemPrompt },
    // Oldest turns are dropped rather than newest: the recent exchange is what
    // the next answer has to be coherent with.
    ...history.slice(-HISTORY_TURN_LIMIT).map((m) => ({
      role: m.role,
      content: replayed(m),
    })),
    { role: "user", content: question },
  ];

  return run();

  async function* run(): AsyncGenerator<AssistantEvent> {
    let answer = "";
    let model: string | null = null;
    let usage: TokenUsage = {
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
    };
    let finished = false;

    for await (const event of streamWithWorkspaceModel(db, scope.workspaceId, {
      messages,
      ...(opts.signal ? { signal: opts.signal } : {}),
    })) {
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
      // done
      model = event.model;
      usage = event.usage;
      finished = true;
    }

    // The stream ended without a terminal event, which is how the adapter
    // reports a cancel. Nothing is written; see the note above.
    if (!finished) return;

    yield {
      kind: "done",
      turns: await persistTurns(db, scope, featureId, question, answer, model, usage, {
        // The version the draft was written against, recorded now rather than
        // read at accept time. A proposal can sit on a card for a day, and what
        // makes accepting it safe is being guarded against the document the
        // model was actually shown.
        baseSha: feature.blobSha,
      }),
    };
  }
}

/** Write the pair and return them as the browser will see them. */
async function persistTurns(
  db: Database,
  scope: WorkspaceScope,
  featureId: string,
  question: string,
  answer: string,
  model: string | null,
  usage: TokenUsage,
  opts: { baseSha: string | null },
): Promise<AssistantMessageView[]> {
  const now = new Date();
  // Recorded only when the answer actually carries a proposal, so a sha on a
  // row always means "this text was drafted against that version" rather than
  // "this turn happened while the spec looked like that".
  const proposalBaseSha =
    parseAnswer(answer).proposal === null ? null : opts.baseSha;
  const inserted = await db
    .insert(assistantMessages)
    .values([
      {
        workspaceId: scope.workspaceId,
        featureId,
        role: "user",
        content: question,
        authorId: scope.userId,
        createdAt: now,
      },
      {
        workspaceId: scope.workspaceId,
        featureId,
        role: "assistant",
        content: answer,
        // The person who asked, so every row in the thread names someone
        // accountable for it. `role` is what says a model wrote this one.
        authorId: scope.userId,
        model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        proposalBaseSha,
        // One millisecond later, so the ordering of a pair written in the same
        // statement is decided here rather than by however Postgres happens to
        // resolve two identical timestamps.
        createdAt: new Date(now.getTime() + 1),
      },
    ])
    .returning();

  // Looked up rather than taken from the history, which is empty on the first
  // turn of a thread and would leave that pair permanently unattributed.
  const [author] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, scope.userId))
    .limit(1);
  const authorName = author?.name ?? null;

  // A freshly written pair has no resolution yet, so the proposal columns are
  // left at their defaults rather than mapped: `toView` reads the content to
  // decide whether there is a proposal at all.
  return inserted.map((row) =>
    toView({
      id: row.id,
      role: row.role,
      content: row.content,
      authorId: row.authorId,
      authorName,
      model: row.model,
      createdAt: row.createdAt,
    }),
  );
}
