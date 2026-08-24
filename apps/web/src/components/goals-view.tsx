"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Target } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { GoalProgressPair } from "@/components/goal-progress";
import { StatusDot } from "@/components/status-dot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  AuthRequiredError,
  createGoal,
  createKeyResult,
  deleteGoal,
  deleteKeyResult,
  setGoalLink,
  updateGoal,
  updateKeyResult,
} from "@/lib/api-client";
import { goalStatusLabel, goalStatusTone } from "@/lib/goal-status";
import { orgProductPath } from "@/lib/org-path";
import {
  buildGoalTree,
  flattenGoalTree,
  formatMetric,
  metricKindLabel,
  DEFAULT_NEW_METRIC_KIND,
  GOAL_STATUSES,
  METRIC_KINDS,
  type GoalContribution,
  type GoalRecord,
  type GoalStatus,
  type KeyResultRecord,
  type MetricKind,
} from "@/lib/store/types";
import { cn } from "@/lib/utils";

/** An item the link picker can attach to a goal. */
export interface GoalLinkCandidate {
  specId: string;
  title: string;
  level: string;
  productId: string | null;
}

/**
 * Indent per generation, and the depth past which indenting stops.
 *
 * Capped because the cards keep their full width at every level: the indent is
 * there to show the ladder, and a deep goal tree that kept indenting would
 * squeeze its own contents off the right edge to say something the connecting
 * rule already says.
 */
const INDENT_REM = 1.5;
const MAX_INDENT_DEPTH = 3;

/**
 * The Goals page: objectives, their key results, and the work laddering up.
 *
 * The two progress numbers on each goal stay separate throughout, because they
 * answer different questions. Outcome progress is the mean of the key results:
 * did the metric move? Delivery progress is the share of linked work that is
 * done: did we ship what we thought would move it? A goal at 100% delivery and
 * 0% outcome is the single most useful thing this page can show you, and
 * averaging the two into one bar would erase it.
 */
