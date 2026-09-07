"use client";

import { ChevronDown } from "lucide-react";
import ReactMarkdown from "react-markdown";
import type { ReactNode } from "react";

import { SpecPendingChange } from "@/components/spec-pending-change";
import type { GithubLink } from "@/lib/store/types";
import { useCollapsedSection } from "@/lib/use-collapsed-section";
import { cn } from "@/lib/utils";

/**
 * The Description block on an item, with a long body foldable out of the way.
 *
 * A well-written spec is long, and everything below it (Assistant,
 * Relationships, children, GitHub links, comments) was pushed off the screen by
 * it. Reaching an item's children meant scrolling past a document you had
 * already read, so the cost of writing a thorough description was paid on every
 * visit afterwards.
 *
 * ── Three decisions worth keeping ───────────────────────────────────────────
 *
 * **The control appears only when it would do something.** A short body renders
 * exactly as it did before, with no chevron. An affordance that collapses two
 * lines into two lines is noise on every card that has a sentence in it.
 *
 * **A long body still opens expanded the first time.** Collapsing by default
 * would hide content nobody asked to hide, and the first visit to a long spec
 * is precisely the visit that came to read it. Only an explicit collapse is
 * remembered, and it is remembered per item: a long spec you have read stays
 * folded while the one you are working on does not.
 *
 * **Unsaved work is never folded away.** Both bodies are editors (one
 * autosaves to the database, one commits to git), and collapsing unmounts
 * whatever is inside. A fold that hid a dirty editor, or dropped a pending
 * edit, would be worse than the scrolling this exists to fix, so the control is
 * disabled while there is anything unsaved and says why.
 *
 * The pending-change banner sits above the fold and stays visible either way.
 * It explains why the text underneath may not be somebody's latest change, and
 * collapsing the explanation while leaving the confusion is the wrong half.
 */

const STORAGE_KEY = "specboard:item-detail:description";

/**
 * Whether a body is long enough to be worth folding.
 *
 * Deliberately generous. The failure this guards against is a chevron on an
 * item whose description is a paragraph, which is a permanent small annoyance
 * on the common card; the opposite failure is one long-ish spec that has to be
 * scrolled, which is what the page does today anyway.
 */
export function isFoldableBody(body: string): boolean {
  const text = body.trim();
  if (text === "") return false;
  return text.length > 700 || text.split("\n").length > 14;
}

export function DescriptionBlock({
  itemId,
  body,
  links,
  dirty = false,
  children,
}: {
  /** Stable per-item storage id, so the choice is remembered per item. */
  itemId: string;
  /** The body as text, for the preview and the length threshold. */
  body: string;
  /** GitHub links, for the pending-change banner above the fold. */
  links: GithubLink[];
  /** True while the body underneath holds unsaved changes. */
  dirty?: boolean;
  /** The editor, or the read-only render, for the expanded state. */
  children: ReactNode;
}) {
  const foldable = isFoldableBody(body);
  const [collapsed, setCollapsed] = useCollapsedSection(
    STORAGE_KEY,
    itemId,
    false,
  );
  // `dirty` wins over the stored choice. It can only be true while the editor
  // is mounted, so this is a belt on top of disabling the control, not the
  // mechanism; it is here so that no future path can fold over an edit.
  const folded = foldable && collapsed && !dirty;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-muted-foreground">
          Description
        </h2>
        {foldable ? (
          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            disabled={dirty}
            aria-expanded={!folded}
            title={
              dirty
                ? "Finish or save your changes before collapsing the description."
                : undefined
            }
            className={cn(
              "flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground",
              "hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50",
            )}
          >
            {folded ? "Show more" : "Show less"}
            <ChevronDown
              aria-hidden
              className={cn(
                "h-3.5 w-3.5 transition-transform",
                folded ? "-rotate-90" : "",
              )}
            />
          </button>
        ) : null}
      </div>
      {/* Above the body on purpose: it explains why the text underneath is not
          the change someone just made, so reading it afterwards is too late to
          stop them concluding the editor lost their work. Which is also why it
          is outside the fold. */}
      <SpecPendingChange links={links} />
      {folded ? (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="relative block max-h-32 w-full cursor-pointer overflow-hidden text-left"
        >
          {/* Headings flattened to body size for the preview only. A spec
              usually opens with an H1 repeating the item's own title, and at
              full scale that heading plus one sentence is the entire preview:
              two lines, one of which the reader has already read on the line
              above. Flattened, the same space shows what the document is
              actually about. */}
          <div
            className={cn(
              "prose prose-sm prose-neutral max-w-none dark:prose-invert",
              "[&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-sm",
              "[&_h1]:mt-0 [&_h2]:mt-0 [&_h3]:mt-0 [&_h1]:mb-1 [&_h2]:mb-1 [&_h3]:mb-1",
            )}
          >
            <ReactMarkdown>{body}</ReactMarkdown>
          </div>
          <span className="pointer-events-none absolute inset-x-0 bottom-0 block h-16 bg-gradient-to-b from-transparent to-background" />
        </button>
      ) : (
        children
      )}
    </div>
  );
}
