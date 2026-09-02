import { notifyOutbox } from "@/lib/webhooks/events";
import { getStore, type WorkspaceScope } from "@/lib/store";
import type { CommentInput, CommentRecord } from "@/lib/store/types";
import { InvalidPatchError } from "@/lib/service-errors";

/** Comments on an item. */

/** Validate and normalize a create-comment request body. */
export function parseCommentInput(body: unknown): CommentInput {
  if (typeof body !== "object" || body === null) {
    throw new InvalidPatchError("Request body must be a JSON object.");
  }
  const b = body as Record<string, unknown>;
  if (typeof b.body !== "string" || !b.body.trim()) {
    throw new InvalidPatchError("A non-empty comment body is required.");
  }
  const input: CommentInput = { body: b.body };
  if (b.mentionedUserIds !== undefined) {
    if (
      !Array.isArray(b.mentionedUserIds) ||
      b.mentionedUserIds.some((id) => typeof id !== "string")
    ) {
      throw new InvalidPatchError(
        "mentionedUserIds must be an array of user ids.",
      );
    }
    input.mentionedUserIds = b.mentionedUserIds as string[];
  }
  return input;
}

/** Comments on a feature (by stable specId), oldest first. */
export async function listComments(
  specId: string,
  scope?: WorkspaceScope,
): Promise<CommentRecord[]> {
  const store = await getStore();
  return store.listComments(specId, scope);
}

/** Add a comment to a feature (by stable specId), authored by the caller. */
export async function createComment(
  specId: string,
  input: CommentInput,
  scope?: WorkspaceScope,
): Promise<CommentRecord> {
  const store = await getStore();
  const comment = await store.createComment(specId, input, scope);
  // A comment with mentions writes a `comment.mentioned` outbox event; nudge the
  // relay so any delivery channels fire promptly (no-op when nothing was queued).
  if (input.mentionedUserIds && input.mentionedUserIds.length > 0) notifyOutbox();
  return comment;
}

/** Delete a comment; author or workspace owner only. */
export async function deleteComment(
  commentId: string,
  scope?: WorkspaceScope,
): Promise<void> {
  const store = await getStore();
  await store.deleteComment(commentId, scope);
}
