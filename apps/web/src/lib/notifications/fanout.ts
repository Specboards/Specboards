import {
  and,
  eq,
  features,
  inArray,
  isNull,
  members,
  notifications,
  type Database,
} from "@specboards/db";

import type { NotificationEventType } from "@/lib/notifications/catalog";
import { channelsFor } from "@/lib/notifications/preferences";
import { watchersFor } from "@/lib/notifications/watchers";

/**
 * Turning an outbox event into somebody's inbox.
 *
 * This runs inside the relay's per-event transaction, alongside the webhook
 * delivery rows and the `processedAt` stamp, so a notification is written
 * exactly once for an event and a crash part way through leaves the event
 * unprocessed rather than half-delivered. The transactional guarantee people
 * actually care about is one step earlier: the outbox row is written in the
 * same transaction as the change itself, so the change and the intent to
 * notify commit together and neither can exist without the other.
 *
 * Reading the outbox rather than notifying at each call site is the point.
 * Before this, every notice had its own hand-written recipient logic next to
 * the write that caused it, which is why being assigned an item told nobody:
 * the event existed, and nothing was listening.
 *
 * ── The shape of a fan-out ──────────────────────────────────────────────────
 * 1. Resolve targets: who this event concerns, and what it says to each of
 *    them. One event can produce two notification types (a comment mentions
 *    two people and lands on an item three others are watching).
 * 2. Subtract the actor. Nobody is told about their own action.
 * 3. Keep only active workspace members.
 * 4. Ask preferences which channels each recipient wants.
 * 5. Write the in-app rows, and hand the rest back for the email channel.
 */

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** The outbox row being expanded, as the relay already holds it. */
interface OutboxEventRow {
  id: string;
  workspaceId: string;
  productId: string | null;
  actorId: string | null;
  type: string;
  data: unknown;
  createdAt: Date;
}

/** One resolved notice: a person, and what they are being told. */
interface ResolvedNotice {
  recipientId: string;
  type: NotificationEventType;
  /** Internal `features.id` the notice deep-links to. */
  featureId: string;
  /** The comment that caused it, when there was one. */
  commentId: string | null;
  snippet: string;
  /** Channels this recipient wants it on, after preferences. */
  channels: { in_app: boolean; email: boolean };
}

/**
 * Fan one outbox event out to in-app notifications.
 *
 * Returns every notice that survived resolution, including the ones whose
 * in-app channel is off, because the email channel consumes the same list and
 * a recipient who wants email but not the bell is a legitimate combination.
 *
 * Never throws. A notification is a courtesy on top of a change that has
 * already committed; failing the relay transaction over one would strand the
 * webhook deliveries in the same event and retry the whole expansion forever.
 */
export async function fanOutNotifications(
  tx: Tx,
  ev: OutboxEventRow,
): Promise<ResolvedNotice[]> {
  try {
    const targets = await resolveTargets(tx, ev);
    if (targets.length === 0) return [];

    // Nobody hears about their own action. Done before the membership query so
    // a self-assignment costs nothing.
    const others = targets.filter((t) => t.recipientId !== ev.actorId);
    if (others.length === 0) return [];

    const active = await activeMembers(
      tx,
      ev.workspaceId,
      others.map((t) => t.recipientId),
    );
    const eligible = others.filter((t) => active.has(t.recipientId));
    if (eligible.length === 0) return [];

    const notices = await applyPreferences(tx, ev.workspaceId, eligible);

    const inApp = notices.filter((n) => n.channels.in_app);
    if (inApp.length > 0) {
      await tx.insert(notifications).values(
        inApp.map((n) => ({
          workspaceId: ev.workspaceId,
          recipientId: n.recipientId,
          actorId: ev.actorId,
          type: n.type,
          featureId: n.featureId,
          commentId: n.commentId,
          snippet: n.snippet,
        })),
      );
    }
    return notices;
  } catch (err) {
    console.error(`[notifications] fan-out failed for event ${ev.id}:`, err);
    return [];
  }
}

/** A target before preferences have had a say. */
type Target = Omit<ResolvedNotice, "channels">;

