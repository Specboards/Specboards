"use client";

import type { ContextField as AssistantContextField } from "@/lib/ai/item-context";
import type { Skill, SkillRow } from "@/lib/ai/skills";
import type { AssistantMessageView } from "@/lib/assistant-service";
import type { ItemDetailData } from "@/lib/item-detail";
import type { ReleaseItemGroup } from "@/lib/release-items";
import type {
  BoardKey,
  BoardPreferences,
  CommentInput,
  CommentRecord,
  ItemEvent,
  NotificationList,
  CreatableRelationDirection,
  CreateFeatureInput,
  CreateProductGroupInput,
  CreateProductInput,
  DetailTemplate,
  DetailTemplateInput,
  DetailTemplatePatch,
  DocArea,
  DocPageInput,
  DocPagePatch,
  DocPageRecord,
  DocSpace,
  FeatureDetail,
  FeaturePatch,
  FeatureRecord,
  FeatureRelation,
  GithubLink,
  GithubLinkInput,
  IdeaInput,
  IdeaPatch,
  IdeaRecord,
  IdeaSettings,
  IdeaSettingsPatch,
  IdeaStage,
  InvitationProductGrant,
  LevelUpdate,
  OrgInvitationRecord,
  OrgMemberRecord,
  OrgRole,
  ProductGroupPatch,
  CycleGenerateInput,
  CycleInput,
  GoalContribution,
  GoalInput,
  GoalPatch,
  GoalRecord,
  KeyResultInput,
  KeyResultPatch,
  CyclePatch,
  CycleRecord,
  ProductGroupRecord,
  ProductMemberInput,
  ProductMemberRecord,
  ProductPatch,
  ProductRecord,
  PropertyDef,
  PropertyInput,
  PropertyPatch,
  ReleaseInput,
  ReleasePatch,
  ReleaseRecord,
  SavedView,
  SavedViewInput,
  StageGate,
  StageGateInput,
  StatusStageInput,
  TransitionMode,
  WorkspaceLevel,
  WorkspaceStatus,
} from "@/lib/store/types";

/**
 * Browser-side client for the public API layer. All mutations from the UI go
 * through /api/v1 — the same surface external integrations use — so the
 * browser never talks to anything but the versioned API.
 */

/**
 * The active org slug, read from the `/[org]/…` route. Every UI page renders
 * under an org segment, so the first path segment is the workspace the user is
 * looking at. We forward it to the API as `x-org-slug` so the server scopes the
 * request to THIS org instead of guessing from the caller's memberships (the
 * multi-org tenant-confusion fix). The server validates it against a real
 * membership, so it's only ever a hint.
 */
function activeOrgSlug(): string | null {
  if (typeof window === "undefined") return null;
  const slug = window.location.pathname.split("/")[1];
  return slug ? decodeURIComponent(slug) : null;
}

/**
 * `fetch` for the versioned API that tags each request with the active org.
 * All calls in this module go through here so none can forget the header.
 */
function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const slug = activeOrgSlug();
  const headers = new Headers(init.headers);
  if (slug) headers.set("x-org-slug", slug);
  return fetch(input, { ...init, headers });
}

/** Thrown when a write is rejected for lack of a session (HTTP 401). */
export class AuthRequiredError extends Error {
  constructor() {
    super("Authentication required.");
    this.name = "AuthRequiredError";
  }
}

/**
 * Thrown when org creation is rejected because the chosen slug is taken or
 * reserved. Carries the server's `code` and a free `suggestion` so the setup
 * form can warn and offer an alternative slug.
 */
export class WorkspaceSlugTakenError extends Error {
  constructor(
    message: string,
    readonly code: "slug_taken" | "slug_invalid",
    readonly suggestion?: string,
  ) {
    super(message);
    this.name = "WorkspaceSlugTakenError";
  }
}

/**
 * Load the full item-detail bundle (metadata + properties + hierarchy +
 * candidates + edit rights) the flyout renders. Mirrors what the full item page
 * assembles server-side, so both views show the same content.
 */
export async function getItemDetail(specId: string): Promise<ItemDetailData> {
  const res = await apiFetch(
    `/api/v1/features/${encodeURIComponent(specId)}/context`,
  );
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    data?: ItemDetailData;
    error?: string;
  } | null;
  if (!res.ok || !body?.data) {
    throw new Error(body?.error ?? `Failed to load item (${res.status}).`);
  }
  return body.data;
}

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
  if (res.status === 401) throw new AuthRequiredError();
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

/** What a create returned: the spec, plus anything that partly went wrong. */
export interface SpecCreateResult {
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
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    spec?: SpecWriteResult;
    parentWarning?: string;
    error?: string;
  } | null;
  if (!res.ok || !body?.spec) {
    throw new Error(
      body?.error ?? `Creating the spec failed (${res.status}).`,
    );
  }
  return { spec: body.spec, parentWarning: body.parentWarning };
}

/** Load a feature's full detail (metadata + spec content) for in-context edit. */
export async function getFeature(specId: string): Promise<FeatureDetail> {
  const res = await apiFetch(`/api/v1/features/${encodeURIComponent(specId)}`);
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    feature?: FeatureDetail;
    error?: string;
  } | null;
  if (!res.ok || !body?.feature) {
    throw new Error(body?.error ?? `Failed to load feature (${res.status}).`);
  }
  return body.feature;
}

