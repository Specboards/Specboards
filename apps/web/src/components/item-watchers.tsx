"use client";

import { Bell, BellOff } from "lucide-react";
import { useState, useTransition } from "react";

import { setWatch } from "@/lib/api-client/work-items";
import type { ItemWatchState } from "@/lib/store/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

/**
 * Watch or unwatch an item, and see who else is listening.
 *
 * Recipient resolution can only reach the people the data already names: the
 * assignee, the comment author, the person mentioned. This is how somebody who
 * cares about work they do not own gets told about it, and, just as much, how
 * somebody stuck on a thread they no longer care about leaves.
 *
 * ── Why the button explains itself ──────────────────────────────────────────
 * Being assigned an item follows it without anybody choosing to, so a reader
 * can arrive at a control that says "Watching" about a decision they never
 * made. The line under it says which it is. Getting this wrong is not cosmetic:
 * a state you did not set and cannot account for reads as the product doing
 * something behind your back, and the first instinct is to distrust the rest of
 * the settings.
 *
 * Unwatching here does not unassign anybody. That is the whole point of the
 * feature: it is the only per-item lever there is, because the preference grid
 * is per event type on purpose and cannot say "this one item is too noisy".
 */
export function ItemWatchers({
  specId,
  initial,
  /** Whether the item has anything under it. Cascade is meaningless on a leaf. */
  hasChildren,
}: {
  specId: string;
  initial: ItemWatchState;
  hasChildren: boolean;
}) {
  const [state, setState] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function save(next: { watching: boolean; includeDescendants?: boolean }) {
    setError(null);
    startTransition(async () => {
      try {
        setState(await setWatch(specId, next));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not save.");
      }
    });
  }

  const { watchers, watching, explicit, includeDescendants } = state;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant={watching ? "secondary" : "outline"}
          size="sm"
          disabled={pending}
          aria-pressed={watching}
          onClick={() =>
            save({ watching: !watching, includeDescendants })
          }
        >
          {watching ? (
            <BellOff aria-hidden className="h-4 w-4" />
          ) : (
            <Bell aria-hidden className="h-4 w-4" />
          )}
          {watching ? "Unwatch" : "Watch"}
        </Button>

        {/* Named, not just counted, and named in the open rather than behind a
            hover. A count tells an author somebody is listening; the names tell
            them whether it is the person whose answer they are waiting on, and
            that question is worth as much on a phone as on a desk. */}
        {watchers.length > 0 ? (
          <span className="text-xs text-muted-foreground">
            {watchers.length === 1 ? "1 watcher" : `${watchers.length} watchers`}
            {": "}
            {watcherNames(watchers)}
          </span>
        ) : null}
      </div>

      {/* Says which state this is, always. See the note above. */}
      <p className="text-xs text-muted-foreground">
        {watching
          ? explicit
            ? "You are watching this item."
            : "You follow this because it is assigned to you. Unwatching stops the notifications and leaves it assigned."
          : explicit
            ? "You are not watching this item."
            : "You are not watching this item yet."}
      </p>

      {hasChildren && watching ? (
        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            className="sr-only"
            checked={includeDescendants}
            disabled={pending}
            onChange={(e) =>
              save({ watching: true, includeDescendants: e.target.checked })
            }
          />
          <Checkbox checked={includeDescendants} />
          {/* Offered rather than assumed. Watching an initiative that cascades
              would put every status change beneath it in one inbox, which is
              the flood this release exists to stop; not offering it at all
              would drop the main reason to watch a parent. */}
          Also tell me about everything under this item
        </label>
      ) : null}

      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** How many names to print before the list becomes a count again. */
const NAMES_SHOWN = 4;

function watcherNames(watchers: ItemWatchState["watchers"]): string {
  const names = watchers.map((w) => w.name ?? "Unknown member");
  if (names.length <= NAMES_SHOWN) return names.join(", ");
  const rest = names.length - NAMES_SHOWN;
  return `${names.slice(0, NAMES_SHOWN).join(", ")} and ${rest} more`;
}