async function applyPreferences(
  tx: Tx,
  workspaceId: string,
  targets: readonly Target[],
): Promise<ResolvedNotice[]> {
  // Grouped by type: a user can want mentions by email and status changes only
  // in the app, so the question is asked per (type, set of users).
  const byType = new Map<NotificationEventType, Target[]>();
  for (const t of targets) {
    const list = byType.get(t.type);
    if (list) list.push(t);
    else byType.set(t.type, [t]);
  }

  const out: ResolvedNotice[] = [];
  for (const [type, list] of byType) {
    const decisions = await channelsFor(
      tx,
      workspaceId,
      list.map((t) => t.recipientId),
      type,
    );
    for (const t of list) {
      const channels = decisions.get(t.recipientId);
      if (!channels) continue;
      if (!channels.in_app && !channels.email) continue;
      out.push({ ...t, channels });
    }
  }
  return out;
}

/** The subset of `userIds` that are still active members of the workspace. */
async function activeMembers(
  tx: Tx,
  workspaceId: string,
  userIds: readonly string[],
): Promise<Set<string>> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return new Set();
  const rows = await tx
    .select({ userId: members.userId })
    .from(members)
    .where(
      and(
        eq(members.workspaceId, workspaceId),
        inArray(members.userId, unique),
        isNull(members.deactivatedAt),
      ),
    );
  return new Set(rows.map((r) => r.userId));
}

// ============================================================================
// Per-event recipient resolution
// ============================================================================

async function resolveTargets(tx: Tx, ev: OutboxEventRow): Promise<Target[]> {
  const data = (ev.data ?? {}) as Record<string, unknown>;
  switch (ev.type) {
    case "item.assigned":
      return itemAssignedTargets(tx, ev, data);
    case "item.status_changed":
      return itemStatusTargets(tx, ev, data);
    case "item.created":
      return itemCreatedTargets(tx, ev, data);
    case "comment.created":
      return commentTargets(tx, ev, data);
    case "release.shipped":
      return releaseShippedTargets(tx, ev, data);
    default:
      // Including item.deleted, which is emitted for webhooks and cannot reach
      // an inbox: the notification row's feature is NOT NULL and cascades.
      return [];
  }
}

/** The person the item was just given to. */
async function itemAssignedTargets(
  tx: Tx,
  ev: OutboxEventRow,
  data: Record<string, unknown>,
): Promise<Target[]> {
  const assigneeId = str(data.assigneeId);
  if (!assigneeId) return [];
  const item = await itemBySpecId(tx, ev.workspaceId, str(data.specId));
  if (!item) return [];
  return [
    {
      recipientId: assigneeId,
      type: "item.assigned",
      featureId: item.id,
      commentId: null,
      snippet: `${item.title} was assigned to you.`,
    },
  ];
}

/** The assignee and the watchers of the item that moved. */
async function itemStatusTargets(
  tx: Tx,
  ev: OutboxEventRow,
  data: Record<string, unknown>,
): Promise<Target[]> {
  const item = await itemBySpecId(tx, ev.workspaceId, str(data.specId));
  if (!item) return [];
  const to = str(data.to) ?? item.status;
  const recipients = await followers(tx, ev.workspaceId, item);
  const snippet = `${item.title} moved to ${to}.`;
  return recipients.map((recipientId) => ({
    recipientId,
    type: "item.status_changed" as const,
    featureId: item.id,
    commentId: null,
    snippet,
  }));
}

/**
 * Creation rolls up rather than announcing itself: the people who care that a
 * child appeared are the ones responsible for the parent. An item created with
 * no parent concerns nobody in particular and tells nobody.
 */
async function itemCreatedTargets(
  tx: Tx,
  ev: OutboxEventRow,
  data: Record<string, unknown>,
): Promise<Target[]> {
  const item = await itemBySpecId(tx, ev.workspaceId, str(data.specId));
  if (!item?.parentId) return [];
  const parent = await itemById(tx, ev.workspaceId, item.parentId);
  if (!parent) return [];
  const recipients = await followers(tx, ev.workspaceId, parent);
  const snippet = `${item.title} was added under ${parent.title}.`;
  // Deep-linked to the new child, which is the thing worth looking at.
  return recipients.map((recipientId) => ({
    recipientId,
    type: "item.created" as const,
    featureId: item.id,
    commentId: null,
    snippet,
  }));
}