export async function patchFeature(
  specId: string,
  patch: FeaturePatch,
): Promise<void> {
  const res = await apiFetch(`/api/v1/features/${encodeURIComponent(specId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `PATCH failed with ${res.status}`);
  }
}

/** One item's outcome in a bulk edit (mirrors the server's BulkPatchItemResult). */
export interface BulkPatchItemResult {
  specId: string;
  ok: boolean;
  error?: string;
}

export interface BulkPatchResult {
  results: BulkPatchItemResult[];
  okCount: number;
  failCount: number;
}

/** Tag mutations for a bulk edit (merged per item, not a wholesale replace). */
export interface BulkTagOps {
  addTags?: string[];
  clearTags?: boolean;
}

/**
 * Apply one change to many items via `PATCH /api/v1/features/bulk`. The direct
 * patch accepts status / assigneeId / releaseId; tags are added or cleared via
 * `tagOps` so a mixed selection isn't overwritten. Resolves with the per-item
 * result (some may have failed); rejects only on auth or a request the server
 * rejected outright.
 */
export async function bulkPatchFeatures(
  specIds: string[],
  patch: Pick<FeaturePatch, "status" | "assigneeId" | "releaseId">,
  tagOps: BulkTagOps = {},
): Promise<BulkPatchResult> {
  const res = await apiFetch(`/api/v1/features/bulk`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ specIds, patch, ...tagOps }),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as
    | (BulkPatchResult & { error?: string })
    | null;
  if (!res.ok || !body || !Array.isArray(body.results)) {
    throw new Error(body?.error ?? `Bulk edit failed with ${res.status}`);
  }
  return body;
}

/** List a feature's comments (oldest first). */
export async function listComments(specId: string): Promise<CommentRecord[]> {
  const res = await apiFetch(
    `/api/v1/features/${encodeURIComponent(specId)}/comments`,
  );
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    comments?: CommentRecord[];
    error?: string;
  } | null;
  if (!res.ok || !body?.comments) {
    throw new Error(body?.error ?? `Failed to load comments (${res.status}).`);
  }
  return body.comments;
}

/** An item's change history, newest first. */
export async function listItemEvents(specId: string): Promise<ItemEvent[]> {
  const res = await apiFetch(
    `/api/v1/features/${encodeURIComponent(specId)}/events`,
  );
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    events?: ItemEvent[];
    error?: string;
  } | null;
  if (!res.ok || !body?.events) {
    throw new Error(body?.error ?? `Failed to load history (${res.status}).`);
  }
  return body.events;
}

/**
 * The assistant thread for an item, plus the context that would be sent about
 * it. Both come from one response so the panel cannot show a disclosure that
 * describes a different request from the one it makes.
 */
export async function getAssistantThread(specId: string): Promise<{
  messages: AssistantMessageView[];
  context: AssistantContextField[];
  modelConnected: boolean;
  canEdit: boolean;
  canPropose: boolean;
  body: string;
  skills: Skill[];
  activeSkillKey: string | null;
}> {
  const res = await apiFetch(
    `/api/v1/assistant/${encodeURIComponent(specId)}`,
  );
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    messages?: AssistantMessageView[];
    context?: AssistantContextField[];
    modelConnected?: boolean;
    canEdit?: boolean;
    canPropose?: boolean;
    body?: string;
    skills?: Skill[];
    activeSkillKey?: string | null;
    error?: string;
  } | null;
  if (!res.ok || !body?.messages || !body?.context) {
    throw new Error(
      body?.error ?? `Failed to load the assistant (${res.status}).`,
    );
  }
  return {
    messages: body.messages,
    context: body.context,
    modelConnected: Boolean(body.modelConnected),
    canEdit: Boolean(body.canEdit),
    canPropose: Boolean(body.canPropose),
    body: body.body ?? "",
    skills: body.skills ?? [],
    activeSkillKey: body.activeSkillKey ?? null,
  };
}

/**
 * The workspace's assistant skills, built-ins included.
 *
 * Its own resource rather than a path under `assistant`, so that an API key
 * granted permission to ask questions is not thereby granted permission to
 * rewrite what the assistant is told. See the route.
 */
export async function getAssistantSkills(): Promise<Skill[]> {
  const res = await apiFetch("/api/v1/assistant-skills");
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    skills?: Skill[];
    error?: string;
  } | null;
  if (!res.ok || !body?.skills) {
    throw new Error(body?.error ?? `Failed to load skills (${res.status}).`);
  }
  return body.skills;
}

/**
 * Replace the workspace's skills with this set. Admin-only; 422 on a skill that
 * would do nothing (no name, no instructions) or a set that is too large.
 */
export async function saveAssistantSkills(skills: SkillRow[]): Promise<Skill[]> {
  const res = await apiFetch("/api/v1/assistant-skills", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ skills }),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    skills?: Skill[];
    error?: string;
  } | null;
  if (!res.ok || !body?.skills) {
    throw new Error(body?.error ?? `Could not save the skills (${res.status}).`);
  }
  return body.skills;
}

/** One child the assistant suggested, before anybody has agreed to it. */
export interface ProposedChild {
  title: string;
  details: string;
}

export type BreakdownSuggestion =
  | {
      ok: true;
      prose: string;
      children: ProposedChild[];
      childLevelKey: string;
      childLevelLabel: string;
    }
  | { ok: false; error: { kind: string; message: string } };

/**
 * Ask the assistant to propose the level below an item. Creates nothing: the
 * caller creates whatever the reviewer ticks, through the ordinary
 * {@link createWorkItem}.
 *
 * A failure at the customer's own model endpoint comes back as a value rather
 * than a thrown error, the same as {@link askAssistant}, because it is a state
 * to render rather than a bug to report.
 */
export async function suggestBreakdown(
  specId: string,
): Promise<BreakdownSuggestion> {
  const res = await apiFetch(
    `/api/v1/assistant/${encodeURIComponent(specId)}/breakdown`,
    { method: "POST" },
  );
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as
    | (BreakdownSuggestion & { error?: string | { kind: string; message: string } })
    | null;
  // Our own refusals (unknown item, no level below, no permission) arrive as an
  // ordinary status with a plain string message.
  if (!res.ok) {
    const message =
      typeof body?.error === "string"
        ? body.error
        : `The assistant failed (${res.status}).`;
    throw new Error(message);
  }
  if (!body) throw new Error("The assistant returned nothing.");
  return body;
}

/** What came back from accepting or rejecting a proposed edit. */
export interface ProposalOutcome {
  message: AssistantMessageView;
  /** The item's description afterwards, so the diff baseline moves with it. */
  body: string;
  commitSha?: string;
  pullRequest?: { number: number; url: string; created: boolean };
  mergedWith?: number;
}

/**
 * Accept or reject an edit the assistant proposed.
 *
 * `body` is "edit before accepting": the reviewer's own text, which replaces
 * what was drafted. Omitting it accepts the draft as written.
 *
 * A conflict comes back as {@link SpecConflictError}, the same type a hand-made
 * save raises, because it is the same situation and the caller needs the same
 * thing: the version that won, not just the news that it did.
 */
export async function resolveProposal(
  specId: string,
  messageId: string,
  action: "accept" | "reject",
  opts: { body?: string } = {},
): Promise<ProposalOutcome> {
  const res = await apiFetch(
    `/api/v1/features/${encodeURIComponent(specId)}/proposals`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messageId,
        action,
        ...(opts.body !== undefined ? { body: opts.body } : {}),
      }),
    },
  );
  if (res.status === 401) throw new AuthRequiredError();
  const payload = (await res.json().catch(() => null)) as
    | (ProposalOutcome & { conflict?: SpecConflict; error?: string })
    | null;
  if (res.status === 409 && payload?.conflict) {
    throw new SpecConflictError(payload.error ?? "", payload.conflict);
  }
  if (!res.ok || !payload?.message) {
    throw new Error(payload?.error ?? `That did not go through (${res.status}).`);
  }
  return payload;
}

/** One line of the assistant's NDJSON stream, as the browser sees it. */
export type AssistantStreamEvent =
  | { kind: "delta"; text: string }
  | { kind: "done"; turns: AssistantMessageView[] }
  | { kind: "error"; error: { kind: string; message: string } };

/**
 * Ask the assistant about an item, rendering the answer as it arrives.
 *
 * `onDelta` is called with each fragment. The resolved value is the outcome:
 * the persisted pair on success, an error to render on failure, or `cancelled`
 * when the caller aborted, which is not a failure and should not be reported
 * as one.
 *
 * A failure at the customer's own model endpoint comes back as a value rather
 * than a thrown error: it is not a bug to report but a state the panel renders,
 * and `kind` is what decides whether the right thing to say is "connect a
 * model", "check your key", or "that endpoint did not answer".
 */
export async function askAssistant(
  specId: string,
  message: string,
  opts: {
    onDelta?: (text: string) => void;
    signal?: AbortSignal;
    /**
     * The skill in force. Sent on every turn, not only the one that launched
     * it: the browser owns what is running, and a grilling that stopped the
     * moment its first question was answered would not be a grilling.
     */
    skillKey?: string | null;
  } = {},
): Promise<
  | { ok: true; turns: AssistantMessageView[] }
  | { ok: false; error: { kind: string; message: string } }
  | { ok: false; cancelled: true }
> {
  let res: Response;
  try {
    res = await apiFetch(`/api/v1/assistant/${encodeURIComponent(specId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message,
        ...(opts.skillKey ? { skillKey: opts.skillKey } : {}),
      }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    if (opts.signal?.aborted) return { ok: false, cancelled: true };
    throw err;
  }
  if (res.status === 401) throw new AuthRequiredError();

  // Our own refusals (unknown item, unusable message) are decided before any
  // streaming starts and still arrive as ordinary JSON with a status.
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `The assistant failed (${res.status}).`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let outcome:
    | { ok: true; turns: AssistantMessageView[] }
    | { ok: false; error: { kind: string; message: string } }
    | null = null;

  const consume = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: AssistantStreamEvent;
    try {
      event = JSON.parse(trimmed) as AssistantStreamEvent;
    } catch {
      // A line we cannot parse is dropped rather than failing an answer that
      // is otherwise arriving fine.
      return;
    }
    if (event.kind === "delta") opts.onDelta?.(event.text);
    else if (event.kind === "done") outcome = { ok: true, turns: event.turns };
    else if (event.kind === "error") outcome = { ok: false, error: event.error };
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Everything up to the last newline is complete; the tail may be a
      // fragment of a line that has not finished arriving.
      const lastBreak = buffer.lastIndexOf("\n");
      if (lastBreak === -1) continue;
      for (const line of buffer.slice(0, lastBreak).split("\n")) consume(line);
      buffer = buffer.slice(lastBreak + 1);
    }
    consume(buffer);
  } catch (err) {
    if (opts.signal?.aborted) return { ok: false, cancelled: true };
    throw err;
  }

  if (opts.signal?.aborted) return { ok: false, cancelled: true };
  return (
    outcome ?? {
      ok: false,
      error: {
        kind: "unknown",
        message: "The answer stopped before it finished.",
      },
    }
  );
}

