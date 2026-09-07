import type { Database } from "@specboards/db";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Who has explicitly asked to hear about an item.
 *
 * A seam, not a stub with a shrug: the fan-out's recipient resolution is built
 * around watchers being one of the sets it unions, and the watch feature fills
 * this in without the fan-out changing shape. Until then every item has no
 * watchers, so recipients are the people the data already names (the assignee,
 * the people a comment mentions).
 *
 * Keyed by the internal `features.id` rather than the public `specId`, because
 * that is what the notification rows and the watch table both key on.
 */
export async function watchersFor(
  _tx: Tx,
  _workspaceId: string,
  featureIds: readonly string[],
): Promise<Map<string, string[]>> {
  return new Map(featureIds.map((id) => [id, []]));
}
