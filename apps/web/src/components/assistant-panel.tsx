"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import type { ContextField } from "@/lib/ai/item-context";
import {
  AuthRequiredError,
  askAssistant,
  getAssistantThread,
} from "@/lib/api-client";
import type { AssistantMessageView } from "@/lib/assistant-service";
import { useOrgPath } from "@/lib/use-org";

/**
 * What to tell someone when their own model endpoint refused or could not be
 * reached.
 *
 * Separated from the component and exported so it can be tested directly: the
 * whole reason the adapter returns a `kind` instead of a string is that these
 * five failures need five different actions from the reader, and getting that
 * mapping wrong is invisible until a customer is stuck.
 *
 * `settingsLink` is the discriminator that matters: it is only true where the
 * fix is in Specboards. Sending someone to a settings page when their provider
 * is rate-limiting them wastes their time and teaches them to distrust the
 * message.
 */
export function assistantErrorAdvice(
  kind: string,
  message: string,
): { text: string; settingsLink: boolean } {
  switch (kind) {
    case "not_configured":
      return { text: message, settingsLink: true };
    case "auth":
      return {
        text: "The model endpoint rejected the stored key. It may have been revoked or rotated at the provider.",
        settingsLink: true,
      };
    case "model":
      return {
        text: "The endpoint does not serve the model this workspace is configured to use.",
        settingsLink: true,
      };
    case "quota":
      return {
        text: "The provider says this account is out of credit or has hit a spend cap. Waiting will not clear it; someone has to sort it out with the provider.",
        settingsLink: false,
      };
    case "rate_limit":
      return {
        text: "The provider is rate-limiting or overloaded. Trying again shortly usually works.",
        settingsLink: false,
      };
    case "unreachable":
    case "blocked":
      return { text: message, settingsLink: true };
    default:
      return { text: message, settingsLink: false };
  }
}

/** Compact clock time for a turn, with the full timestamp on hover. */
function turnTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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
 * Streaming is deliberately not here yet. It matters (these are the customer's
 * tokens and a long answer with no feedback feels hung) and it is the next
 * thing to add, but it changes the transport rather than the shape, and the
 * shape is what needed proving end to end first.
 */
export function AssistantPanel({ specId }: { specId: string }) {
  const orgHref = useOrgPath();
  const [messages, setMessages] = useState<AssistantMessageView[] | null>(null);
  const [context, setContext] = useState<ContextField[]>([]);
  const [modelConnected, setModelConnected] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [failure, setFailure] = useState<{
    text: string;
    settingsLink: boolean;
  } | null>(null);
  const [showContext, setShowContext] = useState(false);
  /** The answer as it arrives. Null when no turn is in flight. */
  const [streaming, setStreaming] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const streamBoxRef = useRef<HTMLDivElement | null>(null);
  const pending = streaming !== null;

  // Keep the newest text in view inside the capped box. Scrolling the box
  // rather than the page is the point: the page staying still is what keeps
  // Stop where the user last saw it.
  useEffect(() => {
    const box = streamBoxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [streaming]);

  // Abandon an in-flight answer when the panel goes away (the section is
  // collapsed, or the flyout switches items). Without this the request keeps
  // running and the customer keeps paying for tokens that have nowhere to go.
  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    let active = true;
    setMessages(null);
    setLoadError(null);
    getAssistantThread(specId)
      .then((res) => {
        if (!active) return;
        setMessages(res.messages);
        setContext(res.context);
        setModelConnected(res.modelConnected);
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
  }, [specId]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const question = draft.trim();
    if (!question || pending) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setFailure(null);
    setStreaming("");

    try {
      const outcome = await askAssistant(specId, question, {
        signal: controller.signal,
        onDelta: (text) => setStreaming((prev) => (prev ?? "") + text),
      });

      if (outcome.ok) {
        setMessages((prev) => [...(prev ?? []), ...outcome.turns]);
        setDraft("");
        return;
      }
      // Cancelling is not a failure and gets no error panel. The partial
      // answer is dropped rather than left on screen, because the server
      // stored nothing: showing it would imply a turn that does not exist and
      // would vanish on the next reload anyway.
      if ("cancelled" in outcome) return;

      setFailure(assistantErrorAdvice(outcome.error.kind, outcome.error.message));
      // The draft is deliberately left in the composer. Nothing was persisted,
      // so clearing it would lose the question to a failure the person can
      // often fix and retry in one click.
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        window.location.href = `/sign-in?from=${encodeURIComponent(
          window.location.pathname,
        )}`;
        return;
      }
      setFailure({
        text: err instanceof Error ? err.message : "The assistant failed.",
        settingsLink: false,
      });
    } finally {
      abortRef.current = null;
      setStreaming(null);
    }
  }

  const settingsHref = orgHref("/settings/integrations?tab=model");

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
          {messages.map((m) => (
            <li key={m.id} className="space-y-1">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">
                  {m.role === "assistant"
                    ? "Assistant"
                    : (m.authorName ?? "Someone")}
                </span>
                {m.role === "assistant" && m.model ? (
                  <span className="font-mono">{m.model}</span>
                ) : null}
                <span title={new Date(m.createdAt).toLocaleString()}>
                  {turnTime(m.createdAt)}
                </span>
              </div>
              {m.role === "assistant" ? (
                <div className="prose prose-sm prose-neutral max-w-none dark:prose-invert">
                  <ReactMarkdown>{m.content}</ReactMarkdown>
                </div>
              ) : (
                <p className="whitespace-pre-wrap break-words text-sm">
                  {m.content}
                </p>
              )}
            </li>
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
                  <ReactMarkdown>{streaming}</ReactMarkdown>
                </div>
              ) : (
                <Skeleton className="h-4 w-2/3" />
              )}
            </li>
          ) : null}
        </ul>
      )}

      {modelConnected ? (
        <form onSubmit={onSubmit} className="space-y-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Ask about this item…"
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
                onClick={() => abortRef.current?.abort()}
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
                : "Runs on the model this workspace connected."}
            </p>
          </div>
        </form>
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
            {showContext ? "Hide" : "Show"} what is sent about this item
          </button>
          {showContext ? (
            <div className="mt-2 space-y-2 rounded-md border bg-muted/40 p-3">
              <p className="text-muted-foreground">
                Each question sends the fields below, plus this conversation, to
                the endpoint this workspace connected. Nothing else about your
                workspace is sent: no other items, no member names, no settings.
              </p>
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