/** Post a comment to a feature; returns the created record. */
export async function createComment(
  specId: string,
  input: CommentInput,
): Promise<CommentRecord> {
  const res = await apiFetch(
    `/api/v1/features/${encodeURIComponent(specId)}/comments`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    comment?: CommentRecord;
    error?: string;
  } | null;
  if (!res.ok || !body?.comment) {
    throw new Error(body?.error ?? `Failed to post comment (${res.status}).`);
  }
  return body.comment;
}

/** Delete a comment (author or workspace owner only). */
export async function deleteComment(commentId: string): Promise<void> {
  const res = await apiFetch(
    `/api/v1/comments/${encodeURIComponent(commentId)}`,
    { method: "DELETE" },
  );
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Failed to delete comment (${res.status}).`);
  }
}

/** The caller's notification inbox (items + unread count). */
export async function listNotifications(): Promise<NotificationList> {
  const res = await apiFetch("/api/v1/notifications");
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as
    | (NotificationList & { error?: string })
    | null;
  if (!res.ok || !body?.items) {
    throw new Error(
      body?.error ?? `Failed to load notifications (${res.status}).`,
    );
  }
  return { items: body.items, unreadCount: body.unreadCount };
}

/** Mark one notification read. */
export async function markNotificationRead(id: string): Promise<void> {
  const res = await apiFetch(
    `/api/v1/notifications/${encodeURIComponent(id)}/read`,
    { method: "POST" },
  );
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) throw new Error(`Failed to mark read (${res.status}).`);
}

/** Mark all of the caller's notifications read. */
export async function markAllNotificationsRead(): Promise<void> {
  const res = await apiFetch("/api/v1/notifications/read-all", {
    method: "POST",
  });
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) throw new Error(`Failed to mark all read (${res.status}).`);
}

/** Create a DB-native work item (initiative/epic); returns the new record. */
export async function createWorkItem(
  input: CreateFeatureInput,
): Promise<FeatureRecord> {
  const res = await apiFetch("/api/v1/features", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    feature?: FeatureRecord;
    error?: string;
  } | null;
  if (!res.ok || !body?.feature) {
    throw new Error(body?.error ?? `Create failed with ${res.status}`);
  }
  return body.feature;
}

/** Delete a DB-native work item by id. */
export async function deleteWorkItem(
  specId: string,
  opts: { removeSpec?: boolean } = {},
): Promise<void> {
  // removeSpec also deletes the item's spec file from git; required for an item
  // that has one, since a surviving file is re-imported by the next sync.
  const query = opts.removeSpec ? "?removeSpec=1" : "";
  const res = await apiFetch(
    `/api/v1/features/${encodeURIComponent(specId)}${query}`,
    { method: "DELETE" },
  );
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `DELETE failed with ${res.status}`);
  }
}

/** The workspace's hierarchy levels, ordered top → leaf. */
export async function listLevels(): Promise<WorkspaceLevel[]> {
  const res = await apiFetch("/api/v1/levels");
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    levels?: WorkspaceLevel[];
    error?: string;
  } | null;
  if (!res.ok)
    throw new Error(body?.error ?? `Failed to load levels (${res.status}).`);
  return body?.levels ?? [];
}

/** Replace the workspace's hierarchy levels (admin-only); returns the new set. */
export async function updateLevels(
  levels: LevelUpdate[],
): Promise<WorkspaceLevel[]> {
  const res = await apiFetch("/api/v1/levels", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ levels }),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    levels?: WorkspaceLevel[];
    error?: string;
  } | null;
  if (!res.ok || !body?.levels) {
    throw new Error(body?.error ?? `Update failed with ${res.status}`);
  }
  return body.levels;
}

/**
 * Set which metadata fields are available per level (admin-only). Keys are
 * level keys; null = all fields. Returns the refreshed levels.
 */
export async function updateLevelFields(
  fields: Record<string, string[] | null>,
  productId?: string | null,
): Promise<WorkspaceLevel[]> {
  const res = await apiFetch("/api/v1/levels/fields", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fields, productId: productId ?? null }),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    levels?: WorkspaceLevel[];
    error?: string;
  } | null;
  if (!res.ok || !body?.levels) {
    throw new Error(body?.error ?? `Update failed with ${res.status}`);
  }
  return body.levels;
}

/**
 * Assign a default detail template per level (admin-only). Keys are level
 * keys; null clears the assignment. Returns the refreshed levels.
 */
export async function updateLevelTemplates(
  templates: Record<string, string | null>,
  productId?: string | null,
): Promise<WorkspaceLevel[]> {
  const res = await apiFetch("/api/v1/levels/templates", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ templates, productId: productId ?? null }),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    levels?: WorkspaceLevel[];
    error?: string;
  } | null;
  if (!res.ok || !body?.levels) {
    throw new Error(body?.error ?? `Update failed with ${res.status}`);
  }
  return body.levels;
}

/** Create a detail template (admin-only on the server); returns it. */
export async function createDetailTemplate(
  input: DetailTemplateInput,
  productId?: string | null,
): Promise<DetailTemplate> {
  const res = await apiFetch("/api/v1/detail-templates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...input, productId: productId ?? null }),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    template?: DetailTemplate;
    error?: string;
  } | null;
  if (!res.ok || !body?.template) {
    throw new Error(body?.error ?? `Create template failed with ${res.status}`);
  }
  return body.template;
}

/** Update a detail template (admin-only); returns the updated record. */
export async function updateDetailTemplate(
  id: string,
  patch: DetailTemplatePatch,
): Promise<DetailTemplate> {
  const res = await apiFetch(
    `/api/v1/detail-templates/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    template?: DetailTemplate;
    error?: string;
  } | null;
  if (!res.ok || !body?.template) {
    throw new Error(body?.error ?? `Update template failed with ${res.status}`);
  }
  return body.template;
}

/** Delete a detail template (admin-only). */
export async function deleteDetailTemplate(id: string): Promise<void> {
  const res = await apiFetch(
    `/api/v1/detail-templates/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Delete template failed with ${res.status}`);
  }
}

// ── Workflow stages ─────────────────────────────────────────────────────

/** The workspace's workflow stages ([] = built-in default workflow). */
export async function listStatuses(): Promise<WorkspaceStatus[]> {
  const res = await apiFetch("/api/v1/statuses");
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    statuses?: WorkspaceStatus[];
    error?: string;
  } | null;
  if (!res.ok)
    throw new Error(body?.error ?? `Failed to load workflow (${res.status}).`);
  return body?.statuses ?? [];
}

/**
 * Replace a product's workflow stages, or the workspace default's when
 * `productId` is omitted; returns the new set. An empty list reverts a product
 * to inheriting the default.
 */
export async function updateStatuses(
  stages: StatusStageInput[],
  productId?: string | null,
): Promise<WorkspaceStatus[]> {
  const res = await apiFetch("/api/v1/statuses", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ statuses: stages, productId: productId ?? null }),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    statuses?: WorkspaceStatus[];
    error?: string;
  } | null;
  if (!res.ok || !body?.statuses) {
    throw new Error(body?.error ?? `Update workflow failed with ${res.status}`);
  }
  return body.statuses;
}

