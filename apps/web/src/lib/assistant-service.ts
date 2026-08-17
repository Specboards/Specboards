import {
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
 * ({@link resolveItem}), which is what applies product visibility. That read is
 * heavier than a bare existence check, and it is deliberate: the conversation
 * is about the item's content, so "may this person read this item" and "may
 * this person read this thread" have to be one decision made in one place. Two
 * checks that agree today are two checks that can disagree later.
 *
 * ── Why nothing here writes to the item ─────────────────────────────────────
 * This module has no path that changes a spec, a card, or anything else about
 * the item. That is the epic's hard constraint rather than an accident of the
 * current slice: what the assistant produces becomes a reviewable proposal a
 * human accepts, travelling the same write path as a human edit. When that
 * lands it goes beside this, not inside it.
 */

/** The item does not exist, or the caller cannot see it. Routes map to 404. */
export class AssistantItemError extends Error {}
/** A bad turn (empty, or longer than an endpoint will take). Routes map to 422. */
export class AssistantInputError extends Error {}

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
}): AssistantMessageView {
  return {
    id: row.id,
    role: row.role === "assistant" ? "assistant" : "user",
    content: row.content,
    authorId: row.authorId,
    authorName: row.authorName,
    model: row.model,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The item, checked for visibility, plus the internal row id the thread hangs
 * off. `getFeature` returns null both for "no such item" and "not yours",
 * which is the right conflation to preserve: distinguishing them would let a
 * caller enumerate items in products they cannot see.
 */
async function resolveItem(
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
    })
    .from(assistantMessages)
    .leftJoin(users, eq(users.id, assistantMessages.authorId))
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
  const { featureId } = await resolveItem(db, scope, specId);
  return readThread(db, scope.workspaceId, featureId);
}

/** Everything the panel needs to render, in one item resolution. */
export interface AssistantPanelData {
  messages: AssistantMessageView[];
  context: ContextField[];
  modelConnected: boolean;
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
  const { feature, featureId } = await resolveItem(db, scope, specId);
  const [messages, assembled, modelConnected] = await Promise.all([
    readThread(db, scope.workspaceId, featureId),
    buildContext(scope, feature),
    isModelConnected(db, scope.workspaceId),
  ]);
  return { messages, context: assembled.fields, modelConnected };
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

async function buildContext(scope: WorkspaceScope, feature: FeatureDetail) {
  const store = await getStore();
  const [workflow, levels, goals] = await Promise.all([
    resolveWorkflowFor(scope, feature.productId),
    store.listLevels(scope, feature.productId),
    store.listItemGoals(feature.specId, scope),
  ]);

  const ownIndex = levels.findIndex((l) => l.key === feature.level);

  return assembleItemContext({
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

  const { feature, featureId } = await resolveItem(db, scope, specId);
  const { systemPrompt } = await buildContext(scope, feature);
  const history = await readThread(db, scope.workspaceId, featureId);

  const messages: ModelMessage[] = [
    { role: "system", content: systemPrompt },
    // Oldest turns are dropped rather than newest: the recent exchange is what
    // the next answer has to be coherent with.
    ...history.slice(-HISTORY_TURN_LIMIT).map((m) => ({
      role: m.role,
      content: m.content,
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
      turns: await persistTurns(db, scope, featureId, question, answer, model, usage),
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
): Promise<AssistantMessageView[]> {
  const now = new Date();
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
