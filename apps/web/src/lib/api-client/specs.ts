"use client";

import { apiFetch } from "@/lib/api-client/request";

/** The result of committing a spec body: where it landed and in which commit. */
export interface SpecWriteResult {
  specId: string;
  path: string;
  commitSha: string;
  /** Sha of what was written; guards the next save from the same editor. */
  blobSha: string;
  /** How many other people's changes this save merged with (usually 0). */
  mergedWith?: number;
  /**
   * The body as written, present only when a merge changed it. An editor must
   * adopt this: keeping the author's own text after a merge means holding a
   * document that has lost somebody else's paragraph, and the next save would
   * write that loss to git without tripping any guard.
   */
  mergedBody?: string;
  /**
   * Present when the repo takes spec changes as pull requests. The change is
   * then *proposed*, not live: the board still shows the previous text until
   * someone reviews and merges it.
   */
  pullRequest?: {
    number: number;
    url: string;
    branch: string;
    /** False when the change joined a review that was already open. */
    created: boolean;
  };
}

/**
 * Replace a spec's Markdown body and commit it to the connected repo. `content`
 * is the Markdown after the frontmatter; the frontmatter (and so the stable
 * `id`) is preserved by the write.
 *
 * The server's error messages are written for a human to read, so they are
 * surfaced as-is rather than replaced with a generic failure.
 */
export async function updateSpecBody(
  specId: string,
  content: string,
  opts: { message?: string; expectedBlobSha?: string | null } = {},
): Promise<SpecWriteResult> {
  const res = await apiFetch(
    `/api/v1/features/${encodeURIComponent(specId)}/content`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content,
        ...(opts.message ? { message: opts.message } : {}),
        ...(opts.expectedBlobSha
          ? { expectedBlobSha: opts.expectedBlobSha }
          : {}),
      }),
    },
  );
  const body = (await res.json().catch(() => null)) as {
    spec?: SpecWriteResult;
    conflict?: SpecConflict;
    error?: string;
  } | null;
  // A conflict is thrown as its own type rather than folded into the generic
  // failure: it is the one error the caller can do something about, and doing
  // something about it needs the version that won, not just a message.
  if (res.status === 409 && body?.conflict) {
    throw new SpecConflictError(body.error ?? "", body.conflict);
  }
  if (!res.ok || !body?.spec) {
    throw new Error(body?.error ?? `Saving the spec failed (${res.status}).`);
  }
  return body.spec;
}

/** The version of a spec that beat a guarded save, as the server reports it. */
export interface SpecConflict {
  path: string;
  /** The body now in git, frontmatter stripped, ready to show or adopt. */
  currentContent: string;
  /** Send this back as `expectedBlobSha` to overwrite it deliberately. */
  currentBlobSha: string;
  /**
   * Headings both sides rewrote. Empty when the overlap could not be pinned
   * down. The empty string means the text above the first heading.
   */
  sections?: string[];
}

/** A save was refused because the spec moved in git since the editor loaded it. */
export class SpecConflictError extends Error {
  constructor(
    message: string,
    readonly conflict: SpecConflict,
  ) {
    super(
      message ||
        "Someone else changed this spec while you were writing. Your version " +
          "has not been saved yet.",
    );
    this.name = "SpecConflictError";
  }
}

/**
 * An accept was refused because the body moved after the proposal was drafted.
 *
 * The counterpart to {@link SpecConflictError} for the two subjects with no blob
 * sha: a DB-native card's description and a release's notes. Separate rather
 * than folded into that type because the outcomes differ. A spec can be merged
 * with, so its conflict carries a sha to save against deliberately; these can
 * only be refused, so all there is to hand back is the text that won.
 */
export class ProposalStaleError extends Error {
  constructor(
    message: string,
    /** The body as it stands now, so the diff can be redrawn against it. */
    readonly currentBody: string,
  ) {
    super(
      message ||
        "This changed after the assistant drafted its suggestion, so accepting " +
          "would replace the newer version.",
    );
    this.name = "ProposalStaleError";
  }
}

/** What a create returned: the spec, plus anything that partly went wrong. */
interface SpecCreateResult {
  spec: SpecWriteResult;
  /**
   * Set when the spec was committed but nesting it under the requested parent
   * failed. The spec exists either way, so this is a warning to show, not an
   * error to retry: creating it again would only make a second file.
   */
  parentWarning?: string;
}

/**
 * Create a new spec file, commit it, and sync it onto the board.
 *
 * With `workItemId` the spec attaches to an existing leaf item, which keeps
 * that item's id, status, assignee, parent and history. With `parentSpecId` a
 * new item is created for the spec and nested under that card. The two are
 * mutually exclusive: attaching never moves the item it attaches to.
 *
 * The server's error messages are written for a human to read (including the
 * "pick a different title" one raised by a slug collision), so they are
 * surfaced as-is rather than replaced with a generic failure.
 */
export async function createSpec(input: {
  title: string;
  body?: string;
  workItemId?: string;
  parentSpecId?: string;
  /** Detail template to start from; only used when the spec would be blank. */
  templateId?: string;
  repoId?: string;
  message?: string;
}): Promise<SpecCreateResult> {
  const res = await apiFetch("/api/v1/specs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => null)) as {
    spec?: SpecWriteResult;
    parentWarning?: string;
    error?: string;
  } | null;
  if (!res.ok || !body?.spec) {
    throw new Error(body?.error ?? `Creating the spec failed (${res.status}).`);
  }
  return { spec: body.spec, parentWarning: body.parentWarning };
}