/**
 * Set how freely items move between stages. With a `productId` this configures
 * that product (product admins and the workspace owner); without one it sets
 * the workspace default that unconfigured products inherit (owner only). A
 * `null` mode reverts a product to inheriting, and returns the mode it lands on
 * rather than null.
 */
export async function updateTransitionMode(
  mode: TransitionMode | null,
  productId?: string | null,
): Promise<TransitionMode> {
  const res = await apiFetch("/api/v1/statuses", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transitionMode: mode, productId: productId ?? null }),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    transitionMode?: TransitionMode;
    error?: string;
  } | null;
  if (!res.ok || !body?.transitionMode) {
    throw new Error(
      body?.error ?? `Update transitions failed with ${res.status}`,
    );
  }
  return body.transitionMode;
}

/** The workspace's stage gates (checklist items per stage). */
export async function listStageGates(): Promise<StageGate[]> {
  const res = await apiFetch("/api/v1/stage-gates");
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    gates?: StageGate[];
    error?: string;
  } | null;
  if (!res.ok) {
    throw new Error(
      body?.error ?? `Failed to load stage gates (${res.status}).`,
    );
  }
  return body?.gates ?? [];
}

/** Replace the workspace's stage gates (admin-only); returns the new set. */
export async function updateStageGates(
  gates: StageGateInput[],
  productId?: string | null,
): Promise<StageGate[]> {
  const res = await apiFetch("/api/v1/stage-gates", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ gates, productId: productId ?? null }),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    gates?: StageGate[];
    error?: string;
  } | null;
  if (!res.ok || !body?.gates) {
    throw new Error(
      body?.error ?? `Update stage gates failed with ${res.status}`,
    );
  }
  return body.gates;
}

/** Check/uncheck one stage gate for an item; returns the completed gate ids. */
export async function setGateCompletion(
  specId: string,
  gateId: string,
  completed: boolean,
): Promise<string[]> {
  const res = await apiFetch(
    `/api/v1/features/${encodeURIComponent(specId)}/gates`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gateId, completed }),
    },
  );
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    completed?: string[];
    error?: string;
  } | null;
  if (!res.ok || !body?.completed) {
    throw new Error(body?.error ?? `Update gate failed with ${res.status}`);
  }
  return body.completed;
}

// ── Ideas ────────────────────────────────────────────────────────────────

/** Capture a new idea; returns the new record. */
export async function createIdea(input: IdeaInput): Promise<IdeaRecord> {
  const res = await apiFetch("/api/v1/ideas", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    idea?: IdeaRecord;
    error?: string;
  } | null;
  if (!res.ok || !body?.idea) {
    throw new Error(body?.error ?? `Create idea failed with ${res.status}`);
  }
  return body.idea;
}

/** Update an idea's title/description/status/product; returns the record. */
export async function updateIdea(
  id: string,
  patch: IdeaPatch,
): Promise<IdeaRecord> {
  const res = await apiFetch(`/api/v1/ideas/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    idea?: IdeaRecord;
    error?: string;
  } | null;
  if (!res.ok || !body?.idea) {
    throw new Error(body?.error ?? `Update idea failed with ${res.status}`);
  }
  return body.idea;
}

/** Delete an idea. */
export async function deleteIdea(id: string): Promise<void> {
  const res = await apiFetch(`/api/v1/ideas/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Delete idea failed with ${res.status}`);
  }
}

/** Set the caller's vote on an idea; returns the updated record. */
export async function setIdeaVote(
  id: string,
  voted: boolean,
): Promise<IdeaRecord> {
  const res = await apiFetch(`/api/v1/ideas/${encodeURIComponent(id)}/vote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ voted }),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    idea?: IdeaRecord;
    error?: string;
  } | null;
  if (!res.ok || !body?.idea) {
    throw new Error(body?.error ?? `Vote failed with ${res.status}`);
  }
  return body.idea;
}

/** Promote an idea into a feature; returns both records. */
export async function promoteIdea(
  id: string,
): Promise<{ idea: IdeaRecord; feature: FeatureRecord }> {
  const res = await apiFetch(
    `/api/v1/ideas/${encodeURIComponent(id)}/promote`,
    {
      method: "POST",
    },
  );
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    idea?: IdeaRecord;
    feature?: FeatureRecord;
    error?: string;
  } | null;
  if (!res.ok || !body?.idea || !body?.feature) {
    throw new Error(body?.error ?? `Promote failed with ${res.status}`);
  }
  return { idea: body.idea, feature: body.feature };
}

/** Replace the workspace's idea review stages (admin-only); returns the set. */
export async function updateIdeaStatuses(
  stages: StatusStageInput[],
): Promise<IdeaStage[]> {
  const res = await apiFetch("/api/v1/idea-statuses", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ statuses: stages }),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    statuses?: IdeaStage[];
    error?: string;
  } | null;
  if (!res.ok || !body?.statuses) {
    throw new Error(
      body?.error ?? `Update idea stages failed with ${res.status}`,
    );
  }
  return body.statuses;
}

/** Update the workspace's Ideas configuration (admin-only); returns it. */
export async function updateIdeaSettings(
  patch: IdeaSettingsPatch,
): Promise<IdeaSettings> {
  const res = await apiFetch("/api/v1/idea-settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    settings?: IdeaSettings;
    error?: string;
  } | null;
  if (!res.ok || !body?.settings) {
    throw new Error(
      body?.error ?? `Update Ideas settings failed with ${res.status}`,
    );
  }
  return body.settings;
}

/** Define a custom property (admin-only on the server); returns it. */
export async function createProperty(
  input: PropertyInput,
  productId?: string | null,
): Promise<PropertyDef> {
  const res = await apiFetch("/api/v1/properties", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...input, productId: productId ?? null }),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    property?: PropertyDef;
    error?: string;
  } | null;
  if (!res.ok || !body?.property) {
    throw new Error(body?.error ?? `Create property failed with ${res.status}`);
  }
  return body.property;
}

/** Update a custom property (admin-only); returns the updated definition. */
export async function updateProperty(
  id: string,
  patch: PropertyPatch,
): Promise<PropertyDef> {
  const res = await apiFetch(`/api/v1/properties/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    property?: PropertyDef;
    error?: string;
  } | null;
  if (!res.ok || !body?.property) {
    throw new Error(body?.error ?? `Update property failed with ${res.status}`);
  }
  return body.property;
}

/** Delete a custom property definition (admin-only). */
export async function deleteProperty(id: string): Promise<void> {
  const res = await apiFetch(`/api/v1/properties/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Delete property failed with ${res.status}`);
  }
}

/** Create a release (admin-only on the server); returns the new record. */
export async function createRelease(
  input: ReleaseInput,
): Promise<ReleaseRecord> {
  const res = await apiFetch("/api/v1/releases", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    release?: ReleaseRecord;
    error?: string;
  } | null;
  if (!res.ok || !body?.release) {
    throw new Error(body?.error ?? `Create release failed with ${res.status}`);
  }
  return body.release;
}

/** Update a release (admin-only); returns the updated record. */
export async function updateRelease(
  id: string,
  patch: ReleasePatch,
): Promise<ReleaseRecord> {
  const res = await apiFetch(`/api/v1/releases/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    release?: ReleaseRecord;
    error?: string;
  } | null;
  if (!res.ok || !body?.release) {
    throw new Error(body?.error ?? `Update release failed with ${res.status}`);
  }
  return body.release;
}

/** Delete a release (admin-only); its items are unscheduled, not deleted. */
export async function deleteRelease(id: string): Promise<void> {
  const res = await apiFetch(`/api/v1/releases/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Delete release failed with ${res.status}`);
  }
}

/**
 * The work scheduled into a release, grouped by hierarchy level (top level
 * first). `count` is the number of items the caller may read, which can be
 * fewer than the release's own `itemCount`.
 */
