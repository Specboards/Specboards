import { ExternalLink } from "lucide-react";

import { pendingSpecChanges } from "@/lib/pending-changes";
import type { GithubLink } from "@/lib/store/types";

/**
 * Tells a reader that the spec below is not the whole story: someone has
 * proposed a change to it that has not been approved yet.
 *
 * This exists because in PR mode a save leaves the board showing the old text.
 * Without this the editor reads as broken - you save, the page reloads, and
 * your writing is not there. The state used to live only in the editor's own
 * React state, so it survived exactly as long as the tab did.
 *
 * The copy deliberately says "a change" and never "your change". This renders
 * from stored state for whoever is looking, and the viewer is often not the
 * author: a second person arriving at the spec is precisely who most needs to
 * know that an edit is already in flight before they start writing a competing
 * one. Naming the author is a later feature (commit attribution); claiming it
 * is yours before we know that would be a lie a fraction of the time.
 */
export function SpecPendingChange({ links }: { links: GithubLink[] }) {
  const pending = pendingSpecChanges(links);
  if (pending.length === 0) return null;

  return (
    <div className="space-y-2 rounded-md border bg-muted/40 p-3">
      <p className="text-sm font-medium">
        {pending.length === 1
          ? "A change to this spec is waiting for review"
          : `${pending.length} changes to this spec are waiting for review`}
      </p>
      {/* Says plainly why the text below is not what was just written, which is
          the question this panel exists to answer. No branch names, no shas. */}
      <p className="text-xs text-muted-foreground">
        {pending.length === 1
          ? "The spec below is the version that is live. The proposed change replaces it once someone approves it."
          : "The spec below is the version that is live. Each proposed change replaces it once someone approves it."}
      </p>
      <ul className="space-y-1">
        {pending.map((l) => (
          <li key={l.id}>
            {/* The escape hatch stays for people who want it. Someone told to
                wait with no way to find out what for has been told nothing. */}
            <a
              href={l.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-medium underline underline-offset-2"
            >
              Open review #{l.number}
              <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