export function GoalsView({
  goals,
  contributionsByGoal,
  linkCandidates,
  canEdit,
  org,
  productSlug,
  levels,
  defaultProductId,
  products,
  goalTitles,
}: {
  goals: GoalRecord[];
  contributionsByGoal: Record<string, GoalContribution[]>;
  linkCandidates: GoalLinkCandidate[];
  canEdit: boolean;
  org: string;
  productSlug: string;
  levels: { key: string; label: string }[];
  defaultProductId: string | null;
  products: { id: string; name: string }[];
  /**
   * Every readable goal's title by id, including goals outside this scope. A
   * goal here can name a parent that is not in `goals` (another product's), and
   * both the "under X" note and the parent picker have to be able to say which.
   */
  goalTitles: Record<string, string>;
}) {
  const [creating, setCreating] = useState(false);

  // Goals nest, so they are drawn as a tree rather than a flat list: a company
  // objective and the product goals under it read as one ladder. The rows are
  // flattened with their depth instead of nested in the DOM, so a third-level
  // goal's card is the same width as a top-level one (see INDENT_REM).
  const rows = flattenGoalTree(buildGoalTree(goals));

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">Goals</h1>
          <p className="text-sm text-muted-foreground">
            What you are trying to achieve, and the work laddering up to it.
            Each goal shows two numbers that are deliberately kept apart:
            whether the metric moved, and whether the work shipped. Seeing them
            diverge is the point.
          </p>
        </div>
        {canEdit && !creating ? (
          <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
            New goal
          </Button>
        ) : null}
      </div>

      {creating ? (
        <GoalForm
          mode="create"
          defaultProductId={defaultProductId}
          products={products}
          goals={goals}
          goalTitles={goalTitles}
          onDone={() => setCreating(false)}
        />
      ) : null}

      {goals.length === 0 && !creating ? (
        <EmptyState
          className="mt-8"
          title="No goals yet"
          description={
            canEdit
              ? "A goal states an outcome you want and how you will know you got it. Write one, give it a key result or two, then link the work that should move it. Strategy documents stay where they are; this is the part with a number on it."
              : "A goal states an outcome the team wants and how they will know they got it. Once someone with edit access writes one, it appears here."
          }
          action={
            canEdit ? (
              <Button size="sm" onClick={() => setCreating(true)}>
                New goal
              </Button>
            ) : null
          }
        />
      ) : null}

      <div className="space-y-3">
        {rows.map(({ goal, depth, orphaned }) => (
          <div
            key={goal.id}
            style={{
              marginLeft: `${Math.min(depth, MAX_INDENT_DEPTH) * INDENT_REM}rem`,
            }}
            // A rule down the left edge carries the ladder past the indent cap,
            // where two generations sit at the same offset.
            className={cn(depth > 0 && "border-l-2 border-border/70 pl-3")}
          >
            <GoalCard
              goal={goal}
              goals={goals}
              goalTitles={goalTitles}
              orphaned={orphaned}
              contributions={contributionsByGoal[goal.id] ?? []}
              linkCandidates={linkCandidates}
              canEdit={canEdit}
              org={org}
              productSlug={productSlug}
              levels={levels}
              products={products}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

function GoalCard({
  goal,
  goals,
  goalTitles,
  orphaned,
  contributions,
  linkCandidates,
  canEdit,
  org,
  productSlug,
  levels,
  products,
}: {
  goal: GoalRecord;
  goals: GoalRecord[];
  goalTitles: Record<string, string>;
  /** Drawn at the top level despite having a parent, because the parent is out
   * of this scope. The card then has to name it in words. */
  orphaned: boolean;
  contributions: GoalContribution[];
  linkCandidates: GoalLinkCandidate[];
  canEdit: boolean;
  org: string;
  productSlug: string;
  levels: { key: string; label: string }[];
  products: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [addingKr, setAddingKr] = useState(false);
  const [linking, setLinking] = useState(false);
  const [pending, startTransition] = useTransition();

  /**
   * Swap a key result with its neighbour by exchanging their `position`
   * values: two PATCHes rather than one call to a reorder endpoint. The API
   * already accepts `position`, so this costs no server work, and these lists
   * are three to five rows.
   *
   * What that trades away, stated because it diverges from `replaceSkills`,
   * which takes the whole ordered set precisely so a client cannot produce an
   * order nobody can reproduce: the two writes are not atomic. Positions start
   * as a clean 0..n-1 permutation and a swap preserves that, so only a partial
   * failure breaks it, and the read side orders by `(position, createdAt)`,
   * which makes a duplicated position a stable order rather than an arbitrary
   * one. The failure mode is "the move did not take", not "the list
   * scrambled", and it is reported rather than left to be noticed.
   */
  function moveKeyResult(kr: KeyResultRecord, direction: -1 | 1) {
    const ordered = goal.keyResults;
    const from = ordered.findIndex((k) => k.id === kr.id);
    const neighbour = ordered[from + direction];
    if (!neighbour) return;
    startTransition(async () => {
      try {
        await updateKeyResult(kr.id, { position: neighbour.position });
        await updateKeyResult(neighbour.id, { position: kr.position });
        router.refresh();
      } catch (err) {
        handleError(err, router);
      }
    });
  }

  const levelLabel = new Map(levels.map((l) => [l.key, l.label]));
  // Nesting states the parent for every goal drawn under one, so this only
  // covers the case nesting cannot: a parent outside the current scope, whose
  // title has to come from the workspace-wide map rather than these rows.
  const parentTitle =
    orphaned && goal.parentGoalId ? goalTitles[goal.parentGoalId] ?? null : null;

  function onDelete() {
    if (
      !window.confirm(
        `Delete "${goal.title}"? Its key results go with it and its links are cleared. The ${goal.linkedItemCount} linked work item${goal.linkedItemCount === 1 ? "" : "s"} are not deleted.`,
      )
    )
      return;
    startTransition(async () => {
      try {
        await deleteGoal(goal.id);
        toast.success("Goal deleted");
        router.refresh();
      } catch (err) {
        handleError(err, router);
      }
    });
  }

  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Target className="size-4 text-muted-foreground" aria-hidden />
            <h2 className="font-medium">{goal.title}</h2>
            <Badge
              variant="outline"
              size="sm"
              className={goalStatusTone(goal.status)}
            >
              {goalStatusLabel(goal.status)}
            </Badge>
            {goal.productId === null ? (
              <Badge variant="outline" size="sm">
                Org-wide
              </Badge>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            {goal.periodStart || goal.periodEnd ? (
              <>
                {goal.periodStart ?? "…"} to {goal.periodEnd ?? "…"}
              </>
            ) : (
              "No period set"
            )}
            {parentTitle ? <> · under {parentTitle}</> : null}
          </p>
        </div>
        {canEdit ? (
          <div className="flex flex-wrap items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setEditing((v) => !v)}
            >
              {editing ? "Cancel" : "Edit"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={onDelete}
              disabled={pending}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              Delete
            </Button>
          </div>
        ) : null}
      </div>

      {goal.description ? (
        <p className="whitespace-pre-wrap text-sm text-muted-foreground">
          {goal.description}
        </p>
      ) : null}

      {editing ? (
        <GoalForm
          mode="edit"
          goal={goal}
          goals={goals}
          goalTitles={goalTitles}
          defaultProductId={goal.productId}
          products={products}
          onDone={() => setEditing(false)}
        />
      ) : null}

      {/* The two figures, side by side and labelled, never merged. */}
      <div className="border-t pt-3">
        <GoalProgressPair goal={goal} />
      </div>

      <div className="space-y-2 border-t pt-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Key results
          </h3>
          {canEdit && !addingKr ? (
            <Button size="inline" variant="link" onClick={() => setAddingKr(true)}>
              Add key result
            </Button>
          ) : null}
        </div>
        {goal.keyResults.length === 0 && !addingKr ? (
          <p className="text-sm text-muted-foreground">
            None yet. A goal without one is a statement of intent; add a
            measurement to make it checkable.
          </p>
        ) : null}
        {goal.keyResults.map((kr, i) => (
          <KeyResultRow
            key={kr.id}
            kr={kr}
            canEdit={canEdit}
            onMove={moveKeyResult}
            canMoveUp={i > 0}
            canMoveDown={i < goal.keyResults.length - 1}
          />
        ))}
        {addingKr ? (
          <KeyResultForm goalId={goal.id} onDone={() => setAddingKr(false)} />
        ) : null}
      </div>

      <div className="space-y-2 border-t pt-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Contributing work
          </h3>
          {canEdit && !linking ? (
            <Button size="inline" variant="link" onClick={() => setLinking(true)}>
              Link work
            </Button>
          ) : null}
        </div>
        {contributions.length === 0 && !linking ? (
          <p className="text-sm text-muted-foreground">
            Nothing linked yet. Any item at any level can ladder up to this
            goal, including work in another product.
          </p>
        ) : null}
        <ul className="space-y-1">
          {contributions.map((item) => (
            <li key={item.specId} className="flex items-center gap-2 text-sm">
              <StatusDot status={item.status} />
              <Link
                href={orgProductPath(
                  org,
                  productSlug,
                  `/backlog/${item.level}/${item.specId}`,
                )}
                className="flex-1 truncate text-link hover:underline"
                title={item.title}
              >
                {item.title}
              </Link>
              <span className="shrink-0 text-2xs uppercase tracking-wide text-muted-foreground">
                {levelLabel.get(item.level) ?? item.level}
              </span>
              {canEdit ? (
                <UnlinkButton goalId={goal.id} specId={item.specId} />
              ) : null}
            </li>
          ))}
        </ul>
        {linking ? (
          <LinkForm
            goalId={goal.id}
            candidates={linkCandidates.filter(
              (c) => !contributions.some((x) => x.specId === c.specId),
            )}
            levels={levels}
            onDone={() => setLinking(false)}
          />
        ) : null}
      </div>
    </Card>
  );
}

function KeyResultRow({
  kr,
  canEdit,
  onMove,
  canMoveUp,
  canMoveDown,
}: {
  kr: KeyResultRecord;
  canEdit: boolean;
  /** Swap this key result with its neighbour in that direction. */
  onMove: (kr: KeyResultRecord, direction: -1 | 1) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState(String(kr.currentValue));
  const [editing, setEditing] = useState(false);

  // An "Edit" affordance that expands in place and collapses on save or
  // cancel, rather than a row of always-open inputs.
  if (editing) {
    return (
      <KeyResultForm
        goalId={kr.goalId}
        kr={kr}
        onDone={() => setEditing(false)}
      />
    );
  }

  function commitValue(next: number) {
    if (!Number.isFinite(next) || next === kr.currentValue) {
      setValue(String(kr.currentValue));
      return;
    }
    setValue(String(next));
    startTransition(async () => {
      try {
        await updateKeyResult(kr.id, { currentValue: next });
        router.refresh();
      } catch (err) {
        setValue(String(kr.currentValue));
        handleError(err, router);
      }
    });
  }

  /** The free-text path: parse what was typed, then commit it. */
  function commit() {
    commitValue(Number(value));
  }

  function onRemove() {
    if (!window.confirm(`Remove the key result "${kr.title}"?`)) return;
    startTransition(async () => {
      try {
        await deleteKeyResult(kr.id);
        router.refresh();
      } catch (err) {
        handleError(err, router);
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="min-w-0 flex-1 truncate" title={kr.title}>
        {kr.title}
      </span>
      {/* A yes-no key result has no span to show: its target is always yes,
          so "No → Yes" would be a caption saying what the kind already says. */}
      {kr.metricKind === "boolean" ? null : (
        <span className="shrink-0 text-xs text-muted-foreground">
          {formatMetric(kr.startValue, kr.metricKind)} →{" "}
          {formatMetric(kr.targetValue, kr.metricKind)}
        </span>
      )}
      {canEdit && kr.metricKind === "boolean" ? (
        <Select
          aria-label={`Current value for ${kr.title}`}
          className="h-7 w-20 shrink-0"
          value={Number(value) ? "1" : "0"}
          disabled={pending}
          onChange={(e) => commitValue(Number(e.target.value))}
        >
          <option value="0">No</option>
          <option value="1">Yes</option>
        </Select>
      ) : canEdit ? (
        <Input
          aria-label={`Current value for ${kr.title}`}
          className="h-7 w-20 shrink-0"
          value={value}
          disabled={pending}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
      ) : (
        <span className="shrink-0 text-xs">
          {formatMetric(kr.currentValue, kr.metricKind)}
        </span>
      )}
      <span
        className={cn(
          "w-10 shrink-0 text-right text-xs font-medium",
          kr.progress === null && "text-muted-foreground",
        )}
      >
        {kr.progress === null ? "—" : `${kr.progress}%`}
      </span>
      {canEdit ? (
        <>
          {/* Buttons rather than a drag surface: these lists are three to five
              rows, and buttons are keyboard-operable without extra work. Each
              is labelled with the key result it moves, since "Move up" alone
              tells a screen reader nothing about which row it is on. */}
          <Button
            size="inline"
            variant="link"
            aria-label={`Move ${kr.title} up`}
            onClick={() => onMove(kr, -1)}
            disabled={pending || !canMoveUp}
          >
            ↑
          </Button>
          <Button
            size="inline"
            variant="link"
            aria-label={`Move ${kr.title} down`}
            onClick={() => onMove(kr, 1)}
            disabled={pending || !canMoveDown}
          >
            ↓
          </Button>
          <Button
            size="inline"
            variant="link"
            onClick={() => setEditing(true)}
            disabled={pending}
          >
            Edit
          </Button>
          <Button
            size="inline"
            variant="link"
            onClick={onRemove}
            disabled={pending}
            className="text-destructive"
          >
            Remove
          </Button>
        </>
      ) : null}
    </div>
  );
}

/**
 * The key result field set, in both the modes it is used in.
 *
 * One component rather than two because the fields are the same fields: what a
 * key result is does not change between writing it and correcting it, and two
 * copies would have drifted the first time one of them gained a field. Passing
 * `kr` switches it from creating to editing that key result.
 */
function KeyResultForm({
  goalId,
  kr,
  onDone,
}: {
  goalId: string;
  kr?: KeyResultRecord;
  onDone: () => void;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // Which fields are even shown depends on this, so the form has to know it as
  // state rather than read it off the FormData at submit time.
  const [metricKind, setMetricKind] = useState<MetricKind>(
    kr?.metricKind ?? DEFAULT_NEW_METRIC_KIND,
  );
  const isBoolean = metricKind === "boolean";
  const editing = kr !== undefined;

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const title = String(data.get("title") ?? "").trim();
    if (!title) return setError("Give the key result a title.");

    // A yes-no key result carries a start of yes or no and no target at all;
    // the server supplies the target, since it is always "yes".
    const startValue = isBoolean
      ? data.get("startsYes") === "yes"
        ? 1
        : 0
      : Number(data.get("startValue") ?? 0);
    const targetValue = isBoolean ? undefined : Number(data.get("targetValue") ?? 0);

    if (!isBoolean) {
      if (!Number.isFinite(startValue) || !Number.isFinite(targetValue!)) {
        return setError("Start and target must be numbers.");
      }
      if (startValue === targetValue) {
        return setError(
          "The target must differ from the starting value: progress is measured as the distance between them.",
        );
      }
    }
    startTransition(async () => {
      setError(null);
      try {
        if (editing) {
          // Editing sends the target explicitly even for a yes-no key result,
          // because a PATCH is a diff: switching an existing measured key
          // result to yes-no has to move its target too, and omitting the
          // field would leave the old one in place.
          await updateKeyResult(kr.id, {
            title,
            metricKind,
            startValue,
            targetValue: targetValue ?? 1,
          });
        } else {
          await createKeyResult(goalId, {
            title,
            metricKind,
            startValue,
            ...(targetValue === undefined ? {} : { targetValue }),
          });
        }
        onDone();
        router.refresh();
      } catch (err) {
        if (err instanceof AuthRequiredError) return handleError(err, router);
        setError(err instanceof Error ? err.message : "Save failed.");
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-2 rounded-md border p-3">
      <div className="grid gap-2 sm:grid-cols-4">
        <label className="block space-y-1 sm:col-span-2">
          <span className="text-xs font-medium text-muted-foreground">
            Key result
          </span>
          <Input
            name="title"
            className="h-8"
            placeholder="e.g. Weekly actives"
            defaultValue={kr?.title ?? ""}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-muted-foreground">
            Measured as
          </span>
          <Select
            name="metricKind"
            value={metricKind}
            onChange={(e) => setMetricKind(e.target.value as MetricKind)}
            className="h-8"
          >
            {METRIC_KINDS.map((k) => (
              <option key={k} value={k}>
                {metricKindLabel(k)}
              </option>
            ))}
          </Select>
        </label>
        {isBoolean ? (
          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">
              Starts as
            </span>
            <Select
              name="startsYes"
              defaultValue={kr?.startValue ? "yes" : "no"}
              className="h-8"
            >
              <option value="no">No</option>
              <option value="yes">Yes</option>
            </Select>
          </label>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <label className="block space-y-1">
              <span className="text-xs font-medium text-muted-foreground">
                From
              </span>
              <Input
                name="startValue"
                type="number"
                step="any"
                defaultValue={kr?.startValue ?? 0}
                className="h-8"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-muted-foreground">To</span>
              <Input
                name="targetValue"
                type="number"
                step="any"
                defaultValue={kr?.targetValue ?? ""}
                className="h-8"
              />
            </label>
          </div>
        )}
      </div>
      <p className="text-2xs text-muted-foreground">
        {isBoolean
          ? "A yes-no key result is done or it is not, so there is no target to set. Start it as Yes if it was already true when you wrote it."
          : "Progress is the distance travelled from “From” to “To”, so set From to the real baseline. Decreasing metrics work too: From 8, To 3."}
      </p>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending
            ? editing
              ? "Saving…"
              : "Adding…"
            : editing
              ? "Save changes"
              : "Add key result"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function UnlinkButton({ goalId, specId }: { goalId: string; specId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      size="inline"
      variant="link"
      disabled={pending}
      className="shrink-0 text-muted-foreground"
      onClick={() =>
        startTransition(async () => {
          try {
            await setGoalLink(goalId, specId, false);
            router.refresh();
          } catch (err) {
            handleError(err, router);
          }
        })
      }
    >
      Unlink
    </Button>
  );
}

function LinkForm({
  goalId,
  candidates,
  levels,
  onDone,
}: {
  goalId: string;
  candidates: GoalLinkCandidate[];
  levels: { key: string; label: string }[];
  onDone: () => void;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const levelLabel = new Map(levels.map((l) => [l.key, l.label]));

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const specId = String(new FormData(e.currentTarget).get("specId") ?? "");
    if (!specId) return setError("Pick an item to link.");
    startTransition(async () => {
      setError(null);
      try {
        await setGoalLink(goalId, specId, true);
        onDone();
        router.refresh();
      } catch (err) {
        if (err instanceof AuthRequiredError) return handleError(err, router);
        setError(err instanceof Error ? err.message : "Link failed.");
      }
    });
  }

  if (candidates.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Everything in view is already linked.{" "}
        <Button size="inline" variant="link" onClick={onDone}>
          Close
        </Button>
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-2">
      <label className="block min-w-0 flex-1 space-y-1">
        <span className="text-xs font-medium text-muted-foreground">
          Link an item
        </span>
        <Select name="specId" defaultValue="" className="h-8">
          <option value="">Choose an item…</option>
          {candidates.map((c) => (
            <option key={c.specId} value={c.specId}>
              {c.title} ({levelLabel.get(c.level) ?? c.level})
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
      {error ? (
        <p className="w-full text-xs text-destructive">{error}</p>
      ) : null}
    </form>
  );
}

/** Create / edit form. One component for both so the two never drift. */
function GoalForm({
  mode,
  goal,
  goals,
  goalTitles,
  defaultProductId,
  products,
  onDone,
}: {
  mode: "create" | "edit";
  goal?: GoalRecord;
  goals: GoalRecord[];
  goalTitles: Record<string, string>;
  defaultProductId: string | null;
  products: { id: string; name: string }[];
  onDone: () => void;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // A goal cannot be its own parent, nor sit under its own descendant; the
  // server enforces this too, but offering the choice would be misleading.
  const parentOptions: { id: string; title: string }[] = goals
    .filter((g) => g.id !== goal?.id)
    .map((g) => ({ id: g.id, title: g.title }));
  // The current parent may sit outside this scope (another product's goal).
  // It has to be an option, or the select falls back to its first entry and
  // saving quietly detaches the goal from a parent nobody meant to touch.
  if (
    goal?.parentGoalId &&
    !parentOptions.some((g) => g.id === goal.parentGoalId)
  ) {
    parentOptions.unshift({
      id: goal.parentGoalId,
      title: goalTitles[goal.parentGoalId] ?? "Goal outside this view",
    });
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const title = String(data.get("title") ?? "").trim();
    const description = String(data.get("description") ?? "").trim() || null;
    const periodStart = String(data.get("periodStart") ?? "") || null;
    const periodEnd = String(data.get("periodEnd") ?? "") || null;
    const productId = String(data.get("productId") ?? "") || null;
    const parentGoalId = String(data.get("parentGoalId") ?? "") || null;
    const status = String(data.get("status") ?? "on_track") as GoalStatus;
    if (!title) return setError("Title is required.");
    if (periodStart && periodEnd && periodEnd < periodStart) {
      return setError("A goal's period cannot end before it starts.");
    }

    startTransition(async () => {
      setError(null);
      const payload = {
        title,
        description,
        periodStart,
        periodEnd,
        productId,
        parentGoalId,
        status,
      };
      try {
        if (mode === "create") {
          await createGoal(payload);
          toast.success("Goal created");
        } else {
          await updateGoal(goal!.id, payload);
          toast.success("Goal updated");
        }
        onDone();
        router.refresh();
      } catch (err) {
        if (err instanceof AuthRequiredError) return handleError(err, router);
        setError(err instanceof Error ? err.message : "Save failed.");
      }
    });
  }

  return (
    <form
      onSubmit={onSubmit}
      className={cn(
        "space-y-3",
        mode === "create" && "rounded-md border bg-card p-4",
        mode === "edit" && "border-t pt-3",
      )}
    >
      <label className="block space-y-1.5">
        <span className="text-xs font-medium text-muted-foreground">Title</span>
        <Input
          name="title"
          defaultValue={goal?.title ?? ""}
          placeholder="e.g. Teams adopt Specboards for weekly planning"
          className="h-8"
        />
      </label>
      <label className="block space-y-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          Description
        </span>
        <Textarea
          name="description"
          rows={2}
          defaultValue={goal?.description ?? ""}
          placeholder="Why this matters, and what changes if it works."
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        {products.length > 0 ? (
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Product
            </span>
            <Select
              name="productId"
              defaultValue={goal?.productId ?? defaultProductId ?? ""}
              className="h-8"
            >
              <option value="">Org-wide (all products)</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </label>
        ) : null}
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            Status
          </span>
          <Select
            name="status"
            defaultValue={goal?.status ?? "on_track"}
            className="h-8"
          >
            {GOAL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {goalStatusLabel(s)}
              </option>
            ))}
          </Select>
        </label>
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            Period start
          </span>
          <Input
            name="periodStart"
            type="date"
            defaultValue={goal?.periodStart ?? ""}
            className="h-8"
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            Period end
          </span>
          <Input
            name="periodEnd"
            type="date"
            defaultValue={goal?.periodEnd ?? ""}
            className="h-8"
          />
        </label>
        {parentOptions.length > 0 ? (
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Sits under
            </span>
            <Select
              name="parentGoalId"
              defaultValue={goal?.parentGoalId ?? ""}
              className="h-8"
            >
              <option value="">Nothing (top-level goal)</option>
              {parentOptions.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title}
                </option>
              ))}
            </Select>
          </label>
        ) : null}
      </div>
      <p className="text-2xs text-muted-foreground">
        Status is your call on how it is going, not a calculation. A goal can be
        most of the way to its target and still be off track.
      </p>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending
            ? "Saving…"
            : mode === "create"
              ? "Create goal"
              : "Save changes"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Shared error handling: bounce to sign-in on 401, toast otherwise. */
function handleError(err: unknown, router: ReturnType<typeof useRouter>): void {
  if (err instanceof AuthRequiredError) {
    router.push(`/sign-in?from=${encodeURIComponent(window.location.pathname)}`);
    return;
  }
  toast.error(err instanceof Error ? err.message : "Something went wrong.");
}