export async function getReleaseItems(
  id: string,
): Promise<{ groups: ReleaseItemGroup[]; count: number }> {
  const res = await apiFetch(
    `/api/v1/releases/${encodeURIComponent(id)}/items`,
  );
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    groups?: ReleaseItemGroup[];
    count?: number;
    error?: string;
  } | null;
  if (!res.ok || !body?.groups) {
    throw new Error(
      body?.error ?? `Failed to load release items (${res.status}).`,
    );
  }
  return { groups: body.groups, count: body.count ?? 0 };
}


// ── Cycles ────────────────────────────────────────────────────────────────

/** Create a cycle; returns the created record (with its derived state). */
export async function createCycle(input: CycleInput): Promise<CycleRecord> {
  const res = await apiFetch("/api/v1/cycles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    cycle?: CycleRecord;
    error?: string;
  } | null;
  if (!res.ok || !body?.cycle) {
    throw new Error(body?.error ?? `Create cycle failed with ${res.status}`);
  }
  return body.cycle;
}

/**
 * Generate a run of cycles from a cadence and a horizon. Returns every cycle
 * created, in date order. All or nothing: a name clash creates none of them.
 */
export async function generateCycles(
  input: CycleGenerateInput,
): Promise<CycleRecord[]> {
  const res = await apiFetch("/api/v1/cycles/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    cycles?: CycleRecord[];
    error?: string;
  } | null;
  if (!res.ok || !body?.cycles) {
    throw new Error(body?.error ?? `Generate cycles failed with ${res.status}`);
  }
  return body.cycles;
}

/** Update a cycle's name, dates, notes or product; returns the updated record. */
export async function updateCycle(
  id: string,
  patch: CyclePatch,
): Promise<CycleRecord> {
  const res = await apiFetch(`/api/v1/cycles/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    cycle?: CycleRecord;
    error?: string;
  } | null;
  if (!res.ok || !body?.cycle) {
    throw new Error(body?.error ?? `Update cycle failed with ${res.status}`);
  }
  return body.cycle;
}

/** Delete a cycle. Its items are unscheduled, not deleted. */
export async function deleteCycle(id: string): Promise<void> {
  const res = await apiFetch(`/api/v1/cycles/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Delete cycle failed with ${res.status}`);
  }
}

/** Move a cycle's unfinished work into another cycle; returns how many moved. */
export async function rolloverCycle(
  fromCycleId: string,
  toCycleId: string,
): Promise<{ moved: number; toCycleId: string }> {
  const res = await apiFetch(
    `/api/v1/cycles/${encodeURIComponent(fromCycleId)}/rollover`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toCycleId }),
    },
  );
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    moved?: number;
    toCycleId?: string;
    error?: string;
  } | null;
  if (!res.ok || typeof body?.moved !== "number") {
    throw new Error(body?.error ?? `Rollover failed with ${res.status}`);
  }
  return { moved: body.moved, toCycleId };
}


// ── Goals ─────────────────────────────────────────────────────────────────

/** Create a goal; returns the created record. */
export async function createGoal(input: GoalInput): Promise<GoalRecord> {
  return goalRequest("/api/v1/goals", { method: "POST", body: input }, "Create goal");
}

/** Update a goal's metadata; returns the updated record. */
export async function updateGoal(
  id: string,
  patch: GoalPatch,
): Promise<GoalRecord> {
  return goalRequest(
    `/api/v1/goals/${encodeURIComponent(id)}`,
    { method: "PATCH", body: patch },
    "Update goal",
  );
}

/** Delete a goal. Linked work items are untouched. */
export async function deleteGoal(id: string): Promise<void> {
  const res = await apiFetch(`/api/v1/goals/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Delete goal failed with ${res.status}`);
  }
}

/** Add a key result; returns the goal with its recomputed progress. */
export async function createKeyResult(
  goalId: string,
  input: KeyResultInput,
): Promise<GoalRecord> {
  return goalRequest(
    `/api/v1/goals/${encodeURIComponent(goalId)}/key-results`,
    { method: "POST", body: input },
    "Add key result",
  );
}

/** Update a key result; returns the goal with its recomputed progress. */
export async function updateKeyResult(
  id: string,
  patch: KeyResultPatch,
): Promise<GoalRecord> {
  return goalRequest(
    `/api/v1/key-results/${encodeURIComponent(id)}`,
    { method: "PATCH", body: patch },
    "Update key result",
  );
}

/** Delete a key result; returns the goal with its recomputed progress. */
export async function deleteKeyResult(id: string): Promise<GoalRecord> {
  return goalRequest(
    `/api/v1/key-results/${encodeURIComponent(id)}`,
    { method: "DELETE" },
    "Delete key result",
  );
}

/** Link or unlink a work item to a goal; returns the refreshed contributions. */
export async function setGoalLink(
  goalId: string,
  specId: string,
  linked: boolean,
): Promise<GoalContribution[]> {
  const base = `/api/v1/goals/${encodeURIComponent(goalId)}/links`;
  const res = linked
    ? await apiFetch(base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ specId }),
      })
    : await apiFetch(`${base}?specId=${encodeURIComponent(specId)}`, {
        method: "DELETE",
      });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    contributions?: GoalContribution[];
    error?: string;
  } | null;
  if (!res.ok || !body?.contributions) {
    throw new Error(body?.error ?? `Goal link failed with ${res.status}`);
  }
  return body.contributions;
}

/** Shared shape for the goal endpoints, all of which return `{ goal }`. */
async function goalRequest(
  path: string,
  init: { method: string; body?: unknown },
  label: string,
): Promise<GoalRecord> {
  const res = await apiFetch(path, {
    method: init.method,
    ...(init.body !== undefined
      ? {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(init.body),
        }
      : {}),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    goal?: GoalRecord;
    error?: string;
  } | null;
  if (!res.ok || !body?.goal) {
    throw new Error(body?.error ?? `${label} failed with ${res.status}`);
  }
  return body.goal;
}

/** Create a typed relation from a feature; returns its refreshed relations. */
export async function addRelation(
  specId: string,
  input: { toSpecId: string; direction: CreatableRelationDirection },
): Promise<FeatureRelation[]> {
  const res = await apiFetch(
    `/api/v1/features/${encodeURIComponent(specId)}/relations`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    relations?: FeatureRelation[];
    error?: string;
  } | null;
  if (!res.ok) {
    throw new Error(body?.error ?? `Add relation failed with ${res.status}`);
  }
  return body?.relations ?? [];
}

/** Remove a relation by id; returns the feature's refreshed relations. */
export async function removeRelation(
  specId: string,
  linkId: string,
): Promise<FeatureRelation[]> {
  const res = await apiFetch(
    `/api/v1/features/${encodeURIComponent(specId)}/relations/${encodeURIComponent(linkId)}`,
    { method: "DELETE" },
  );
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    relations?: FeatureRelation[];
    error?: string;
  } | null;
  if (!res.ok) {
    throw new Error(body?.error ?? `Remove relation failed with ${res.status}`);
  }
  return body?.relations ?? [];
}

/** Persist the acting user's board display preferences for a space. */
export async function saveBoardPreferences(
  prefs: BoardPreferences,
  board: BoardKey = "backlog",
): Promise<void> {
  const res = await apiFetch(
    `/api/v1/board-preferences?board=${encodeURIComponent(board)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(prefs),
    },
  );
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(
      body?.error ?? `Save preferences failed with ${res.status}`,
    );
  }
}

/** Link a GitHub artifact to a feature; returns its refreshed links. */
export async function addGithubLink(
  specId: string,
  input: GithubLinkInput,
): Promise<GithubLink[]> {
  const res = await apiFetch(
    `/api/v1/features/${encodeURIComponent(specId)}/github-links`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    githubLinks?: GithubLink[];
    error?: string;
  } | null;
  if (!res.ok) {
    throw new Error(body?.error ?? `Add GitHub link failed with ${res.status}`);
  }
  return body?.githubLinks ?? [];
}

