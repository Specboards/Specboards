"use client";

import { Bot, Square, User } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { cancelRun, steerRun, type RunView } from "@/lib/api-client/runs";
import { memberLabels } from "@/lib/member-label";
import type { WorkspaceMember } from "@/lib/workspace";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/**
 * What agents have done to this item, and the two levers over one still going.
 *
 * ── Why this is on the card and not in a console ──────────────────────────
 * The question is "what has been done to THIS", and it is asked by the person
 * who owns the item, in the place they already are. A separate agent-activity
 * screen answers a different question ("what are my agents up to") for a
 * different reader, and the two should not be the same surface.
 *
 * ── What "Ask to stop" means, and why it does not say "Cancel" ────────────
 * There is no channel to a connected agent. Stopping marks the run and the
 * agent finds out the next time it reports, so a well-behaved one winds up
 * and a badly behaved one carries on through the ordinary tool surface. A
 * button labelled "Cancel" would promise something we cannot do. What it does
 * guarantee is that the run's record stops here and that anything the agent
 * proposes afterwards still has to be applied by a person, which is the part
 * that actually protects the work.
 */

/** Absolute, like the history section: this is read to establish when. */
function when(iso: string | null): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

const ACTIVE = new Set(["queued", "running", "awaiting_input"]);

/**
 * How a status reads to somebody who does not work here.
 *
 * `awaiting_input` is the one worth spelling out: "Awaiting input" describes
 * the run's state, and "Waiting for you" says whose move it is, which is the
 * thing the reader needs to act on.
 */
const LABEL: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  awaiting_input: "Waiting for you",
  succeeded: "Finished",
  failed: "Failed",
  cancelled: "Stopped",
};

const TONE: Record<string, "default" | "secondary" | "destructive" | "outline"> =
  {
    queued: "outline",
    running: "default",
    awaiting_input: "outline",
    succeeded: "secondary",
    failed: "destructive",
    cancelled: "outline",
  };

/** Why the run started, as a phrase rather than a key. */
const TRIGGER: Record<string, string> = {
  assignment: "on assignment",
  mention: "when mentioned",
  schedule: "on a schedule",
  event: "on an event",
  manual: "asked by hand",
};

export function AgentRuns({
  runs,
  members,
  canEdit,
}: {
  runs: RunView[];
  members: WorkspaceMember[];
  /** Whether this reader may act on a run. Read-only members see the record. */
  canEdit: boolean;
}) {
  const nameOf = memberLabels(members);
  return (
    <ul className="flex flex-col gap-3">
      {runs.map((run) => {
        const member = members.find((m) => m.userId === run.agentId);
        return (
          <li key={run.id}>
            <Run
              run={run}
              who={member ? nameOf(member) : "An agent"}
              canEdit={canEdit}
            />
          </li>
        );
      })}
    </ul>
  );
}

function Run({
  run,
  who,
  canEdit,
}: {
  run: RunView;
  who: string;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();

  const active = ACTIVE.has(run.status);

  function act(fn: () => Promise<unknown>) {
    setError(null);
    startTransition(async () => {
      try {
        await fn();
        setNoting(false);
        setNote("");
        // The run arrives with the page, so the page is what has to re-read.
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong.");
      }
    });
  }

  return (
    <div className="rounded-md border border-border/60 p-3">
      <div className="flex flex-wrap items-center gap-2">
        {/* Says non-human at a glance. An agent's run and a person's run look
            the same otherwise, and which it was changes how the reader reads
            everything under it. */}
        {run.actorType === "agent" ? (
          <Bot className="size-4 text-muted-foreground" aria-hidden />
        ) : (
          <User className="size-4 text-muted-foreground" aria-hidden />
        )}
        <span className="text-sm font-medium">{who}</span>
        <Badge variant={TONE[run.status] ?? "outline"} size="sm">
          {LABEL[run.status] ?? run.status}
        </Badge>
        <span className="text-2xs text-muted-foreground">
          {TRIGGER[run.trigger] ?? run.trigger}
          {run.startedAt ? ` · ${when(run.startedAt)}` : ""}
        </span>
      </div>

      {/* The agent's own sentence. Nothing generated: if it did not say what
          it was doing, we do not invent it. */}
      {run.summary ? <p className="mt-2 text-sm">{run.summary}</p> : null}

      {run.error ? (
        <p className="mt-2 text-sm text-destructive">{run.error}</p>
      ) : null}

      {run.steer && active ? (
        <p className="mt-2 text-2xs text-muted-foreground">
          A note is waiting for this agent to pick up: {run.steer}
        </p>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-3 text-2xs text-muted-foreground">
        {/* Tokens, not money: this product measures tokens, and inventing a
            price from them would be a number nobody could reconcile. Absent
            entirely for an agent spending its own key, because "0" would
            claim we know it was free. */}
        {run.tokens ? (
          <span>
            {(run.tokens.prompt + run.tokens.completion).toLocaleString()} tokens
          </span>
        ) : null}
        {run.finishedAt ? <span>Ended {when(run.finishedAt)}</span> : null}
      </div>

      {run.trace.length > 0 ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-2xs text-muted-foreground hover:text-foreground">
            {run.trace.length} step{run.trace.length === 1 ? "" : "s"}
          </summary>
          <ol className="mt-2 flex flex-col gap-1 border-l border-border/60 pl-3">
            {run.trace.map((step, i) => (
              <li key={`${step.at}-${i}`} className="text-2xs">
                <span className="text-foreground">{step.label}</span>
                {step.detail ? (
                  <span className="text-muted-foreground"> {step.detail}</span>
                ) : null}
              </li>
            ))}
          </ol>
        </details>
      ) : null}

      {active && canEdit ? (
        <div className="mt-3 flex flex-col gap-2">
          {noting ? (
            <>
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="What should it do differently?"
                rows={2}
                aria-label="Note for this agent"
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={pending || note.trim() === ""}
                  onClick={() => act(() => steerRun(run.id, note.trim()))}
                >
                  Send note
                </Button>
                {/* Collapses without saving, per the add-as-affordance rule. */}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => {
                    setNoting(false);
                    setNote("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </>
          ) : (
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => setNoting(true)}
              >
                Leave a note
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => act(() => cancelRun(run.id))}
              >
                <Square aria-hidden />
                Ask to stop
              </Button>
            </div>
          )}
          {/* Said once, here, rather than in a tooltip nobody opens: the
              button promises less than its name suggests and the reader
              should know that before pressing it, not after. */}
          <p className="text-2xs text-muted-foreground">
            Stopping marks the run and tells the agent next time it reports.
          </p>
        </div>
      ) : null}

      {error ? (
        <p className="mt-2 text-2xs text-destructive">{error}</p>
      ) : null}
    </div>
  );
}