/**
 * A comment produces two different notices from one event. The people it names
 * are being spoken to (`comment.mentioned`); the people following the item are
 * being kept in the loop (`comment.created`). They are tuned separately in
 * preferences, so somebody can keep mentions and mute the rest, and a mentioned
 * person is never also sent the quieter one.
 */
async function commentTargets(
  tx: Tx,
  ev: OutboxEventRow,
  data: Record<string, unknown>,
): Promise<Target[]> {
  const item = await itemBySpecId(tx, ev.workspaceId, str(data.specId));
  if (!item) return [];
  const commentId = str(data.commentId) ?? null;
  const snippet = str(data.snippet) ?? "";
  const mentioned = new Set(strList(data.mentionedUserIds));

  const out: Target[] = [...mentioned].map((recipientId) => ({
    recipientId,
    type: "comment.mentioned" as const,
    featureId: item.id,
    commentId,
    snippet,
  }));

  for (const recipientId of await followers(tx, ev.workspaceId, item)) {
    if (mentioned.has(recipientId)) continue;
    out.push({
      recipientId,
      type: "comment.created",
      featureId: item.id,
      commentId,
      snippet,
    });
  }
  return out;
}

/**
 * A shipped release tells the people whose work was in it, once each, rather
 * than once per item. The row deep-links to one of their own items, because a
 * notification row is item-shaped and their work is the part of the release
 * they came to look at.
 */
async function releaseShippedTargets(
  tx: Tx,
  ev: OutboxEventRow,
  data: Record<string, unknown>,
): Promise<Target[]> {
  const releaseId = str(data.releaseId);
  if (!releaseId) return [];
  const name = str(data.name) ?? "A release";
  const rows = await tx
    .select({ id: features.id, assigneeId: features.assigneeId })
    .from(features)
    .where(
      and(
        eq(features.workspaceId, ev.workspaceId),
        eq(features.releaseId, releaseId),
      ),
    )
    .orderBy(features.createdAt);

  const byAssignee = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.assigneeId) continue;
    const list = byAssignee.get(r.assigneeId);
    if (list) list.push(r.id);
    else byAssignee.set(r.assigneeId, [r.id]);
  }

  return [...byAssignee].map(([recipientId, ids]) => ({
    recipientId,
    type: "release.shipped" as const,
    featureId: ids[0]!,
    commentId: null,
    snippet:
      ids.length === 1
        ? `${name} shipped, including your item.`
        : `${name} shipped, including ${ids.length} of your items.`,
  }));
}

// ============================================================================
// Shared lookups
// ============================================================================

interface ItemRow {
  id: string;
  specId: string;
  title: string;
  status: string;
  assigneeId: string | null;
  parentId: string | null;
}

/** Everyone who should hear about a change to this item. */
async function followers(
  tx: Tx,
  workspaceId: string,
  item: ItemRow,
): Promise<string[]> {
  const watchers = await watchersFor(tx, workspaceId, [item.id]);
  const set = new Set(watchers.get(item.id) ?? []);
  if (item.assigneeId) set.add(item.assigneeId);
  return [...set];
}

const itemColumns = {
  id: features.id,
  specId: features.specId,
  title: features.title,
  status: features.status,
  assigneeId: features.assigneeId,
  parentId: features.parentId,
};

async function itemBySpecId(
  tx: Tx,
  workspaceId: string,
  specId: string | null,
): Promise<ItemRow | null> {
  if (!specId) return null;
  const [row] = await tx
    .select(itemColumns)
    .from(features)
    .where(
      and(eq(features.workspaceId, workspaceId), eq(features.specId, specId)),
    )
    .limit(1);
  return row ?? null;
}

async function itemById(
  tx: Tx,
  workspaceId: string,
  id: string,
): Promise<ItemRow | null> {
  const [row] = await tx
    .select(itemColumns)
    .from(features)
    .where(and(eq(features.workspaceId, workspaceId), eq(features.id, id)))
    .limit(1);
  return row ?? null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function strList(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : [];
}
