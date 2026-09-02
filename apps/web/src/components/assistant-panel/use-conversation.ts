"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import type { ContextField } from "@/lib/ai/item-context";
import type { Skill } from "@/lib/ai/skills";
import { redirectOnAuthExpiry } from "@/lib/auth-expiry";
import type { AssistantMessageView } from "@/lib/assistant-service";
import { toast } from "sonner";

import { resolutionEffect, resolutionFailure, turnResult } from "./outcomes";
import {
  assistantApi,
  subjectId as idOf,
  type AssistantSubject,
} from "./subject";

/**
 * One assistant conversation: everything it knows, and everything that changes
 * it.
 *
 * The panel around this is a render of what comes back. Keeping the two apart
 * matters most for the request lifecycle, which is the part with nothing on
 * screen to remind you it exists: a turn holds an AbortController that has to
 * be fired when the panel unmounts, because the section it lives in is
 * collapsed by default and a customer keeps paying for tokens that have
 * nowhere to go.
 *
 * What is deliberately not here: which disclosure is open, whether the whole
 * thread is shown, and the stream box's scroll position. Those are about the
 * page, not the conversation.
 *
 * The decisions each command needs (what a finished turn means, what a
 * resolution means for the rest of the page) are in `./outcomes`, tested on
 * their own.
 */