/** Remove a GitHub link by id; returns the feature's refreshed links. */
export async function removeGithubLink(
  specId: string,
  linkId: string,
): Promise<GithubLink[]> {
  const res = await apiFetch(
    `/api/v1/features/${encodeURIComponent(specId)}/github-links/${encodeURIComponent(linkId)}`,
    { method: "DELETE" },
  );
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    githubLinks?: GithubLink[];
    error?: string;
  } | null;
  if (!res.ok) {
    throw new Error(
      body?.error ?? `Remove GitHub link failed with ${res.status}`,
    );
  }
  return body?.githubLinks ?? [];
}

/** Save the current backlog filters as a named view. */
export async function saveView(input: SavedViewInput): Promise<SavedView> {
  const res = await apiFetch("/api/v1/views", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    view?: SavedView;
    error?: string;
  } | null;
  if (!res.ok || !body?.view) {
    throw new Error(body?.error ?? `Save view failed with ${res.status}`);
  }
  return body.view;
}

/** Rename or re-filter a saved view; returns the updated record. */
export async function updateView(
  id: string,
  patch: Partial<Pick<SavedViewInput, "name" | "filters">>,
): Promise<SavedView> {
  const res = await apiFetch(`/api/v1/views/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    view?: SavedView;
    error?: string;
  } | null;
  if (!res.ok || !body?.view) {
    throw new Error(body?.error ?? `Update view failed with ${res.status}`);
  }
  return body.view;
}

/** Delete a saved view by id. */
export async function deleteView(id: string): Promise<void> {
  const res = await apiFetch(`/api/v1/views/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Delete view failed with ${res.status}`);
  }
}

/**
 * Create the organization (first user only). `seedSampleData` populates a
 * starter board; otherwise the workspace begins empty. Returns the workspace slug.
 */
export async function createWorkspace(
  name: string,
  seedSampleData: boolean,
  slug?: string,
): Promise<{ slug: string }> {
  const res = await apiFetch("/api/v1/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, seedSampleData, slug }),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    workspace?: { slug: string };
    error?: string;
    code?: "slug_taken" | "slug_invalid";
    suggestion?: string;
  } | null;
  if (!res.ok || !body?.workspace) {
    if (body?.code === "slug_taken" || body?.code === "slug_invalid") {
      throw new WorkspaceSlugTakenError(
        body.error ?? "That organization URL isn't available.",
        body.code,
        body.suggestion,
      );
    }
    throw new Error(
      body?.error ?? `Workspace creation failed with ${res.status}`,
    );
  }
  return body.workspace;
}

/** Summary returned by an initial/repeat spec import. */
export interface SyncResult {
  upserted: number;
  skipped: number;
  idsInjected: number;
  /** Specs that attached to a work item that already existed. */
  attached: number;
  /** Imports that matched no existing grouping and landed unparented. */
  unparented: number;
}

export interface ConnectRepoInput {
  installationId: string;
  owner: string;
  name: string;
  defaultBranch?: string;
  /** Run the initial import on connect. Defaults to true; the onboarding flow
   *  passes false to defer importing behind an explicit confirmation. */
  sync?: boolean;
}

/**
 * Connect (or re-sync) a GitHub repository and run an import. Admin-only on the
 * server. The repository upsert always succeeds when the input is valid; the
 * import may still fail (e.g. the App isn't installed yet), surfaced as
 * `sync.error` rather than a thrown error.
 */
export async function connectRepository(
  input: ConnectRepoInput,
): Promise<{ sync: SyncResult | { error: string } | null }> {
  const res = await apiFetch("/api/v1/repositories", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    sync?: SyncResult | { error: string } | null;
    error?: string;
  } | null;
  if (!res.ok) {
    throw new Error(body?.error ?? `Connect failed with ${res.status}`);
  }
  // null when the caller deferred the import (sync: false).
  return { sync: body?.sync ?? null };
}

/** One connected repo's spec files found by a read-only scan (no import yet). */
export interface RepoScan {
  repoId: string;
  owner: string;
  name: string;
  specs: { path: string; title: string; hasId: boolean }[];
  error?: string;
}

/**
 * Read-only scan of every connected repo for spec files, without importing.
 * Backs the onboarding "found N specs, create cards?" prompt. Admin-only.
 */
export async function scanWorkspaceSpecs(): Promise<{
  repos: RepoScan[];
  totalSpecs: number;
}> {
  const res = await apiFetch("/api/v1/repositories/scan");
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    repos?: RepoScan[];
    totalSpecs?: number;
    error?: string;
  } | null;
  if (!res.ok) {
    throw new Error(body?.error ?? `Scan failed with ${res.status}`);
  }
  return { repos: body?.repos ?? [], totalSpecs: body?.totalSpecs ?? 0 };
}

/** The outcome of seeding a starter spec into a repo and importing it. */
export interface StarterSpecResult {
  path: string;
  summary: SyncResult;
}

/**
 * Commit a starter `spec.md` into a connected repo and import it, creating the
 * workspace's first card. Backs the empty-state "build your first spec"
 * walkthrough. Admin-only.
 */
export async function createStarterSpec(input: {
  repoId: string;
  featureName: string;
}): Promise<StarterSpecResult> {
  const res = await apiFetch("/api/v1/repositories/starter-spec", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    path?: string;
    summary?: SyncResult;
    error?: string;
  } | null;
  if (!res.ok) {
    throw new Error(
      body?.error ?? `Couldn't create the starter spec (${res.status}).`,
    );
  }
  return {
    path: body?.path ?? "",
    summary: body?.summary ?? {
      upserted: 0,
      skipped: 0,
      idsInjected: 0,
      attached: 0,
      unparented: 0,
    },
  };
}

/** The aggregated outcome of importing specs across all connected repos. */
export interface ImportResult {
  summary: SyncResult;
  errors: { owner: string; name: string; error: string }[];
}

/**
 * Import specs from every connected repo into the board (the "create cards"
 * confirmation behind the onboarding scan). Admin-only.
 */
export async function importWorkspaceSpecs(): Promise<ImportResult> {
  const res = await apiFetch("/api/v1/repositories/import", { method: "POST" });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    summary?: SyncResult;
    errors?: ImportResult["errors"];
    error?: string;
  } | null;
  if (!res.ok) {
    throw new Error(body?.error ?? `Import failed with ${res.status}`);
  }
  return {
    summary: body?.summary ?? {
      upserted: 0,
      skipped: 0,
      idsInjected: 0,
      attached: 0,
      unparented: 0,
    },
    errors: body?.errors ?? [],
  };
}

/** A connected repository as the API returns it (subset of the DB row). */
export interface ConnectedRepository {
  id: string;
  owner: string;
  name: string;
  defaultBranch: string;
  config: { version: number; specGlobs?: string[]; writeMode?: string } | null;
  githubInstallationId: string;
  /** Admin override of the repo config's writeMode; null means "use the config". */
  writeModeOverride?: "pr" | "direct" | null;
}

/** Fetch one connected repo in the caller's workspace; throws if not found. */
export async function getRepository(id: string): Promise<ConnectedRepository> {
  const res = await apiFetch(`/api/v1/repositories/${encodeURIComponent(id)}`);
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    repository?: ConnectedRepository;
    error?: string;
  } | null;
  if (!res.ok || !body?.repository) {
    throw new Error(body?.error ?? `Failed to load repository (${res.status}).`);
  }
  return body.repository;
}

/**
 * Update a connected repo's default branch, spec-import globs, and/or write
 * mode override. Admin-only on the server; returns the updated record.
 *
 * `writeModeOverride: null` is meaningful rather than absent: it clears the
 * override and hands the decision back to the repo's `.specboards/config.yml`.
 */
