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
  const res = await apiFetch(`/api/v1/assistant/${encodeURIComponent(specId)}`);
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
export async function saveAssistantSkills(
  skills: SkillRow[],
): Promise<Skill[]> {
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
    throw new Error(
      body?.error ?? `Could not save the skills (${res.status}).`,
    );
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
    | (BreakdownSuggestion & {
        error?: string | { kind: string; message: string };
      })
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
export async function estimateBreakdown(
  specId: string,
): Promise<number | null> {
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
    throw new Error(
      payload?.error ?? `That did not go through (${res.status}).`,
    );
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
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `The assistant failed (${res.status}).`);
  }

  let outcome:
    | { ok: true; turns: AssistantMessageView[] }
    | { ok: false; error: { kind: string; message: string } }
    | null = null;

  try {
    await readNdjson<AssistantStreamEvent>(res.body, (event) => {
      if (event.kind === "delta") opts.onDelta?.(event.text);
      else if (event.kind === "done")
        outcome = { ok: true, turns: event.turns };
      else if (event.kind === "error")
        outcome = { ok: false, error: event.error };
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
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `The assistant failed (${res.status}).`);
  }

  let outcome:
    | { ok: true; turns: AssistantMessageView[] }
    | { ok: false; error: { kind: string; message: string } }
    | null = null;

  try {
    await readNdjson<AssistantStreamEvent>(res.body, (event) => {
      if (event.kind === "delta") opts.onDelta?.(event.text);
      else if (event.kind === "done")
        outcome = { ok: true, turns: event.turns };
      else if (event.kind === "error")
        outcome = { ok: false, error: event.error };
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
    (ProposalOutcome & { currentBody?: string; error?: string }) | null;
  // See the note in `resolveProposal`: a settled proposal is a 409 as well, so
  // the body riding along is what distinguishes this one.
  if (res.status === 409 && typeof payload?.currentBody === "string") {
    throw new ProposalStaleError(payload.error ?? "", payload.currentBody);
  }
  if (!res.ok || !payload?.message) {
    throw new Error(
      payload?.error ?? `That did not go through (${res.status}).`,
    );
  }
  return payload;
}
