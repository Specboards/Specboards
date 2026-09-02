"use client";

import { useEffect, useState } from "react";

import { AuthRequiredError } from "@/lib/api-client/request";
import { listItemEvents } from "@/lib/api-client/work-items";
import { historyEntries, type HistoryContext } from "@/lib/item-history";
import { Skeleton } from "@/components/ui/skeleton";

/** Absolute date and time; history is read to establish when, so no "5m ago". */
function when(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/**
 * An item's change history: who changed what, and when.
 *
 * Fetches on mount rather than arriving with the item, because it sits in a
 * collapsed section and most people opening an item never ask this question.
 *
 * Scope worth being clear about: this is the history of what **Specboards**
 * stores, which is metadata. A spec-backed item's document history lives in
 * git, and changes reconciled from git do not appear here yet, because sync
 * writes the row directly rather than through the store that records history.
 * The empty state says so instead of implying nothing ever happened.
 */
export function ItemHistory({
  specId,
  context,
  isSpecBacked,
}: {
  specId: string;
  context: HistoryContext;
  /** Spec-backed items carry document history in git, which this does not show. */
  isSpecBacked: boolean;
}) {
  const [entries, setEntries] = useState<ReturnType<
    typeof historyEntries
  > | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setEntries(null);
    setError(null);
    listItemEvents(specId)
      .then((events) => {
        if (active) setEntries(historyEntries(events, context));
      })
      .catch((err) => {
        if (!active) return;
        if (err instanceof AuthRequiredError) {
          setError("Sign in to see this item's history.");
          return;
        }
        setError(
          err instanceof Error ? err.message : "Could not load history.",
        );
      });
    return () => {
      active = false;
    };
    // `context` is rebuilt on every render of the parent, so depending on it
    // would refetch continuously. The item is what decides the history.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specId]);

  if (error) return <p className="text-xs text-destructive">{error}</p>;
  if (entries === null) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No changes recorded yet.{" "}
        {isSpecBacked
          ? "This covers the item's properties; the spec document's own history is in git."
          : "Changes made from now on will be listed here."}
      </p>
    );
  }

  return (
    <ul className="space-y-2">
      {entries.map((e) => (
        <li key={e.id} className="flex flex-col gap-0.5 text-sm">
          <span>
            <span
              className={
                // An automation is named plainly rather than highlighted like a
                // person: the distinction matters for reading the record, but
                // it is not a warning.
                e.automated ? "text-muted-foreground" : "font-medium"
              }
            >
              {e.actor}
            </span>{" "}
            {e.action}
          </span>
          <span className="text-2xs text-muted-foreground">
            {when(e.createdAt)}
          </span>
        </li>
      ))}
    </ul>
  );
}
