/**
 * Reading and writing notification settings: a workspace's defaults, and each
 * member's departures from them.
 *
 * Both tables hold overrides only, and the resolution that turns them into a
 * grid lives in `lib/notifications/matrix.ts`. What is specific to this module
 * is the write half, and its one rule: a change that says "inherit" deletes a
 * row rather than writing the inherited value into it. See
 * {@link NotificationSettingChange}.
 *
 * The two grids are deliberately not one query. A member may read their
 * workspace's defaults (they need them to render "inherited") and may not read
 * anybody else's preferences; an admin may write the defaults and still cannot
 * read a single member's preferences, which RLS enforces against this very
 * connection. That is why the override count an admin sees comes back from a
 * definer function that returns the tally and never the rows: written as an
 * ordinary aggregate here it would be filtered to zero without erroring.
 */

import {
  and,
  eq,
  notificationDefaults,
  notificationPreferences,
  or,
  sql,
} from "@specboards/db";

import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_EVENT_TYPES,
} from "@/lib/notifications/catalog";
import {
  resolveUserMatrix,
  resolveWorkspaceMatrix,
  type StoredSetting,
} from "@/lib/notifications/matrix";

import {
  NotificationSettingsError,
  type NotificationDefaultsView,
  type NotificationPreferenceView,
  type NotificationSettingChange,
  type WorkspaceScope,
} from "../types";

import type { DbStoreContext, Tx } from "./context";

/** A change the catalog still recognises, with its strings narrowed. */
type ValidChange = {
  type: string;
  channel: string;
  enabled: boolean | null;
};

/**
 * Reject anything the catalog does not know.
 *
 * Reads tolerate an unrecognised stored row (it predates a retirement, and
 * dropping it from the answer is the kind thing to do). Writes must not: a
 * request naming a type that does not exist is a caller mistake, and storing
 * it would create exactly the row the read path then has to forgive.
 */
function validate(
  changes: readonly NotificationSettingChange[],
): ValidChange[] {
  const types = new Set<string>(NOTIFICATION_EVENT_TYPES);
  const channels = new Set<string>(NOTIFICATION_CHANNELS);
  const seen = new Set<string>();
  const out: ValidChange[] = [];
  for (const c of changes) {
    if (!types.has(c.type)) {
      throw new NotificationSettingsError(`Unknown notification type: ${c.type}`);
    }
    if (!channels.has(c.channel)) {
      throw new NotificationSettingsError(`Unknown channel: ${c.channel}`);
    }
    // One cell named twice in one request has no defined outcome: the two
    // statements would race on ordering within the batch. Refusing is better
    // than picking a winner nobody asked for.
    const key = `${c.type} ${c.channel}`;
    if (seen.has(key)) {
      throw new NotificationSettingsError(
        `Duplicate change for ${c.type} on ${c.channel}.`,
      );
    }
    seen.add(key);
    out.push({ type: c.type, channel: c.channel, enabled: c.enabled });
  }
  return out;
}

/** The workspace's stored default overrides. */
async function readDefaults(tx: Tx, ws: string): Promise<StoredSetting[]> {
  return tx
    .select({
      eventType: notificationDefaults.eventType,
      channel: notificationDefaults.channel,
      enabled: notificationDefaults.enabled,
    })
    .from(notificationDefaults)
    .where(eq(notificationDefaults.workspaceId, ws));
}

/** One user's stored overrides. */
async function readPreferences(
  tx: Tx,
  ws: string,
  userId: string,
): Promise<StoredSetting[]> {
  return tx
    .select({
      eventType: notificationPreferences.eventType,
      channel: notificationPreferences.channel,
      enabled: notificationPreferences.enabled,
    })
    .from(notificationPreferences)
    .where(
      and(
        eq(notificationPreferences.workspaceId, ws),
        eq(notificationPreferences.userId, userId),
      ),
    );
}

export async function getNotificationPreferences(
  ctx: DbStoreContext,
  scope?: WorkspaceScope,
): Promise<NotificationPreferenceView> {
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const [defaults, mine] = await Promise.all([
      readDefaults(tx, ws),
      readPreferences(tx, ws, scope!.userId),
    ]);
    return { rows: resolveUserMatrix(defaults, mine) };
  });
}

