"use client";

import { Bot, CircleHelp, FileText, Inbox, ListChecks, Tag } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import { decideReview, type ReviewTarget } from "@/lib/api-client/reviews";
import { itemPath, orgProductPath } from "@/lib/org-path";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

/**
 * The review queue: what agents have produced that nobody has decided about.
 *
 * ── Why this is a page and not a tab on notifications ─────────────────────
 * A notification is personal and read once; a review is shared work with a
 * lifecycle. Two people see the same row, one acts on it, and it leaves the
 * queue for both. They also mean opposite things when empty: an empty
 * notification list is the normal resting state, and an empty review queue is
 * the thing you want. A surface where "nothing here" is success should say so
 * rather than reusing a layout that treats it as absence.
 *
 * ── Why a row does not review the change inline ───────────────────────────
 * A proposal is a diff against a document or a change set over an item's
 * fields, and both need the target's own context to judge: the rest of the
 * spec, what stage the item is in, what a status change would fire. The row
 * carries enough to triage (what, where, who, on what evidence) and hands
 * over to the item for the actual reading. Dismiss is offered here because
 * turning something down needs no context the row is missing; Review is a
 * link rather than a button for the same reason Apply is not on the row.
 */

/** A row as the server hands it over. Dates are serialised. */
export interface ReviewRowView {
  id: string;
  kind: "proposal" | "awaiting_run";
  proposalKind?: string;
  targetType: string;
  targetId: string;
  targetRef: string | null;
  targetTitle: string;
  targetLevel: string | null;
  productKey: string | null;
  actorName: string | null;
  runId: string | null;
  evidenceCount: number;
  summary: string | null;
  createdAt: string;
}

/**
 * What each kind of proposal is, in the words a reader would use.
 *
 * Spelled out rather than humanising the key, because "Spec content" is the
 * column and "A rewritten description" is the thing that happened.
 */
const KIND: Record<string, { label: string; icon: typeof FileText }> = {
  spec_content: { label: "Rewritten text", icon: FileText },
  item_metadata: { label: "Field changes", icon: Tag },
  item_batch: { label: "New items", icon: ListChecks },
  doc_draft: { label: "Draft document", icon: FileText },
};

function when(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/**
 * Where a row's target lives, for the Review link.
 *
 * The canonical item permalink carries the level (ADR 0002). The bare
 * `/backlog/{specId}` shape does redirect here, so falling back to it costs
 * a hop rather than a 404 when a row has no level to build with.
 */
function hrefFor(row: ReviewRowView, org: string): string | null {
  if (!row.targetRef || !row.productKey) return null;
  if (row.targetType === "release") {
    return orgProductPath(org, row.productKey, "/roadmap");
  }
  return row.targetLevel
    ? itemPath(org, row.productKey, {
        level: row.targetLevel,
        specId: row.targetRef,
      })
    : orgProductPath(org, row.productKey, `/backlog/${row.targetRef}`);
}

/** The endpoint a dismissal goes through, or null when it cannot be addressed. */
function targetFor(row: ReviewRowView): ReviewTarget | null {
  if (!row.targetRef) return null;
  return row.targetType === "release"
    ? { kind: "release", id: row.targetRef }
    : { kind: "feature", specId: row.targetRef };
}

export function ReviewInbox({
  initial,
  org,
}: {
  initial: ReviewRowView[];
  org: string;
}) {
  const router = useRouter();
  const [rows, setRows] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const counts = useMemo(
    () => ({
      proposals: rows.filter((r) => r.kind === "proposal").length,
      waiting: rows.filter((r) => r.kind === "awaiting_run").length,
    }),
    [rows],
  );

  async function dismiss(row: ReviewRowView) {
    const target = targetFor(row);
    if (!target) return;
    setBusy(row.id);
    setError(null);
    try {
      await decideReview(target, row.id, "reject");
      // Dropped locally rather than refetched, so the list does not jump
      // under the reader's cursor while they work down it. The server
      // refresh below reconciles anything else that changed meanwhile.
      setRows((current) => current.filter((r) => r.id !== row.id));
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not go through.");
    } finally {
      setBusy(null);
    }
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-10 text-center">
        <Inbox className="mx-auto mb-3 size-6 text-muted-foreground" aria-hidden />
        <p className="font-medium">Nothing waiting on you</p>
        <p className="mt-1 text-sm text-muted-foreground">
          When an agent drafts a change or stops to ask a question, it appears
          here for somebody to decide about.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground" data-testid="review-summary">
        {counts.proposals} {counts.proposals === 1 ? "change" : "changes"} to
        review
        {counts.waiting > 0 &&
          `, ${counts.waiting} ${counts.waiting === 1 ? "run" : "runs"} waiting for an answer`}
        .
      </p>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <ul className="space-y-3">
        {rows.map((row) => {
          const meta = row.proposalKind ? KIND[row.proposalKind] : undefined;
          const Icon =
            row.kind === "awaiting_run" ? CircleHelp : (meta?.icon ?? FileText);
          const href = hrefFor(row, org);
          return (
            <li key={row.id}>
              <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="font-medium">{row.targetTitle}</span>
                    <Badge variant="secondary">
                      {row.kind === "awaiting_run"
                        ? "Waiting for an answer"
                        : (meta?.label ?? "A change")}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    <Bot className="mr-1 inline size-3.5 align-[-2px]" aria-hidden />
                    {row.actorName ?? "An agent"} &middot; {when(row.createdAt)}
                    {row.evidenceCount > 0 &&
                      ` · ${row.evidenceCount} ${row.evidenceCount === 1 ? "source" : "sources"}`}
                  </p>
                  {row.summary && (
                    <p className="text-sm">{row.summary}</p>
                  )}
                </div>

                <div className="flex shrink-0 gap-2">
                  {href ? (
                    <Link
                      href={href}
                      className={buttonVariants({
                        size: "sm",
                        variant: "secondary",
                      })}
                    >
                      Review
                    </Link>
                  ) : (
                    // The target is gone or unreadable. Saying so beats a
                    // link that lands on a 404.
                    <span className="self-center text-sm text-muted-foreground">
                      Target unavailable
                    </span>
                  )}
                  {row.kind === "proposal" && targetFor(row) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy === row.id}
                      onClick={() => void dismiss(row)}
                    >
                      {busy === row.id ? "Dismissing…" : "Dismiss"}
                    </Button>
                  )}
                </div>
              </Card>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