export async function updateRepository(
  id: string,
  patch: {
    defaultBranch?: string;
    specGlobs?: string[];
    writeModeOverride?: "pr" | "direct" | null;
  },
): Promise<ConnectedRepository> {
  const res = await apiFetch(`/api/v1/repositories/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    repository?: ConnectedRepository;
    error?: string;
  } | null;
  if (!res.ok || !body?.repository) {
    throw new Error(body?.error ?? `Update repository failed with ${res.status}`);
  }
  return body.repository;
}

/**
 * Disconnect a connected repository. Imported board items are kept (detached);
 * only the sync connection and its GitHub links are removed. Admin-only.
 */
export async function disconnectRepository(id: string): Promise<void> {
  const res = await apiFetch(`/api/v1/repositories/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Disconnect failed with ${res.status}`);
  }
}

/** A repo a workspace installation can access, tagged with its installation. */
export interface InstallationRepo {
  owner: string;
  name: string;
  defaultBranch: string;
  private: boolean;
  installationId: string;
}

/** A GitHub App installation bound to the workspace. */
export interface WorkspaceInstallation {
  installationId: string;
  accountLogin: string;
  accountType: string;
}

/** The workspace's installations and every repo they can access. */
export interface InstallationConnectState {
  installations: WorkspaceInstallation[];
  repositories: InstallationRepo[];
  /** Set when some repo lists couldn't be loaded (partial data is possible). */
  error: string | null;
}

/**
 * The workspace's GitHub App installations (persisted by the setup callback)
 * and the repos available to connect from each. Empty `installations` means
 * GitHub hasn't been connected yet: show the "Connect GitHub" button.
 */
export async function listInstallationRepositories(): Promise<InstallationConnectState> {
  const res = await apiFetch("/api/v1/github/installations/repositories");
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as
    | (Partial<InstallationConnectState> & {
        error?: string;
      })
    | null;
  if (!res.ok) {
    throw new Error(
      body?.error ?? `Failed to load repositories (${res.status}).`,
    );
  }
  return {
    installations: body?.installations ?? [],
    repositories: body?.repositories ?? [],
    error: body?.error ?? null,
  };
}

/** A spec repo created and connected in one step from the onboarding nudge. */
export interface CreatedSpecRepo {
  id: string;
  owner: string;
  name: string;
  defaultBranch: string;
  htmlUrl: string;
}

/**
 * Create a private repo in a workspace organization installation and connect
 * it, for the "dedicated spec repo" onboarding path. Admin-only; the target
 * installation must be bound to the workspace (see `github_installations`).
 */
export async function createSpecRepository(input: {
  name: string;
  installationId: string;
}): Promise<CreatedSpecRepo> {
  const res = await apiFetch("/api/v1/github/installations/repositories", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    repository?: CreatedSpecRepo;
    error?: string;
  } | null;
  if (!res.ok || !body?.repository) {
    throw new Error(
      body?.error ?? `Couldn't create the repository (${res.status}).`,
    );
  }
  return body.repository;
}

// ── Products ────────────────────────────────────────────────────────────

/** List the products (sibling backlogs) the caller can see. */
export async function listProducts(): Promise<ProductRecord[]> {
  const res = await apiFetch("/api/v1/products");
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    products?: ProductRecord[];
    error?: string;
  } | null;
  if (!res.ok)
    throw new Error(body?.error ?? `Failed to load products (${res.status}).`);
  return body?.products ?? [];
}

/** Fetch one product the caller can see; throws if it is unknown/not visible. */
export async function getProduct(id: string): Promise<ProductRecord> {
  const res = await apiFetch(`/api/v1/products/${encodeURIComponent(id)}`);
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    product?: ProductRecord;
    error?: string;
  } | null;
  if (!res.ok || !body?.product) {
    throw new Error(body?.error ?? `Failed to load product (${res.status}).`);
  }
  return body.product;
}

/** Create a product (org-admin only on the server); returns the new record. */
export async function createProduct(
  input: CreateProductInput,
): Promise<ProductRecord> {
  const res = await apiFetch("/api/v1/products", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    product?: ProductRecord;
    error?: string;
  } | null;
  if (!res.ok || !body?.product) {
    throw new Error(body?.error ?? `Create product failed with ${res.status}`);
  }
  return body.product;
}

/** Update a product's settings (product-admin only); returns the updated record. */
export async function updateProduct(
  id: string,
  patch: ProductPatch,
): Promise<ProductRecord> {
  const res = await apiFetch(`/api/v1/products/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    product?: ProductRecord;
    error?: string;
  } | null;
  if (!res.ok || !body?.product) {
    throw new Error(body?.error ?? `Update product failed with ${res.status}`);
  }
  return body.product;
}

/** Delete a product (must have no items). */
export async function deleteProduct(id: string): Promise<void> {
  const res = await apiFetch(`/api/v1/products/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Delete product failed with ${res.status}`);
  }
}

/** A repo's product links (see /api/v1/repositories/:id/products). */
export interface RepoProductLinksPayload {
  repoId: string;
  productIds: string[];
  defaultProductId: string | null;
}

/** Replace a repo's product links + default product (org-admin only). */
export async function setRepositoryProducts(
  repoId: string,
  input: { productIds: string[]; defaultProductId: string | null },
): Promise<RepoProductLinksPayload> {
  const res = await apiFetch(
    `/api/v1/repositories/${encodeURIComponent(repoId)}/products`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as
    | (RepoProductLinksPayload & { error?: string })
    | null;
  if (!res.ok || !body || body.error) {
    throw new Error(body?.error ?? `Updating repo products failed with ${res.status}`);
  }
  return body;
}

// ── Product groups ──────────────────────────────────────────────────────

/** List the workspace's product groups. */
export async function listProductGroups(): Promise<ProductGroupRecord[]> {
  const res = await apiFetch("/api/v1/product-groups");
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    groups?: ProductGroupRecord[];
    error?: string;
  } | null;
  if (!res.ok)
    throw new Error(body?.error ?? `Failed to load groups (${res.status}).`);
  return body?.groups ?? [];
}

/** Create a product group (org-admin only); returns the new record. */
export async function createProductGroup(
  input: CreateProductGroupInput,
): Promise<ProductGroupRecord> {
  const res = await apiFetch("/api/v1/product-groups", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    group?: ProductGroupRecord;
    error?: string;
  } | null;
  if (!res.ok || !body?.group) {
    throw new Error(body?.error ?? `Create group failed with ${res.status}`);
  }
  return body.group;
}

/** Update a product group (org-admin only); returns the updated record. */
export async function updateProductGroup(
  id: string,
  patch: ProductGroupPatch,
): Promise<ProductGroupRecord> {
  const res = await apiFetch(`/api/v1/product-groups/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    group?: ProductGroupRecord;
    error?: string;
  } | null;
  if (!res.ok || !body?.group) {
    throw new Error(body?.error ?? `Update group failed with ${res.status}`);
  }
  return body.group;
}

/** Delete a product group (must have no subgroups or products). */
export async function deleteProductGroup(id: string): Promise<void> {
  const res = await apiFetch(`/api/v1/product-groups/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Delete group failed with ${res.status}`);
  }
}

/** List a product's members (product-admin only). */
export async function listProductMembers(
  productId: string,
): Promise<ProductMemberRecord[]> {
  const res = await apiFetch(
    `/api/v1/products/${encodeURIComponent(productId)}/members`,
  );
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    members?: ProductMemberRecord[];
    error?: string;
  } | null;
  if (!res.ok)
    throw new Error(body?.error ?? `Failed to load members (${res.status}).`);
  return body?.members ?? [];
}

/** Add or update a member's role on a product (upsert). */
export async function setProductMember(
  productId: string,
  input: ProductMemberInput,
): Promise<void> {
  const res = await apiFetch(
    `/api/v1/products/${encodeURIComponent(productId)}/members`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Set member failed with ${res.status}`);
  }
}

/** Remove a member from a product. */
export async function removeProductMember(
  productId: string,
  userId: string,
): Promise<void> {
  const res = await apiFetch(
    `/api/v1/products/${encodeURIComponent(productId)}/members/${encodeURIComponent(userId)}`,
    { method: "DELETE" },
  );
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Remove member failed with ${res.status}`);
  }
}

