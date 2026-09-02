"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";

import { composeFromHunks, diffHunks, diffLines } from "@specboards/core";

import { SpecDiff } from "@/components/spec-diff";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { formatTokenEstimate } from "@/lib/ai/estimate";
import { parseAnswer, proposalStarted } from "@/lib/ai/proposals";
import type { AssistantMessageView } from "@/lib/assistant-service";
import { useOrgPath } from "@/lib/use-org";

import {
  subjectNoun,
  type AssistantSubject,
} from "@/components/assistant-panel/subject";
import { useConversation } from "@/components/assistant-panel/use-conversation";
import {
  LONG_MESSAGE_CHARS,
  threadWindow,
  turnTime,
} from "@/components/assistant-panel/thread";

/**
 * A proposed edit, and the decision about it.
 *
 * ── Why the buttons are here and not in the item editor ─────────────────────
 * The proposal is part of a conversation and only makes sense beside the
 * sentence explaining it. Lifting it into the description editor would separate
 * "here is what I changed and why" from "here is the change", and a reviewer
 * would be approving a diff with the reasoning two sections away.
 *
 * ── Why "edit before accepting" is a plain textarea ─────────────────────────
 * It is deliberately not the Markdown editor the description uses. This is a
 * correction to somebody else's draft made in the middle of reviewing it, and
 * dropping a full editing surface into the middle of a diff makes the panel
 * about writing rather than about deciding. The reviewer who wants the real
 * editor accepts and then edits the item, which is one more click and the right
 * shape.
 */
