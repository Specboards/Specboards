"use client";

import { apiFetch } from "@/lib/api-client/request";
import {
  ProposalStaleError,
  SpecConflictError,
  type SpecConflict,
} from "@/lib/api-client/specs";
import type { ContextField as AssistantContextField } from "@/lib/ai/item-context";
import type { Skill, SkillRow } from "@/lib/ai/skills";
import type { AssistantMessageView } from "@/lib/assistant-service";
import type {
  BoardKey,
  BoardPreferences,
  NotificationList,
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
  FeatureRecord,
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
  ProductGroupRecord,
  ProductMemberInput,
  ProductMemberRecord,
  ProductPatch,
  ProductRecord,
  PropertyDef,
  PropertyInput,
  PropertyPatch,
  SavedView,
  SavedViewInput,
  StageGate,
  StageGateInput,
  StatusStageInput,
  TransitionMode,
  WorkspaceLevel,
  WorkspaceStatus,
} from "@/lib/store/types";

export { AuthRequiredError } from "@/lib/api-client/request";
export * from "@/lib/api-client/planning";
export * from "@/lib/api-client/repositories";
export * from "@/lib/api-client/specs";
export * from "@/lib/api-client/work-items";

/**
 * Browser-side client for the public API layer. All mutations from the UI go
 * through /api/v1 — the same surface external integrations use — so the
 * browser never talks to anything but the versioned API.
 */

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
  /** About how many tokens the next question sends. See `lib/ai/estimate.ts`. */
  estimatedPromptTokens: number;
}> {
  const res = await apiFetch(
    `/api/v1/assistant/${encodeURIComponent(specId)}`,
  );
  const body = (await res.json().catch(() => null)) as {
    messages?: AssistantMessageView[];
    context?: AssistantContextField[];
    modelConnected?: boolean;
    canEdit?: boolean;
    canPropose?: boolean;
    body?: string;
    skills?: Skill[];
    activeSkillKey?: string | null;
    estimatedPromptTokens?: number;
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
    estimatedPromptTokens: body.estimatedPromptTokens ?? 0,
  };
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
interface ProposedChild {
  title: string;
  details: string;
}

type BreakdownSuggestion =
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

/**
 * Roughly what a breakdown would send, in tokens, without sending it.
 *
 * Returns null when there is nothing to estimate: no level below this item, or
 * the request did not work. A missing estimate is a line the UI leaves out, not
 * a failure worth interrupting somebody over, so this swallows rather than
 * throws.
 */
export async function estimateBreakdown(specId: string): Promise<number | null> {
  try {
    const res = await apiFetch(
      `/api/v1/assistant/${encodeURIComponent(specId)}/breakdown`,
    );
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as {
      estimatedPromptTokens?: number | null;
    } | null;
    return typeof body?.estimatedPromptTokens === "number"
      ? body.estimatedPromptTokens
      : null;
  } catch {
    return null;
  }
}

/** What came back from accepting or rejecting a proposed edit. */
interface ProposalOutcome {
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
 * thing: the version that won, not just the news that it did. A DB-native card
 * has no sha to merge against and raises {@link ProposalStaleError} instead,
 * which carries the same thing for the same reason.
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
  const payload = (await res.json().catch(() => null)) as
    | (ProposalOutcome & {
        conflict?: SpecConflict;
        currentBody?: string;
        error?: string;
      })
    | null;
  if (res.status === 409 && payload?.conflict) {
    throw new SpecConflictError(payload.error ?? "", payload.conflict);
  }
  // Checked for the property rather than for a 409, because a proposal already
  // settled by somebody else is a 409 too and carries no body to redraw against.
  if (res.status === 409 && typeof payload?.currentBody === "string") {
    throw new ProposalStaleError(payload.error ?? "", payload.currentBody);
  }
  if (!res.ok || !payload?.message) {
    throw new Error(payload?.error ?? `That did not go through (${res.status}).`);
  }
  return payload;
}

/**
 * Read an NDJSON body, handing each parsed line to `onEvent`.
 *
 * Shared by every streaming call rather than written out per endpoint, because
 * the part that is easy to get subtly wrong is the same everywhere: a chunk
 * boundary lands mid-line far more often than it looks like it should, and a
 * reader that parses whatever a chunk happened to contain works perfectly until
 * the first answer long enough to be split.
 *
 * A line that will not parse is dropped rather than thrown on. The alternative
 * is failing an answer that is otherwise arriving fine, which trades a missing
 * fragment for a lost draft.
 */
async function readNdjson<T>(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: T) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const consume = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      onEvent(JSON.parse(trimmed) as T);
    } catch {
      // Unparseable line; see above.
    }
  };

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
}