export function useConversation(
  subject: AssistantSubject,
  onApplied?: (body: string) => void,
) {
  const router = useRouter();
  const isItem = subject.kind === "item";
  const id = idOf(subject);

  // Memoized on two primitives rather than on `subject`, so the three calls are
  // stable for as long as the subject is. Closing over the prop object would
  // rebuild them every render, and the load effect below would then either
  // refetch forever or need its dependency list lied about.
  const { loadThread, sendTurn, sendResolution } = useMemo(
    () => assistantApi(isItem, id),
    [isItem, id],
  );
  const [messages, setMessages] = useState<AssistantMessageView[] | null>(null);
  const [context, setContext] = useState<ContextField[]>([]);
  /**
   * About how many tokens the next question sends. Server-computed from the
   * same pieces the request is built from, so the disclosure of *what* is sent
   * and the disclosure of what it costs cannot describe different payloads.
   */
  const [estimate, setEstimate] = useState(0);
  const [modelConnected, setModelConnected] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  /** Whether this person may accept a proposal, decided by the server. */
  const [canEdit, setCanEdit] = useState(false);
  /** Whether the assistant is being invited to propose one at all. */
  const [canPropose, setCanPropose] = useState(false);
  /** The description a proposal is diffed against. Moves when one is accepted. */
  const [itemBody, setItemBody] = useState("");
  /** What this workspace's assistant can be asked to do. */
  const [skills, setSkills] = useState<Skill[]>([]);
  /**
   * The skill in force, owned here rather than recomputed on the server for
   * each turn: it is the browser that knows the person has just pressed Stop
   * grilling, and a turn sent while that was still being written to the
   * database would carry the wrong answer.
   */
  const [activeSkillKey, setActiveSkillKey] = useState<string | null>(null);
  /** The proposal currently being applied, so its buttons can say so. */
  const [resolving, setResolving] = useState<string | null>(null);
  const [proposalError, setProposalError] = useState<string | null>(null);
  const [failure, setFailure] = useState<{
    text: string;
    settingsLink: boolean;
  } | null>(null);
  /** The answer as it arrives. Null when no turn is in flight. */
  const [streaming, setStreaming] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const pending = streaming !== null;

  // Abandon an in-flight answer when the panel goes away (the section is
  // collapsed, or the flyout switches items). Without this the request keeps
  // running and the customer keeps paying for tokens that have nowhere to go.
  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    let active = true;
    setMessages(null);
    setLoadError(null);
    loadThread()
      .then((res) => {
        if (!active) return;
        setMessages(res.messages);
        setContext(res.context);
        setEstimate(res.estimatedPromptTokens);
        setModelConnected(res.modelConnected);
        setCanEdit(res.canEdit);
        setCanPropose(res.canPropose);
        setItemBody(res.body);
        setSkills(res.skills);
        setActiveSkillKey(res.activeSkillKey);
      })
      .catch((err) => {
        if (!active) return;
        setLoadError(
          err instanceof Error ? err.message : "Could not load the assistant.",
        );
      });
    return () => {
      active = false;
    };
  }, [loadThread]);

  /**
   * Ask a question.
   *
   * The skill in force rides along, so answering a grilling's question is still
   * part of the grilling rather than an unrelated aside.
   */
  function ask(question: string) {
    void send(question, activeSkillKey);
  }

  /**
   * Run a skill.
   *
   * The message is left empty: the server fills in the skill's own name, so the
   * turn recorded in the thread says what was actually run rather than whatever
   * label this build of the browser happened to be showing.
   */
  function onRunSkill(skill: Skill) {
    const previous = activeSkillKey;
    setActiveSkillKey(skill.key);
    // Rolled back if the turn never landed. Nothing was written, so a panel
    // still saying "Grilling" would be describing a state that vanishes on the
    // next reload, and the person would be answering questions nobody asked.
    void send("", skill.key).then((landed) => {
      if (!landed) setActiveSkillKey(previous);
    });
  }

  /** One turn, from either the composer or a skill button. */
  async function send(
    question: string,
    skillKey: string | null,
  ): Promise<boolean> {
    if (pending) return false;

    const controller = new AbortController();
    abortRef.current = controller;
    setFailure(null);
    setStreaming("");

    try {
      const outcome = await sendTurn(question, {
        signal: controller.signal,
        onDelta: (text) => setStreaming((prev) => (prev ?? "") + text),
        skillKey,
      });

      const result = turnResult(outcome);
      if (result.kind === "landed") {
        setMessages((prev) => [...(prev ?? []), ...result.turns]);
        setDraft("");
        return true;
      }
      if (result.kind === "cancelled") return false;

      setFailure(result.advice);
      // The draft is deliberately left in the composer. Nothing was persisted,
      // so clearing it would lose the question to a failure the person can
      // often fix and retry in one click.
      return false;
    } catch (err) {
      if (redirectOnAuthExpiry(err, router)) return false;
      setFailure({
        text: err instanceof Error ? err.message : "The assistant failed.",
        settingsLink: false,
      });
      return false;
    } finally {
      abortRef.current = null;
      setStreaming(null);
    }
  }

  /**
   * Accept or reject one proposal.
   *
   * Every outcome the person needs to act on is surfaced, because this is the
   * one place in the panel where a click changes the product: a change that
   * went to review instead of live, and a change that merged with somebody
   * else's edit, both look like plain success if nobody says otherwise.
   */
  async function onResolve(
    messageId: string,
    action: "accept" | "reject",
    body?: string,
  ) {
    if (resolving) return;
    setResolving(messageId);
    setProposalError(null);
    try {
      const outcome = await sendResolution(messageId, action, {
        ...(body !== undefined ? { body } : {}),
      });
      setMessages((prev) =>
        (prev ?? []).map((m) =>
          m.id === messageId
            ? // The server does not re-resolve the author's name, so the turn
              // keeps the one it was loaded with rather than losing it.
              { ...outcome.message, authorName: m.authorName }
            : m,
        ),
      );
      setItemBody(outcome.body);

      // In this order. The reseed goes first because the editor above is
      // holding the old body and will write it back on the next keystroke.
      const effect = resolutionEffect(action, outcome, subject);
      if (effect.reseedHost !== null) onApplied?.(effect.reseedHost);
      toast.success(effect.toast);
      // The description elsewhere on the page is server-rendered, so it keeps
      // showing the old text until this runs.
      if (effect.refresh) router.refresh();
    } catch (err) {
      if (redirectOnAuthExpiry(err, router)) return;
      // The proposal stays open rather than being marked resolved: it was not
      // applied, and a card claiming otherwise is worse than the error.
      const failed = resolutionFailure(err, subject);
      setProposalError(failed.message);
      if (failed.body !== null) setItemBody(failed.body);
    } finally {
      setResolving(null);
    }
  }
  return {
    messages,
    context,
    estimate,
    modelConnected,
    loadError,
    draft,
    setDraft,
    canEdit,
    canPropose,
    itemBody,
    skills,
    activeSkillKey,
    resolving,
    proposalError,
    failure,
    streaming,
    /** Whether a turn is in flight, which is the same question as `streaming`. */
    pending,
    /** Ask a question, carrying whatever skill is in force. */
    ask,
    /** Run a skill, rolling the chip back if the turn never landed. */
    onRunSkill,
    /**
     * Stop the skill in force.
     *
     * A command rather than a setter, because the browser owning this is the
     * whole point: a turn sent while the stop was still being written to the
     * database would carry the wrong answer.
     */
    stopSkill: () => setActiveSkillKey(null),
    /**
     * Abandon the turn in flight.
     *
     * The partial answer is dropped rather than left on screen; the server
     * stored nothing, so showing it would imply a turn that does not exist.
     */
    cancel: () => abortRef.current?.abort(),
    onResolve,
  };
}
