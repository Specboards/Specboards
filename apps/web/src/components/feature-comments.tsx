"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { redirectOnAuthExpiry } from "@/lib/auth-expiry";
import { useResetOnChange } from "@/lib/use-reset-on-change";
import {
  createComment,
  deleteComment,
  listComments,
} from "@/lib/api-client/work-items";
import {
  MentionInput,
  renderCommentBody,
  type MentionCandidate,
} from "@/components/mention-input";
import { openDetailSection } from "@/components/detail-section";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { CommentRecord } from "@/lib/store/types";

/** Compact relative time ("just now", "5m", "3h", "2d"), else a short date. */
function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const secs = Math.round((Date.now() - then) / 1000);
  if (!Number.isFinite(secs)) return "";
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** First letter of a name (or "?") for the avatar circle. */
/**
 * Comments on an item: a list plus an "Add comment" affordance that reveals a
 * composer on opt-in (see the "add" UX rule in CLAUDE.md). Fetches its own list
 * client-side and updates it in place on create/delete. Plain text for now;
 * @mention autocomplete arrives in a later slice.
 */
/**
 * The DOM id a notification's comment deep link points at.
 *
 * Not exported: the other half of the pair is a hash the notification centre
 * builds, and the two are kept in step by the e2e that follows a mention
 * through to the comment rather than by a shared constant nothing else uses.
 */
function commentAnchor(commentId: string): string {
  return `${COMMENT_ANCHOR_PREFIX}${commentId}`;
}

const COMMENT_ANCHOR_PREFIX = "comment-";

export function FeatureComments({
  specId,
  currentUserId,
  members,
}: {
  specId: string;
  /** The acting user's id, so only their own comments show a delete control. */
  currentUserId: string | null;
  /** Workspace members that can be @mentioned (and used to highlight mentions). */
  members: MentionCandidate[];
}) {
  const router = useRouter();
  const [comments, setComments] = useState<CommentRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [body, setBody] = useState("");
  const [mentionedUserIds, setMentionedUserIds] = useState<string[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const memberNames = members.map((m) => m.name);

  // Blanking belongs to the change of item, not to the fetch: the previous
  // item's comments are never shown under the new item.
  useResetOnChange(specId, () => {
    setComments(null);
    setLoadError(null);
  });

  useEffect(() => {
    let active = true;
    listComments(specId)
      .then((rows) => {
        if (active) setComments(rows);
      })
      .catch((err) => {
        if (active) {
          setLoadError(
            err instanceof Error ? err.message : "Could not load comments.",
          );
        }
      });
    return () => {
      active = false;
    };
  }, [specId]);

  /**
   * Land on the comment a notification pointed at.
   *
   * The browser's own hash handling cannot do this: comments are fetched after
   * the page renders, so when the hash fires there is nothing at that id yet.
   * Runs once the rows are in the DOM, and opens the Comments section first in
   * case the reader had collapsed it, since scrolling to something inside a
   * collapsed section scrolls to nothing.
   */
  useEffect(() => {
    if (comments === null || comments.length === 0) return;
    const hash = window.location.hash.slice(1);
    if (!hash.startsWith(COMMENT_ANCHOR_PREFIX)) return;
    const id = hash.slice(COMMENT_ANCHOR_PREFIX.length);
    if (!comments.some((c) => c.id === id)) return;
    openDetailSection("comments");
    // After the section has been told to open, so the target has a box to be
    // scrolled into.
    requestAnimationFrame(() => {
      document
        .getElementById(hash)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [comments]);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const text = body.trim();
    if (!text) return;
    startTransition(async () => {
      setActionError(null);
      try {
        const created = await createComment(specId, {
          body: text,
          mentionedUserIds,
        });
        setComments((prev) => [...(prev ?? []), created]);
        setBody("");
        setMentionedUserIds([]);
        setAdding(false);
      } catch (err) {
        if (redirectOnAuthExpiry(err, router)) return;
        setActionError(
          err instanceof Error ? err.message : "Could not post comment.",
        );
      }
    });
  }

  function onDelete(id: string) {
    startTransition(async () => {
      setActionError(null);
      try {
        await deleteComment(id);
        setComments((prev) => (prev ?? []).filter((c) => c.id !== id));
      } catch (err) {
        if (redirectOnAuthExpiry(err, router)) return;
        setActionError(
          err instanceof Error ? err.message : "Could not delete comment.",
        );
      }
    });
  }

  return (
    <div className="space-y-4">
      {loadError ? (
        <p className="text-xs text-destructive">{loadError}</p>
      ) : comments === null ? (
        <div className="space-y-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-3/4" />
        </div>
      ) : comments.length === 0 ? (
        <p className="text-xs text-muted-foreground">No comments yet.</p>
      ) : (
        <ul className="space-y-4">
          {comments.map((c) => (
            // Anchored so a notification about this comment can land on it.
            // The scroll itself is not the browser's: comments load after the
            // page, so the hash has nothing to find when it fires.
            <li id={commentAnchor(c.id)} key={c.id} className="flex gap-3">
              {/* Decorative: the author's name is spelled out beside it. */}
              <Avatar name={c.authorName} aria-hidden />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">
                    {c.authorName ?? "Unknown"}
                  </span>
                  <span
                    className="text-xs text-muted-foreground"
                    title={new Date(c.createdAt).toLocaleString()}
                  >
                    {timeAgo(c.createdAt)}
                  </span>
                  {currentUserId && c.authorId === currentUserId ? (
                    <button
                      type="button"
                      onClick={() => onDelete(c.id)}
                      disabled={pending}
                      aria-label="Delete comment"
                      className="ml-auto text-muted-foreground hover:text-destructive disabled:opacity-50"
                    >
                      ×
                    </button>
                  ) : null}
                </div>
                <p className="whitespace-pre-wrap break-words text-sm">
                  {renderCommentBody(c.body, memberNames)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Start as an "Add comment" affordance; reveal the composer on opt-in. */}
      {adding ? (
        <form onSubmit={onSubmit} className="space-y-2">
          <MentionInput
            members={members}
            value={body}
            onChange={(next, ids) => {
              setBody(next);
              setMentionedUserIds(ids);
            }}
            placeholder="Write a comment… use @ to mention"
            rows={3}
            autoFocus
            disabled={pending}
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={pending || !body.trim()}>
              {pending ? "Saving…" : "Comment"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setAdding(false);
                setBody("");
                setMentionedUserIds([]);
                setActionError(null);
              }}
              disabled={pending}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setAdding(true)}
        >
          Add comment
        </Button>
      )}

      {actionError ? (
        <p className="text-xs text-destructive">{actionError}</p>
      ) : null}
    </div>
  );
}