export async function updateNotificationPreferences(
  ctx: DbStoreContext,
  changes: readonly NotificationSettingChange[],
  scope?: WorkspaceScope,
): Promise<NotificationPreferenceView> {
  const valid = validate(changes);
  return ctx.scoped(scope, async (tx) => {
    const ws = scope!.workspaceId;
    const userId = scope!.userId;

    const clears = valid.filter((c) => c.enabled === null);
    const sets = valid.filter((c) => c.enabled !== null);

    if (clears.length > 0) {
      await tx.delete(notificationPreferences).where(
        and(
          eq(notificationPreferences.workspaceId, ws),
          eq(notificationPreferences.userId, userId),
          cellsIn(clears, notificationPreferences),
        ),
      );
    }
    if (sets.length > 0) {
      await tx
        .insert(notificationPreferences)
        .values(
          sets.map((c) => ({
            workspaceId: ws,
            userId,
            eventType: c.type,
            channel: c.channel,
            enabled: c.enabled!,
          })),
        )
        .onConflictDoUpdate({
          target: [
            notificationPreferences.workspaceId,
            notificationPreferences.userId,
            notificationPreferences.eventType,
            notificationPreferences.channel,
          ],
          set: {
            enabled: sql`excluded.enabled`,
            updatedAt: new Date(),
          },
        });
    }

    const [defaults, mine] = await Promise.all([
      readDefaults(tx, ws),
      readPreferences(tx, ws, userId),
    ]);
    return { rows: resolveUserMatrix(defaults, mine) };
  });
}

export async function getNotificationDefaults(
  ctx: DbStoreContext,
  scope?: WorkspaceScope,
): Promise<NotificationDefaultsView> {
  return ctx.scoped(scope, async (tx) => {
    await assertAdmin(ctx, tx, scope!);
    return defaultsView(tx, scope!.workspaceId);
  });
}

export async function updateNotificationDefaults(
  ctx: DbStoreContext,
  changes: readonly NotificationSettingChange[],
  scope?: WorkspaceScope,
): Promise<NotificationDefaultsView> {
  const valid = validate(changes);
  return ctx.scoped(scope, async (tx) => {
    await assertAdmin(ctx, tx, scope!);
    const ws = scope!.workspaceId;

    const clears = valid.filter((c) => c.enabled === null);
    const sets = valid.filter((c) => c.enabled !== null);

    if (clears.length > 0) {
      await tx
        .delete(notificationDefaults)
        .where(
          and(
            eq(notificationDefaults.workspaceId, ws),
            cellsIn(clears, notificationDefaults),
          ),
        );
    }
    if (sets.length > 0) {
      await tx
        .insert(notificationDefaults)
        .values(
          sets.map((c) => ({
            workspaceId: ws,
            eventType: c.type,
            channel: c.channel,
            enabled: c.enabled!,
            updatedBy: scope!.userId,
          })),
        )
        .onConflictDoUpdate({
          target: [
            notificationDefaults.workspaceId,
            notificationDefaults.eventType,
            notificationDefaults.channel,
          ],
          set: {
            enabled: sql`excluded.enabled`,
            updatedBy: scope!.userId,
            updatedAt: new Date(),
          },
        });
    }

    return defaultsView(tx, ws);
  });
}

/** The defaults grid plus the per-cell override tally. */
async function defaultsView(
  tx: Tx,
  ws: string,
): Promise<NotificationDefaultsView> {
  const [stored, tallies] = await Promise.all([
    readDefaults(tx, ws),
    /*
     * Through a definer function rather than as a query over the table.
     *
     * An admin may not read anybody's preferences, and the policies enforce
     * that against this very connection: an aggregate written here would come
     * back as zero for every cell, silently, because RLS filters the rows
     * before the count sees them. That is not a limitation to work around, it
     * is the privacy rule doing its job, and the function exists to answer the
     * one question that does not need the rows. It re-checks that the caller
     * is an admin itself; see migration 0002.
     */
    tx.execute<{ event_type: string; channel: string; n: string | number }>(
      sql`select * from public.specboards_notification_override_counts(${ws}::uuid)`,
    ),
  ]);

  const overrideCounts: Record<string, Record<string, number>> = {};
  for (const t of tallies) {
    (overrideCounts[t.event_type] ??= {})[t.channel] = Number(t.n);
  }
  return { rows: resolveWorkspaceMatrix(stored), overrideCounts };
}

/**
 * Refuse a non-admin before touching the table.
 *
 * RLS would refuse the write anyway, but as a silent zero-row result rather
 * than an error: `DELETE` and `INSERT ... ON CONFLICT` both succeed against no
 * visible rows. Without this the grid would report success and change nothing,
 * which is the worst of the available outcomes.
 */
async function assertAdmin(
  ctx: DbStoreContext,
  tx: Tx,
  scope: WorkspaceScope,
): Promise<void> {
  const access = await ctx.accessIn(tx, scope);
  if (!access.isOrgAdmin) {
    throw new NotificationSettingsError(
      "Only an organization admin can change workspace notification defaults.",
    );
  }
}

/**
 * A predicate matching exactly the named cells, so a whole-grid reset is one
 * statement rather than one per checkbox. Both callers pass column references
 * from their own table, which is why the table is an argument.
 */
function cellsIn(
  cells: readonly ValidChange[],
  table: typeof notificationDefaults | typeof notificationPreferences,
) {
  return or(
    ...cells.map((c) =>
      and(eq(table.eventType, c.type), eq(table.channel, c.channel)),
    ),
  )!;
}
