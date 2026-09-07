import { getStore, type WorkspaceScope } from "@/lib/store";
import {
  NotificationSettingsError,
  type NotificationDefaultsView,
  type NotificationPreferenceView,
  type NotificationSettingChange,
} from "@/lib/store/types";

/**
 * Notification settings: a user's own, and the workspace defaults behind them.
 *
 * Thin over the store, with one job of its own: turning a request body into
 * changes the store will accept. That parsing lives here rather than in the
 * two routes because both surfaces send the same shape and the tri-state at
 * the middle of it (`enabled: null` means reset, not false) is the sort of
 * thing that goes wrong once per copy.
 */

/** Cap on how many cells one request may carry. A whole-grid reset is types x
 * channels, so this leaves generous headroom while keeping a hand-written
 * request from turning into an unbounded statement. */
const MAX_CHANGES = 200;

/**
 * Read `{ changes: [...] }` off a request body.
 *
 * Strict, unlike the inbox's query parsing: a filter nobody understands should
 * narrow nothing, but a setting nobody understands must not be silently
 * dropped. Somebody is watching a checkbox to see whether it stuck.
 */
export function parseSettingChanges(body: unknown): NotificationSettingChange[] {
  const raw = (body as { changes?: unknown } | null)?.changes;
  if (!Array.isArray(raw)) {
    throw new NotificationSettingsError("Expected a `changes` array.");
  }
  if (raw.length > MAX_CHANGES) {
    throw new NotificationSettingsError(
      `Too many changes in one request (max ${MAX_CHANGES}).`,
    );
  }
  return raw.map((entry) => {
    const c = entry as Record<string, unknown> | null;
    if (typeof c?.type !== "string" || typeof c?.channel !== "string") {
      throw new NotificationSettingsError(
        "Each change needs a `type` and a `channel`.",
      );
    }
    // Undefined and null both mean reset. They arrive as the same thing over
    // JSON anyway (an omitted key and an explicit null are indistinguishable
    // after a round trip through some clients), so treating them differently
    // would be a distinction the wire cannot carry.
    if (c.enabled === null || c.enabled === undefined) {
      return { type: c.type, channel: c.channel, enabled: null };
    }
    if (typeof c.enabled !== "boolean") {
      throw new NotificationSettingsError(
        "`enabled` must be true, false, or null to inherit.",
      );
    }
    return { type: c.type, channel: c.channel, enabled: c.enabled };
  });
}

/** The caller's own notification settings, resolved. */
export async function getNotificationPreferences(
  scope?: WorkspaceScope,
): Promise<NotificationPreferenceView> {
  const store = await getStore();
  return store.getNotificationPreferences(scope);
}

/** Apply the caller's own changes, returning the settings as they now stand. */
export async function updateNotificationPreferences(
  changes: readonly NotificationSettingChange[],
  scope?: WorkspaceScope,
): Promise<NotificationPreferenceView> {
  const store = await getStore();
  return store.updateNotificationPreferences(changes, scope);
}

/** The workspace's defaults, with per-cell override counts. Admins only. */
export async function getNotificationDefaults(
  scope?: WorkspaceScope,
): Promise<NotificationDefaultsView> {
  const store = await getStore();
  return store.getNotificationDefaults(scope);
}

/** Apply changes to the workspace defaults. Admins only. */
export async function updateNotificationDefaults(
  changes: readonly NotificationSettingChange[],
  scope?: WorkspaceScope,
): Promise<NotificationDefaultsView> {
  const store = await getStore();
  return store.updateNotificationDefaults(changes, scope);
}
