"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/**
 * The vote control on a public idea.
 *
 * ── Three states, because the flow genuinely has three ─────────────────────
 * Idle, "we need your address", and "check your mail". The middle one only
 * appears when the server says so, which it does by answering `needsEmail`
 * rather than by the page guessing: the voter cookie is `httpOnly` precisely so
 * that page scripts cannot read it, which also means they cannot know whether
 * it exists. One round trip buys that, and it is the right trade.
 *
 * ── The count moves optimistically only when the vote is real ──────────────
 * A confirmed voter's click increments immediately, because the server has
 * already recorded it by the time the response arrives. A first-time voter's
 * does NOT, because nothing has been written yet and will not be until they
 * open their mail. Showing a vote that has not happened is the one dishonest
 * thing this component could do, and it is the obvious thing to do by accident.
 */
export function VoteButton({
  orgSlug,
  ideaId,
  count,
}: {
  orgSlug: string;
  ideaId: string;
  count: number;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [votes, setVotes] = useState(count);
  const [voted, setVoted] = useState(false);
  const [stage, setStage] = useState<"idle" | "email" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  function post(email?: string) {
    setError(null);
    start(async () => {
      try {
        const res = await fetch(
          `/api/portal/${encodeURIComponent(orgSlug)}/ideas/${encodeURIComponent(ideaId)}/vote`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(email ? { email } : {}),
          },
        );
        const body = (await res.json().catch(() => null)) as {
          ok?: boolean;
          counted?: boolean;
          alreadyVoted?: boolean;
          needsEmail?: boolean;
          sent?: boolean;
          error?: string;
        } | null;

        if (!res.ok || !body?.ok) {
          setError(body?.error ?? "Something went wrong. Please try again.");
          return;
        }
        if (body.needsEmail) {
          setStage("email");
          return;
        }
        if (body.sent) {
          setStage("sent");
          return;
        }
        // Counted. `alreadyVoted` means this address was already on the idea,
        // so the number does not move; saying "voted" is still true and is what
        // the visitor wants to know.
        setVoted(true);
        if (!body.alreadyVoted) setVotes((n) => n + 1);
        setStage("idle");
        router.refresh();
      } catch {
        setError("We could not reach the server. Please try again.");
      }
    });
  }

  return (
    <div className="flex shrink-0 flex-col items-start gap-2">
      <button
        type="button"
        onClick={() => post()}
        disabled={pending || voted || stage === "sent"}
        aria-label={voted ? "You voted for this idea" : "Vote for this idea"}
        aria-pressed={voted}
        className={
          voted
            ? "flex h-12 w-12 flex-col items-center justify-center rounded-md border border-link bg-link/10 text-link"
            : "flex h-12 w-12 flex-col items-center justify-center rounded-md border transition-colors hover:border-foreground/40 disabled:opacity-60"
        }
      >
        <span aria-hidden className="text-sm font-semibold tabular-nums">
          {votes}
        </span>
        <span aria-hidden className="text-[10px] uppercase text-muted-foreground">
          {votes === 1 ? "vote" : "votes"}
        </span>
      </button>

      {stage === "email" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const value = new FormData(e.currentTarget).get("email");
            post(typeof value === "string" ? value : "");
          }}
          className="flex flex-wrap items-center gap-2"
        >
          <label htmlFor={`vote-email-${ideaId}`} className="sr-only">
            Your email, to confirm your vote
          </label>
          <input
            id={`vote-email-${ideaId}`}
            name="email"
            type="email"
            required
            placeholder="you@example.com"
            className="w-56 rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-60"
          >
            {pending ? "Sending…" : "Confirm by email"}
          </button>
          <button
            type="button"
            onClick={() => setStage("idle")}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
        </form>
      ) : null}

      {stage === "sent" ? (
        // Deliberately does not say the vote is counted, because it is not.
        <p className="text-xs text-muted-foreground">
          Check your email and open the link to count your vote. It works for 30
          minutes.
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