function ProposalReview({
  proposed,
  current,
  state,
  canEdit,
  busy,
  onResolve,
}: {
  proposed: string;
  current: string;
  state: NonNullable<AssistantMessageView["proposal"]>;
  canEdit: boolean;
  busy: boolean;
  onResolve: (action: "accept" | "reject", body?: string) => void;
}) {
  const [showProposed, setShowProposed] = useState(state.outcome === null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(proposed);

  /**
   * How many separate changes this proposal makes, which is what a partial
   * accept picks from. Recomputed from the draft, so editing the text
   * reshuffles the changes rather than leaving the selection pointing at
   * regions that have moved.
   */
  const hunkCount = useMemo(
    () => diffHunks(diffLines(current, draft)).length,
    [current, draft],
  );

  /** Changes being taken, by index. Everything, until someone unticks one. */
  const [taken, setTaken] = useState<ReadonlySet<number>>(new Set());
  // Reset whenever the set of changes could have moved under the selection: a
  // stale index does not error, it applies a different change, which is the
  // one failure mode here that nobody would catch.
  useEffect(() => {
    setTaken(new Set(Array.from({ length: hunkCount }, (_, i) => i)));
  }, [hunkCount, current, draft]);

  const toggleHunk = (index: number) =>
    setTaken((prev) => {
      const next = new Set(prev);
      if (!next.delete(index)) next.add(index);
      return next;
    });

  const partial = taken.size < hunkCount;
  const nothingTaken = hunkCount > 0 && taken.size === 0;

  /**
   * Apply what is ticked.
   *
   * Composed from the selection rather than sent as "these hunk indices", so
   * the server keeps exactly one notion of an accepted proposal: a body. It
   * also means a partial accept is guarded, merged and recorded identically to
   * a whole one, instead of being a second write path with its own edge cases.
   */
  const accept = () => {
    if (nothingTaken) return;
    if (!partial) {
      onResolve("accept", draft === proposed ? undefined : draft);
      return;
    }
    onResolve("accept", composeFromHunks(current, draft, taken));
  };

  if (state.outcome) {
    return (
      <div className="mt-2 space-y-2 rounded-md border bg-muted/30 p-3 text-xs">
        <p className="text-muted-foreground">
          {/* Names the person, because "which was it" is the question this
              record exists to answer six months later. */}
          {state.outcome === "accepted" ? "Accepted" : "Not taken"} by{" "}
          <span className="font-medium text-foreground">
            {state.resolvedByName ?? "someone"}
          </span>
          {state.resolvedAt ? (
            <span title={new Date(state.resolvedAt).toLocaleString()}>
              {" "}
              at {turnTime(state.resolvedAt)}
            </span>
          ) : null}
          {state.commitSha ? (
            <span className="font-mono"> ({state.commitSha.slice(0, 7)})</span>
          ) : null}
        </p>
        <button
          type="button"
          onClick={() => setShowProposed((v) => !v)}
          className="text-muted-foreground underline-offset-2 hover:underline"
        >
          {showProposed ? "Hide" : "Show"} what was proposed
        </button>
        {/* The draft itself, not a diff. A diff needs two versions and there is
            no honest pair left once this is settled: the item has moved on, so
            diffing against it describes some third change nobody made. Worse,
            where the reviewer edited before accepting, their additions show up
            as *removals* against the model's draft, which reads as the accept
            having deleted them. Found by accepting one and reading it back.
            A settled proposal is a record of what was offered; what landed is
            a matter for the item and its history. */}
        {showProposed ? (
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border bg-background p-2 font-mono text-2xs">
            {proposed}
          </pre>
        ) : null}
      </div>
    );
  }

  return (
    <div className="mt-2 space-y-3 rounded-md border border-link/40 bg-link/5 p-3">
      <p className="text-xs font-medium">Proposed change to the description</p>

      {editing ? (
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={14}
          className="font-mono text-2xs"
        />
      ) : (
        <SpecDiff
          before={current}
          after={draft}
          // Only offered to someone who could act on the selection. A reader
          // ticking boxes that lead to no button is worse than no boxes.
          {...(canEdit ? { selected: taken, onToggleHunk: toggleHunk } : {})}
        />
      )}

      {canEdit ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={busy || nothingTaken} onClick={accept}>
            {busy
              ? "Applying…"
              : partial
                ? `Accept ${taken.size} of ${hunkCount} changes`
                : "Accept"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setEditing((v) => !v)}
          >
            {editing ? "Back to the diff" : "Edit before accepting"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => onResolve("reject")}
          >
            Reject
          </Button>
          {nothingTaken ? (
            // Applying nothing is not an accept, and pretending it is would
            // record a decision the item cannot show. Reject is right there.
            <p className="text-2xs text-muted-foreground">
              Nothing is ticked. Reject turns the whole proposal down.
            </p>
          ) : draft !== proposed && !editing ? (
            <p className="text-2xs text-muted-foreground">
              Showing your edited version.
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-2xs text-muted-foreground">
          You can read this proposal but not apply it. Someone with edit access
          to this item can accept it.
        </p>
      )}
    </div>
  );
}

/**
 * One settled turn.
 *
 * Its own component so each can hold its own expanded state; a `useState` per
 * message inside the list's `map` is not something React allows.
 *
 * `collapsible` is false for the newest turn. Watching an answer stream in and
 * then having it fold itself away the instant it finishes is a small betrayal:
 * the thing you were reading disappears at the moment you were reading it. So
 * the last message stays whole and only history condenses.
 */
function AssistantTurn({
  message,
  collapsible,
  itemBody,
  canEdit,
  busy,
  onResolve,
}: {
  message: AssistantMessageView;
  collapsible: boolean;
  /** The description as it stands, which is what a proposal is diffed against. */
  itemBody: string;
  canEdit: boolean;
  busy: boolean;
  onResolve: (action: "accept" | "reject", body?: string) => void;
}) {
  // Parsed here rather than sent by the server: the panel has to parse the
  // stream as it arrives anyway, and one parser is what stops the text a
  // reviewer is shown from drifting away from the text an accept would apply.
  const { prose, proposal } = parseAnswer(message.content);
  const shown = message.role === "assistant" ? prose : message.content;
  const long = shown.length > LONG_MESSAGE_CHARS;
  const [open, setOpen] = useState(false);
  const clamped = collapsible && long && !open;

  return (
    <li className="space-y-1">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {message.role === "assistant"
            ? "Assistant"
            : (message.authorName ?? "Someone")}
        </span>
        {message.role === "assistant" && message.model ? (
          <span className="font-mono">{message.model}</span>
        ) : null}
        <span title={new Date(message.createdAt).toLocaleString()}>
          {turnTime(message.createdAt)}
        </span>
      </div>

      <div
        className={clamped ? "relative max-h-24 overflow-hidden" : undefined}
      >
        {message.role === "assistant" ? (
          <div className="prose prose-sm prose-neutral max-w-none dark:prose-invert">
            <ReactMarkdown>{shown}</ReactMarkdown>
          </div>
        ) : (
          <p className="whitespace-pre-wrap break-words text-sm">{shown}</p>
        )}
        {clamped ? (
          // Fades rather than cutting flat, so it reads as "there is more"
          // instead of as a rendering fault.
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-b from-transparent to-background" />
        ) : null}
      </div>

      {collapsible && long ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
        >
          {open ? "Show less" : "Show more"}
        </button>
      ) : null}

      {/* Never clamped away with the prose. An undecided proposal is the one
          thing on this card waiting for a person, and hiding it behind "Show
          more" is how it gets forgotten. */}
      {proposal && message.proposal ? (
        <ProposalReview
          proposed={proposal}
          current={itemBody}
          state={message.proposal}
          canEdit={canEdit}
          busy={busy}
          onResolve={onResolve}
        />
      ) : null}
    </li>
  );
}

/**
 * The assistant conversation about one item.
 *
 * Lives inside a collapsed-by-default `DetailSection`, which unmounts its
 * children, so opening the section is what triggers the fetch. That collapse is
 * also why the composer is shown straight away rather than behind an "Ask the
 * assistant" affordance: expanding a section called Assistant is already the
 * opt-in the "add" convention asks for, and a conversation panel whose only
 * control is a button to reveal the input reads as broken rather than tidy.
 *
 * An answer may carry a proposed edit, which is inert text until someone
 * accepts it here. The panel never applies anything itself: accepting posts to
 * the item's own write route, which is the same one a hand-made edit takes.
 */
export function AssistantPanel({
  subject,
  onApplied,
}: {
  subject: AssistantSubject;
  /**
   * Called with the subject's new body after a proposal is accepted and has
   * actually landed.
   *
   * Not optional politeness: the description editor above this panel owns its
   * content once mounted and never reseeds, so after an accept it is holding
   * the *old* body. The next character typed into it autosaves that old body
   * back over the change that was just applied. The host uses this to reseed
   * it, with the text the write returned rather than a refetch, so there is no
   * window where the editor holds something stale.
   */
  onApplied?: (body: string) => void;
}) {
  const orgHref = useOrgPath();

  // The conversation itself, and every command that changes it. Everything
  // below this line reads the same for an item and for a release.
  const {
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
    pending,
    ask,
    onRunSkill,
    stopSkill,
    cancel,
    onResolve,
  } = useConversation(subject, onApplied);

  /** What this panel calls the thing it is about, in copy shown to a person. */
  const noun = subjectNoun(subject);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const question = draft.trim();
    if (!question) return;
    ask(question);
  }

  const [showContext, setShowContext] = useState(false);
  /** Whether the whole thread is shown, rather than just the recent tail. */
  const [showAll, setShowAll] = useState(false);
  const streamBoxRef = useRef<HTMLDivElement | null>(null);

  // Keep the newest text in view inside the capped box. Scrolling the box
  // rather than the page is the point: the page staying still is what keeps
  // Stop where the user last saw it.
  useEffect(() => {
    const box = streamBoxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [streaming]);

  const settingsHref = orgHref("/settings/integrations?tab=model");
  // A key can outlive the skill it named: the workspace deleted it, or an admin
  // switched it off while this thread was mid-grilling. Resolving rather than
  // trusting the key means the chip disappears instead of naming nothing.
  const running = skills.find((s) => s.key === activeSkillKey) ?? null;
  const { visible, hidden } = threadWindow(messages ?? [], showAll);
  // A proposal arriving mid-stream is rendered as a note rather than as raw
  // Markdown: the marker lines and a half-written spec body scrolling past look
  // like the assistant has lost the thread.
  const streamingProse =
    streaming !== null && proposalStarted(streaming)
      ? parseAnswer(streaming).prose
      : streaming;
  const streamingProposal = streaming !== null && proposalStarted(streaming);

  if (loadError) {
    return <p className="text-xs text-destructive">{loadError}</p>;
  }

  if (messages === null) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-2/3" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {!modelConnected ? (
        <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          <p>
            No model is connected for this workspace, so there is nothing to ask
            yet. The assistant runs on a model you bring, so none of your item
            content goes anywhere until an admin connects one.
          </p>
          <Link
            href={settingsHref}
            className="mt-2 inline-block text-link hover:underline"
          >
            Connect a model
          </Link>
        </div>
      ) : null}

      {messages.length === 0 && !pending ? (
        <p className="text-xs text-muted-foreground">
          Nothing asked about this item yet. Anyone who can see it can read this
          conversation.
        </p>
      ) : (
        <ul className="space-y-4">
          {hidden > 0 ? (
            <li>
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="text-xs text-muted-foreground underline-offset-2 hover:underline"
              >
                Show {hidden} earlier {hidden === 1 ? "message" : "messages"}
              </button>
            </li>
          ) : null}
          {visible.map((m, i) => (
            <AssistantTurn
              key={m.id}
              message={m}
              // The newest settled turn is never clamped, and neither is
              // anything while an answer is streaming in below it, since the
              // thing being read is then the one at the bottom.
              collapsible={i < visible.length - 1 || pending}
              itemBody={itemBody}
              canEdit={canEdit}
              busy={resolving === m.id}
              onResolve={(action, body) => onResolve(m.id, action, body)}
            />
          ))}
          {/* The turn in flight. Rendered inside the same list as the settled
              ones so the answer appears where it will finally live, rather
              than jumping position when it completes. */}
          {pending ? (
            <li className="space-y-1" aria-live="polite">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Assistant</span>
                <span>{streaming ? "answering…" : "thinking…"}</span>
              </div>
              {streaming ? (
                // Capped and scrolled internally, so the answer grows *inside*
                // this box instead of pushing everything below it down the
                // page. Without that the composer and the Stop button slide
                // away from under the cursor while the text arrives, which
                // makes Stop almost impossible to hit on a long answer - found
                // by trying to hit it. Released to full height once the turn
                // settles, so reading it back is not confined to a small box.
                <div
                  ref={streamBoxRef}
                  className="max-h-72 overflow-y-auto rounded border border-border/60 p-2 prose prose-sm prose-neutral max-w-none dark:prose-invert"
                >
                  <ReactMarkdown>{streamingProse ?? ""}</ReactMarkdown>
                </div>
              ) : (
                <Skeleton className="h-4 w-2/3" />
              )}
              {/* Deliberately not the diff yet. A diff recomputed on every
                  token flickers, and half a proposed body diffs as "the rest
                  of the spec is being deleted", which is alarming and untrue.
                  The change is shown once there is a whole one to show. */}
              {streamingProposal ? (
                <p className="text-xs text-muted-foreground">
                  Drafting a proposed change to the description…
                </p>
              ) : null}
            </li>
          ) : null}
        </ul>
      )}

      {modelConnected ? (
        <form onSubmit={onSubmit} className="space-y-2">
          {/* Above the composer, because a skill is a way of starting rather
              than a thing you do to a question you have already typed. The most
              valuable thing here is the one nobody thinks to type. */}
          {skills.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              {skills.map((skill) => (
                <Button
                  key={skill.key}
                  type="button"
                  size="sm"
                  variant={
                    skill.key === activeSkillKey ? "secondary" : "outline"
                  }
                  disabled={pending}
                  title={skill.description || undefined}
                  onClick={() => onRunSkill(skill)}
                >
                  {skill.name}
                </Button>
              ))}
            </div>
          ) : null}

          {/* What is running, and how to stop it. Without this the stickiness
              is invisible: someone runs "Grill me", answers a few questions,
              asks something unrelated three days later and gets interrogated
              about it with nothing on screen explaining why. */}
          {running ? (
            <p className="text-xs text-muted-foreground">
              Running{" "}
              <span className="font-medium text-foreground">
                {running.name}
              </span>
              , so your replies continue it.{" "}
              <button
                type="button"
                onClick={stopSkill}
                className="text-link underline-offset-2 hover:underline"
              >
                Stop
              </button>
            </p>
          ) : null}

          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={
              running ? `Answer, or ask anything…` : `Ask about this ${noun}…`
            }
            rows={3}
            disabled={pending}
          />
          <div className="flex items-center gap-2">
            {/* Stop replaces Ask rather than sitting beside it: while an answer
                is arriving there is exactly one thing to do, and a disabled
                Ask next to a live Stop is two controls saying one thing. */}
            {pending ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={cancel}
              >
                Stop
              </Button>
            ) : (
              <Button type="submit" size="sm" disabled={!draft.trim()}>
                Ask
              </Button>
            )}
            <p className="text-xs text-muted-foreground">
              {pending
                ? "Stopping keeps nothing: the answer is only saved once it finishes."
                : canPropose
                  ? "Runs on the model this workspace connected. Ask it to rewrite part of the description and it will propose a change for you to review."
                  : canEdit
                    ? // The one case worth explaining rather than leaving as a
                      // silent absence: the assistant is perfectly willing and
                      // is being held back, and nothing on screen would say so.
                      "Runs on the model this workspace connected. This description is too long to send whole, so the assistant can suggest wording but cannot propose an edit to it."
                    : "Runs on the model this workspace connected."}
            </p>
          </div>
        </form>
      ) : null}

      {/* A refused accept, kept out of the model-failure panel above because it
          is a different kind of problem with a different fix: nothing was spent
          and nothing about the model connection is wrong. */}
      {proposalError ? (
        <div className="rounded-md border border-warning/50 bg-warning/5 p-3 text-sm">
          <p>{proposalError}</p>
        </div>
      ) : null}

      {failure ? (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm">
          <p className="text-destructive">{failure.text}</p>
          {failure.settingsLink ? (
            <Link
              href={settingsHref}
              className="mt-1 inline-block text-link hover:underline"
            >
              Check the model connection
            </Link>
          ) : null}
        </div>
      ) : null}

      {/* The disclosure. Built from the same assembler the request is built
          from, so it cannot describe a payload other than the one that is
          sent. Collapsed, because it is a question people ask once. */}
      {context.length > 0 ? (
        <div className="text-xs">
          <button
            type="button"
            onClick={() => setShowContext((v) => !v)}
            aria-expanded={showContext}
            className="text-muted-foreground underline-offset-2 hover:underline"
          >
            {showContext ? "Hide" : "Show"} what is sent about this {noun}
          </button>
          {showContext ? (
            <div className="mt-2 space-y-2 rounded-md border bg-muted/40 p-3">
              <p className="text-muted-foreground">
                Each question sends the fields below, plus this conversation, to
                the endpoint this workspace connected. Nothing else about your
                workspace is sent: no other items, no member names, no settings.
              </p>
              {/* The other half of "should I ask this". A customer paying their
                  own provider is normally told what leaves their workspace and
                  never what it costs, and the figure grows with the thread,
                  which is the part nobody expects. */}
              {estimate > 0 ? (
                <p className="text-muted-foreground">
                  That is about {formatTokenEstimate(estimate)} tokens per
                  question, and it grows as this conversation does. Your
                  provider bills you for them.
                </p>
              ) : null}
              <ul className="space-y-1">
                {context.map((f) => (
                  <li key={f.label}>
                    <span className="font-medium">{f.label}</span>
                    {f.truncated ? (
                      <span className="text-muted-foreground">
                        {" "}
                        (shortened to fit)
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
