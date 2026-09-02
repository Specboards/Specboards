import {
  askAssistant,
  askReleaseAssistant,
  getAssistantThread,
  getReleaseAssistantThread,
  resolveProposal,
  resolveReleaseProposal,
} from "@/lib/api-client/assistant";

/**
 * What an assistant panel is about, and the three calls that depend on it.
 *
 * A discriminated union rather than two optional ids, so a caller cannot ask
 * for a panel about both or about neither. The panel is otherwise almost
 * entirely subject-agnostic: streaming, history, skills, the disclosure and the
 * proposal review are the same job whatever is being discussed.
 *
 * The six endpoints are paired here so the pairing itself can be checked. It is
 * the one place an item/release mix-up could hide: a release panel wired to the
 * item thread would load somebody else's conversation and look like it worked.
 */

export type AssistantSubject =
  { kind: "item"; specId: string } | { kind: "release"; releaseId: string };

/** The subject's id, whichever kind it is. */
export function subjectId(subject: AssistantSubject): string {
  return subject.kind === "item" ? subject.specId : subject.releaseId;
}

/** What the panel calls the thing it is about, in copy shown to a person. */
export function subjectNoun(subject: AssistantSubject): "item" | "release" {
  return subject.kind;
}

/** What the panel calls the subject's editable body, in copy shown to a person. */
export function subjectBodyNoun(
  subject: AssistantSubject,
): "description" | "notes" {
  return subject.kind === "release" ? "notes" : "description";
}

interface AssistantApi {
  loadThread: () => ReturnType<typeof getAssistantThread>;
  sendTurn: (
    message: string,
    opts: Parameters<typeof askAssistant>[2],
  ) => ReturnType<typeof askAssistant>;
  sendResolution: (
    messageId: string,
    action: "accept" | "reject",
    opts: { body?: string },
  ) => ReturnType<typeof resolveProposal>;
}

/**
 * The three calls, bound to one subject.
 *
 * Takes the kind and id as separate arguments rather than the union, so the
 * caller can memoize on two primitives. Closing over the subject object would
 * rebuild these every render, and the panel's load effect would then either
 * refetch forever or need its dependency list lied about.
 */
export function assistantApi(isItem: boolean, id: string): AssistantApi {
  return {
    loadThread: () =>
      isItem ? getAssistantThread(id) : getReleaseAssistantThread(id),
    sendTurn: (message, opts) =>
      isItem
        ? askAssistant(id, message, opts)
        : askReleaseAssistant(id, message, opts),
    sendResolution: (messageId, action, opts) =>
      isItem
        ? resolveProposal(id, messageId, action, opts)
        : resolveReleaseProposal(id, messageId, action, opts),
  };
}
