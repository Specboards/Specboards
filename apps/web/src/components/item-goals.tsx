"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Target } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { AuthRequiredError, setGoalLink } from "@/lib/api-client";
import { useOrgProductPath } from "@/lib/use-org";
import { goalStatusLabel, type ItemGoalRef } from "@/lib/store/types";

/**
 * The goals an item ladders up to, on its detail view: the answer to "why does
 * this work exist".
 *
 * Linking is many-to-many and unconstrained by the hierarchy, so this renders
 * at every level and the picker offers goals from every product. That is not an
 * oversight: a goal being served by work in more than one product is the case
 * the join table exists for, and the single-parent item hierarchy cannot
 * express it.
 *
 * Follows the Add-as-affordance convention: a single "Link a goal" control that
 * expands into the picker and collapses back after a successful save.
 */
export function ItemGoals({
  specId,
  goals,
  linkable,
  canEdit,
}: {
  specId: string;
  goals: ItemGoalRef[];
  linkable: { id: string; title: string }[];
  canEdit: boolean;
}) {
  const [linking, setLinking] = useState(false);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">
          {goals.length > 0
            ? `Laddering up to ${goals.length} goal${goals.length === 1 ? "" : "s"}`
            : "Not linked to a goal yet."}
        </p>
        {canEdit && !linking && linkable.length > 0 ? (
          <Button size="inline" variant="link" onClick={() => setLinking(true)}>
            Link a goal
          </Button>
        ) : null}
      </div>

      {goals.map((goal) => (
        <GoalRow key={goal.goalId} specId={specId} goal={goal} canEdit={canEdit} />
      ))}

      {linking ? (
        <LinkGoalForm
          specId={specId}
          linkable={linkable}
          onDone={() => setLinking(false)}
        />
      ) : null}
    </div>
  );
}

function GoalRow({
  specId,
  goal,
  canEdit,
}: {
  specId: string;
  goal: ItemGoalRef;
  canEdit: boolean;
}) {
  const router = useRouter();
  const orgHref = useOrgProductPath();
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex items-center gap-2 text-sm">
      <Target className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <Link
        href={orgHref("/goals")}
        className="min-w-0 flex-1 truncate text-link hover:underline"
        title={goal.title}
      >
        {goal.title}
      </Link>
      <Badge variant="outline" size="sm" className="shrink-0">
        {goalStatusLabel(goal.status)}
      </Badge>
      {canEdit ? (
        <Button
          size="inline"
          variant="link"
          disabled={pending}
          className="shrink-0 text-muted-foreground"
          onClick={() =>
            startTransition(async () => {
              try {
                await setGoalLink(goal.goalId, specId, false);
                router.refresh();
              } catch (err) {
                if (err instanceof AuthRequiredError) {
                  router.push(
                    `/sign-in?from=${encodeURIComponent(window.location.pathname)}`,
                  );
                  return;
                }
                toast.error(
                  err instanceof Error ? err.message : "Unlink failed.",
                );
              }
            })
          }
        >
          Unlink
        </Button>
      ) : null}
    </div>
  );
}

function LinkGoalForm({
  specId,
  linkable,
  onDone,
}: {
  specId: string;
  linkable: { id: string; title: string }[];
  onDone: () => void;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const goalId = String(new FormData(e.currentTarget).get("goalId") ?? "");
    if (!goalId) return setError("Pick a goal.");
    startTransition(async () => {
      setError(null);
      try {
        await setGoalLink(goalId, specId, true);
        onDone();
        router.refresh();
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          router.push(
            `/sign-in?from=${encodeURIComponent(window.location.pathname)}`,
          );
          return;
        }
        setError(err instanceof Error ? err.message : "Link failed.");
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-2">
      <label className="block min-w-0 flex-1 space-y-1">
        <span className="text-xs font-medium text-muted-foreground">Goal</span>
        <Select name="goalId" defaultValue="" className="h-8">
          <option value="">Choose a goal…</option>
          {linkable.map((g) => (
            <option key={g.id} value={g.id}>
              {g.title}
            </option>
          ))}
        </Select>
      </label>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Linking…" : "Link"}
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={onDone}>
        Cancel
      </Button>
      {error ? <p className="w-full text-xs text-destructive">{error}</p> : null}
    </form>
  );
}