/** List the organization's members (org-admin only). */
export async function listOrgMembers(): Promise<OrgMemberRecord[]> {
  const res = await apiFetch("/api/v1/org/members");
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    members?: OrgMemberRecord[];
    error?: string;
  } | null;
  if (!res.ok)
    throw new Error(body?.error ?? `Failed to load members (${res.status}).`);
  return body?.members ?? [];
}

/** Change a member's org role and/or active flag. Org-admin only. */
export async function updateOrgMember(
  userId: string,
  patch: { role?: OrgRole; active?: boolean },
): Promise<void> {
  const res = await apiFetch(
    `/api/v1/org/members/${encodeURIComponent(userId)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Update member failed with ${res.status}`);
  }
}

/** Remove a member from the organization. Org-admin only. */
export async function removeOrgMember(userId: string): Promise<void> {
  const res = await apiFetch(
    `/api/v1/org/members/${encodeURIComponent(userId)}`,
    {
      method: "DELETE",
    },
  );
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Remove member failed with ${res.status}`);
  }
}

/** List the org's invitations (org-admin only). */
export async function listInvitations(): Promise<OrgInvitationRecord[]> {
  const res = await apiFetch("/api/v1/org/invitations");
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    invitations?: OrgInvitationRecord[];
    error?: string;
  } | null;
  if (!res.ok)
    throw new Error(
      body?.error ?? `Failed to load invitations (${res.status}).`,
    );
  return body?.invitations ?? [];
}

/**
 * Invite someone to the org. `role` is the org role (`owner`/`member`);
 * `productGrants` gives a member per-product access on accept (ignored for an
 * owner). Returns the new invitation.
 */
export async function createInvitation(input: {
  email: string;
  role: OrgRole;
  productGrants?: InvitationProductGrant[];
}): Promise<OrgInvitationRecord> {
  const res = await apiFetch("/api/v1/org/invitations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    invitation?: OrgInvitationRecord;
    error?: string;
  } | null;
  if (!res.ok || !body?.invitation) {
    throw new Error(body?.error ?? `Invite failed with ${res.status}`);
  }
  return body.invitation;
}

/** Revoke a pending invitation. Org-admin only. */
export async function revokeInvitation(id: string): Promise<void> {
  const res = await apiFetch(
    `/api/v1/org/invitations/${encodeURIComponent(id)}`,
    {
      method: "DELETE",
    },
  );
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Revoke failed with ${res.status}`);
  }
}

/** Re-send a pending invitation (regenerates the token). Org-admin only. */
export async function resendInvitation(id: string): Promise<void> {
  const res = await apiFetch(
    `/api/v1/org/invitations/${encodeURIComponent(id)}/resend`,
    {
      method: "POST",
    },
  );
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Resend failed with ${res.status}`);
  }
}

/** Update the organization ("company") name. Admin-only on the server. */
export async function updateWorkspace(name: string): Promise<void> {
  const res = await apiFetch("/api/v1/workspace", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Update failed with ${res.status}`);
  }
}

/** Choose (or change) where a Plan-section area's docs live. */
export async function setDocSpace(input: {
  productId: string;
  area: DocArea;
  mode: "local" | "external" | "github";
  externalUrl?: string | null;
  repoId?: string | null;
}): Promise<DocSpace> {
  const res = await apiFetch("/api/v1/doc-spaces", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    space?: DocSpace;
    error?: string;
  } | null;
  if (!res.ok || !body?.space) {
    throw new Error(body?.error ?? `Save failed with ${res.status}`);
  }
  return body.space;
}

/** Create a doc folder or page; returns the new record. */
export async function createDocPage(
  input: DocPageInput,
): Promise<DocPageRecord> {
  const res = await apiFetch("/api/v1/docs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    page?: DocPageRecord;
    error?: string;
  } | null;
  if (!res.ok || !body?.page) {
    throw new Error(body?.error ?? `Create failed with ${res.status}`);
  }
  return body.page;
}

/** Rename, edit, or move a doc page; returns the updated record. */
export async function patchDocPage(
  id: string,
  patch: DocPagePatch,
): Promise<DocPageRecord> {
  const res = await apiFetch(`/api/v1/docs/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    page?: DocPageRecord;
    error?: string;
  } | null;
  if (!res.ok || !body?.page) {
    throw new Error(body?.error ?? `Save failed with ${res.status}`);
  }
  return body.page;
}

/** Delete a doc page, or a folder and its contents. */
export async function deleteDocPage(id: string): Promise<void> {
  const res = await apiFetch(`/api/v1/docs/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Delete failed with ${res.status}`);
  }
}

/**
 * Create a private GitHub docs repository and bind it as the area's doc
 * source. Returns the updated space plus the created repo's coordinates.
 */
export async function createGithubDocSpace(input: {
  productId: string;
  area: DocArea;
  name: string;
}): Promise<{ space: DocSpace; repository: { owner: string; name: string } }> {
  const res = await apiFetch("/api/v1/doc-spaces/github", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    space?: DocSpace;
    repository?: { owner: string; name: string };
    error?: string;
  } | null;
  if (!res.ok || !body?.space || !body.repository) {
    throw new Error(body?.error ?? `Create failed with ${res.status}`);
  }
  return { space: body.space, repository: body.repository };
}

/**
 * Connect a repository the GitHub App installation can already access as the
 * area's doc source.
 */
export async function connectGithubDocSpace(input: {
  productId: string;
  area: DocArea;
  owner: string;
  name: string;
  installationId: string;
}): Promise<{ space: DocSpace; repository: { owner: string; name: string } }> {
  const res = await apiFetch("/api/v1/doc-spaces/github", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      productId: input.productId,
      area: input.area,
      installationId: input.installationId,
      existing: { owner: input.owner, name: input.name },
    }),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    space?: DocSpace;
    repository?: { owner: string; name: string };
    error?: string;
  } | null;
  if (!res.ok || !body?.space || !body.repository) {
    throw new Error(body?.error ?? `Connect failed with ${res.status}`);
  }
  return { space: body.space, repository: body.repository };
}

/**
 * Save (commit) one Markdown file in a GitHub-backed doc area. `blobSha` is
 * the sha the file had when loaded (null for a new page); a stale sha means
 * someone else changed the file and the save is rejected. Returns the new sha
 * for the next save.
 */
export async function saveGithubDocFile(input: {
  productId: string;
  area: DocArea;
  path: string;
  content: string;
  blobSha: string | null;
}): Promise<{ blobSha: string }> {
  const res = await apiFetch("/api/v1/doc-spaces/github/file", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    blobSha?: string;
    error?: string;
  } | null;
  if (!res.ok || typeof body?.blobSha !== "string") {
    throw new Error(body?.error ?? `Save failed with ${res.status}`);
  }
  return { blobSha: body.blobSha };
}

/** Rename (or move) one Markdown file in a GitHub-backed doc area. */
export async function renameGithubDocFile(input: {
  productId: string;
  area: DocArea;
  path: string;
  toPath: string;
}): Promise<{ path: string; blobSha: string; content: string }> {
  const res = await apiFetch("/api/v1/doc-spaces/github/file", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 401) throw new AuthRequiredError();
  const body = (await res.json().catch(() => null)) as {
    path?: string;
    blobSha?: string;
    content?: string;
    error?: string;
  } | null;
  if (
    !res.ok ||
    typeof body?.path !== "string" ||
    typeof body.blobSha !== "string" ||
    typeof body.content !== "string"
  ) {
    throw new Error(body?.error ?? `Rename failed with ${res.status}`);
  }
  return { path: body.path, blobSha: body.blobSha, content: body.content };
}

/** Delete one Markdown file in a GitHub-backed doc area (one commit). */
export async function deleteGithubDocFile(input: {
  productId: string;
  area: DocArea;
  path: string;
  blobSha: string;
}): Promise<void> {
  const res = await apiFetch("/api/v1/doc-spaces/github/file", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Delete failed with ${res.status}`);
  }
}