/** One line of the assistant's NDJSON stream, as the browser sees it. */
type AssistantStreamEvent =
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

  // Our own refusals (unknown item, unusable message) are decided before any
  // streaming starts and still arrive as ordinary JSON with a status.
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `The assistant failed (${res.status}).`);
  }

  let outcome:
    | { ok: true; turns: AssistantMessageView[] }
    | { ok: false; error: { kind: string; message: string } }
    | null = null;

  try {
    await readNdjson<AssistantStreamEvent>(res.body, (event) => {
      if (event.kind === "delta") opts.onDelta?.(event.text);
      else if (event.kind === "done") outcome = { ok: true, turns: event.turns };
      else if (event.kind === "error") outcome = { ok: false, error: event.error };
    });
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

/**
 * The assistant thread for a release, plus the context that would be sent about
 * it. The release twin of {@link getAssistantThread}, and the same contract:
 * both halves come from one response so the panel cannot show a disclosure that
 * describes a different request from the one it makes.
 */
export async function getReleaseAssistantThread(releaseId: string): Promise<{
  messages: AssistantMessageView[];
  context: AssistantContextField[];
  modelConnected: boolean;
  canEdit: boolean;
  canPropose: boolean;
  body: string;
  skills: Skill[];
  activeSkillKey: string | null;
  estimatedPromptTokens: number;
  itemsIncluded: number;
  itemsOmitted: number;
}> {
  const res = await apiFetch(
    `/api/v1/assistant/releases/${encodeURIComponent(releaseId)}`,
  );
  const body = (await res.json().catch(() => null)) as {
    messages?: AssistantMessageView[];
    context?: AssistantContextField[];
    modelConnected?: boolean;
    canEdit?: boolean;
    canPropose?: boolean;
    body?: string;
    skills?: Skill[];
    activeSkillKey?: string | null;
    estimatedPromptTokens?: number;
    itemsIncluded?: number;
    itemsOmitted?: number;
    error?: string;
  } | null;
  if (!res.ok || !body?.messages || !body?.context) {
    throw new Error(
      body?.error ?? `Could not load the assistant (${res.status}).`,
    );
  }
  return {
    messages: body.messages,
    context: body.context,
    modelConnected: body.modelConnected ?? false,
    canEdit: body.canEdit ?? false,
    canPropose: body.canPropose ?? false,
    body: body.body ?? "",
    skills: body.skills ?? [],
    activeSkillKey: body.activeSkillKey ?? null,
    estimatedPromptTokens: body.estimatedPromptTokens ?? 0,
    itemsIncluded: body.itemsIncluded ?? 0,
    itemsOmitted: body.itemsOmitted ?? 0,
  };
}

/**
 * Ask the assistant about a release, rendering the answer as it arrives.
 *
 * The release twin of {@link askAssistant}; see that function for why a failure
 * at the customer's own endpoint comes back as a value rather than a throw.
 */
export async function askReleaseAssistant(
  releaseId: string,
  message: string,
  opts: {
    onDelta?: (text: string) => void;
    signal?: AbortSignal;
    skillKey?: string | null;
  } = {},
): Promise<
  | { ok: true; turns: AssistantMessageView[] }
  | { ok: false; error: { kind: string; message: string } }
  | { ok: false; cancelled: true }
> {
  let res: Response;
  try {
    res = await apiFetch(
      `/api/v1/assistant/releases/${encodeURIComponent(releaseId)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message,
          ...(opts.skillKey ? { skillKey: opts.skillKey } : {}),
        }),
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
    );
  } catch (err) {
    if (opts.signal?.aborted) return { ok: false, cancelled: true };
    throw err;
  }

  // Our own refusals (unknown release, no permission, unusable message) are
  // decided before any streaming starts and arrive as ordinary JSON.
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `The assistant failed (${res.status}).`);
  }

  let outcome:
    | { ok: true; turns: AssistantMessageView[] }
    | { ok: false; error: { kind: string; message: string } }
    | null = null;

  try {
    await readNdjson<AssistantStreamEvent>(res.body, (event) => {
      if (event.kind === "delta") opts.onDelta?.(event.text);
      else if (event.kind === "done") outcome = { ok: true, turns: event.turns };
      else if (event.kind === "error") outcome = { ok: false, error: event.error };
    });
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

/**
 * Accept or reject proposed release notes.
 *
 * Under `/releases` rather than `/assistant`, so an API key needs the grant that
 * lets it edit the release by hand. Drafting and publishing stay two decisions.
 *
 * Notes drafted against a version that has since moved raise
 * {@link ProposalStaleError}, carrying the notes as they stand now.
 */
export async function resolveReleaseProposal(
  releaseId: string,
  messageId: string,
  action: "accept" | "reject",
  opts: { body?: string } = {},
): Promise<ProposalOutcome> {
  const res = await apiFetch(
    `/api/v1/releases/${encodeURIComponent(releaseId)}/proposals`,
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
  const payload = (await res.json().catch(() => null)) as
    | (ProposalOutcome & { currentBody?: string; error?: string })
    | null;
  // See the note in `resolveProposal`: a settled proposal is a 409 as well, so
  // the body riding along is what distinguishes this one.
  if (res.status === 409 && typeof payload?.currentBody === "string") {
    throw new ProposalStaleError(payload.error ?? "", payload.currentBody);
  }
  if (!res.ok || !payload?.message) {
    throw new Error(payload?.error ?? `That did not go through (${res.status}).`);
  }
  return payload;
}

/** The caller's notification inbox (items + unread count). */
export async function listNotifications(): Promise<NotificationList> {
  const res = await apiFetch("/api/v1/notifications");
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
  if (!res.ok) throw new Error(`Failed to mark read (${res.status}).`);
}

/** Mark all of the caller's notifications read. */
export async function markAllNotificationsRead(): Promise<void> {
  const res = await apiFetch("/api/v1/notifications/read-all", {
    method: "POST",
  });
  if (!res.ok) throw new Error(`Failed to mark all read (${res.status}).`);
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
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Delete template failed with ${res.status}`);
  }
}

// ── Workflow stages ─────────────────────────────────────────────────────

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
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Delete property failed with ${res.status}`);
  }
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
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(
      body?.error ?? `Save preferences failed with ${res.status}`,
    );
  }
}

/** Save the current backlog filters as a named view. */
export async function saveView(input: SavedViewInput): Promise<SavedView> {
  const res = await apiFetch("/api/v1/views", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => null)) as {
    view?: SavedView;
    error?: string;
  } | null;
  if (!res.ok || !body?.view) {
    throw new Error(body?.error ?? `Save view failed with ${res.status}`);
  }
  return body.view;
}

/** Delete a saved view by id. */
export async function deleteView(id: string): Promise<void> {
  const res = await apiFetch(`/api/v1/views/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
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

// ── Products ────────────────────────────────────────────────────────────

/** Create a product (org-admin only on the server); returns the new record. */
export async function createProduct(
  input: CreateProductInput,
): Promise<ProductRecord> {
  const res = await apiFetch("/api/v1/products", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
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
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Delete product failed with ${res.status}`);
  }
}

// ── Product groups ──────────────────────────────────────────────────────

/** Create a product group (org-admin only); returns the new record. */
export async function createProductGroup(
  input: CreateProductGroupInput,
): Promise<ProductGroupRecord> {
  const res = await apiFetch("/api/v1/product-groups", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
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
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Delete failed with ${res.status}`);
  }
}
