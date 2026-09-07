import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_DEFAULTS,
  NOTIFICATION_EVENT_LABELS,
  NOTIFICATION_EVENT_TYPES,
  type NotificationChannel,
  type NotificationEventType,
} from "@/lib/notifications/catalog";

/**
 * Resolving notification settings: the arithmetic behind "inherited".
 *
 * Three layers, each of the upper two only ever a partial. The catalog is
 * complete by construction; a workspace's defaults and a user's preferences
 * are stored as overrides, so most cells at those levels are simply absent and
 * the answer comes from underneath. Reading is therefore a fold rather than a
 * lookup, and it has to happen at read time. Materialising the result into
 * per-user rows would be faster and would silently break the one behaviour
 * these features exist for: an admin changing a default moves everybody who
 * has not overridden that row.
 *
 * Kept pure and free of the database so both grids, the API and the relay
 * agree on what a cell means, and so the interesting cases (a user turning
 * back on something their admin turned off) are testable without one.
 */

/** Which layer decided a cell. */
export type MatrixSource = "catalog" | "workspace" | "user";

/**
 * One stored override row, from either table, narrowed to what resolution
 * needs. `eventType` and `channel` are plain strings because the database
 * columns are: a row naming something the catalog has since dropped is ignored
 * here rather than becoming an error somebody has to go and clean up.
 */
export interface StoredSetting {
  eventType: string;
  channel: string;
  enabled: boolean;
}

export interface MatrixCell {
  enabled: boolean;
  /**
   * Where the value came from. The grids render "inherited" from this, and the
   * two of them draw the line in different places: the user grid treats
   * anything but `user` as inherited, the admin grid anything but `workspace`.
   * A single boolean would have to pick one of those and be wrong on the other
   * screen.
   */
  source: MatrixSource;
}

export interface MatrixRow {
  type: NotificationEventType;
  label: string;
  description: string;
  channels: Record<NotificationChannel, MatrixCell>;
}

/** Index one stored layer for lookup. */
function index(rows: readonly StoredSetting[]): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const r of rows) out.set(`${r.eventType} ${r.channel}`, r.enabled);
  return out;
}

/**
 * Fold the layers over the catalog, most specific last.
 *
 * Driven by the catalog rather than by the stored rows, which is what makes a
 * row naming a retired event type disappear from the answer instead of
 * appearing in a grid nobody can explain.
 */
function fold(
  layers: readonly {
    source: Exclude<MatrixSource, "catalog">;
    rows: readonly StoredSetting[];
  }[],
): MatrixRow[] {
  const indexed = layers.map((l) => ({ source: l.source, rows: index(l.rows) }));
  return NOTIFICATION_EVENT_TYPES.map((type) => {
    const channels = {} as Record<NotificationChannel, MatrixCell>;
    for (const channel of NOTIFICATION_CHANNELS) {
      let cell: MatrixCell = {
        enabled: NOTIFICATION_DEFAULTS[type][channel],
        source: "catalog",
      };
      for (const layer of indexed) {
        const stored = layer.rows.get(`${type} ${channel}`);
        if (stored !== undefined) {
          cell = { enabled: stored, source: layer.source };
        }
      }
      channels[channel] = cell;
    }
    return { type, ...NOTIFICATION_EVENT_LABELS[type], channels };
  });
}

/**
 * A workspace's effective defaults: the catalog with the admin's overrides on
 * top. What the admin grid renders, and what every member's settings inherit
 * from.
 */
export function resolveWorkspaceMatrix(
  workspaceRows: readonly StoredSetting[],
): MatrixRow[] {
  return fold([{ source: "workspace", rows: workspaceRows }]);
}

/**
 * One user's effective settings: catalog, then their workspace's defaults,
 * then their own choices.
 */
export function resolveUserMatrix(
  workspaceRows: readonly StoredSetting[],
  userRows: readonly StoredSetting[],
): MatrixRow[] {
  return fold([
    { source: "workspace", rows: workspaceRows },
    { source: "user", rows: userRows },
  ]);
}

/**
 * The same fold as {@link resolveUserMatrix}, asked for one event type across
 * many users at once, which is the shape the relay needs.
 *
 * Returns a decision for every id passed in, including users who have
 * overridden nothing: at this level "no row" is an answer rather than a miss.
 */
export function resolveChannelsPerUser(
  userIds: readonly string[],
  type: NotificationEventType,
  workspaceRows: readonly StoredSetting[],
  userRows: readonly (StoredSetting & { userId: string })[],
): Map<string, Record<NotificationChannel, boolean>> {
  const workspace = index(workspaceRows);
  const perUser = new Map<string, Map<string, boolean>>();
  for (const r of userRows) {
    let mine = perUser.get(r.userId);
    if (!mine) perUser.set(r.userId, (mine = new Map()));
    mine.set(`${r.eventType} ${r.channel}`, r.enabled);
  }

  return new Map(
    userIds.map((id) => {
      const mine = perUser.get(id);
      const decision = {} as Record<NotificationChannel, boolean>;
      for (const channel of NOTIFICATION_CHANNELS) {
        const key = `${type} ${channel}`;
        decision[channel] =
          mine?.get(key) ??
          workspace.get(key) ??
          NOTIFICATION_DEFAULTS[type][channel];
      }
      return [id, decision] as const;
    }),
  );
}

/**
 * Whether the email channel can actually deliver.
 *
 * The preference grids show the email column either way. Hiding it would make
 * the grid change shape on the day email ships and leave today's reader with
 * no idea the channel is coming; showing it live would let somebody tick a box
 * that produces nothing, which is the failure the global unsubscribe exists to
 * prevent, reached from the other side. So the column renders, reads as its
 * resolved value, and does not accept a click until this is true.
 *
 * Annotated `boolean` rather than left as the literal `false`, so the branches
 * on it stay real code that the compiler checks instead of dead ends it prunes.
 * The email notification channel feature flips it.
 */
export const EMAIL_CHANNEL_LIVE: boolean = false;
