"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Repeat } from "lucide-react";

import type { StatusWorkflow } from "@specboards/core";

import { EmptyState } from "@/components/empty-state";
import { StatusDot } from "@/components/status-dot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  AuthRequiredError,
  createCycle,
  deleteCycle,
  rolloverCycle,
  updateCycle,
} from "@/lib/api-client";
import { statusLabel } from "@/lib/feature-helpers";
import { orgProductPath } from "@/lib/org-path";
import {
  cycleDaysRemaining,
  cycleStateLabel,
  type CycleRecord,
  type CycleState,
} from "@/lib/store/types";
import { cn } from "@/lib/utils";

/** One item scheduled into a cycle, as the page hands it over. */
export interface CycleItem {
  specId: string;
  title: string;
  status: string;
  level: string;
  cycleId: string;
  productId: string | null;
}

/** Tone per derived state. Active is the one you are working in, so it carries
 * the emphasis; complete recedes. Uses the shared semantic tokens rather than a
 * new palette, so the design system needs no change. */
const STATE_TONE: Record<CycleState, string> = {
  active: "border-primary/40 bg-primary/5",
  upcoming: "border-border",
  complete: "border-border bg-muted/30",
};

const STATE_BADGE: Record<CycleState, "default" | "outline" | "secondary"> = {
  active: "default",
  upcoming: "outline",
  complete: "secondary",
};

/**
 * The Cycles page: the team's time boxes, each with the work scheduled into it.
 *
 * Cycles are a second axis, not a replacement for releases: an item can be in
 * release v1.0 and in Sprint 14 at once, so nothing here touches an item's
 * release. A cycle has no status to set either, which is why there is no status
 * control anywhere on this page: it is upcoming, active, or complete purely
 * from its dates, and moving the dates is what changes it.
 *
 * Creation follows the house convention: a single "New cycle" affordance that
 * expands into the form and collapses back after a successful save.
 */
export function CyclesView({
  cycles,
  items,
  workflow,
  canEdit,
  org,
  productSlug,
  levels,
  defaultProductId,
  products,
}: {
  cycles: CycleRecord[];
  items: CycleItem[];
  workflow: StatusWorkflow;
  canEdit: boolean;
  org: string;
  productSlug: string;
  levels: { key: string; label: string }[];
  /** Product new cycles belong to; null creates a workspace-wide cycle. */
  defaultProductId: string | null;
  products: { id: string; name: string }[];
}) {
  const [creating, setCreating] = useState(false);

  const itemsByCycle = new Map<string, CycleItem[]>();
  for (const item of items) {
    const list = itemsByCycle.get(item.cycleId) ?? [];
    list.push(item);
    itemsByCycle.set(item.cycleId, list);
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">Cycles</h1>
          <p className="text-sm text-muted-foreground">
            The time boxes your team works in. A cycle sits alongside a release,
            not instead of it: an item can be scheduled into both. Each cycle is
            upcoming, active, or complete based on its dates, so nothing has to
            be marked done.
          </p>
        </div>
        {canEdit && !creating ? (
          <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
            New cycle
          </Button>
        ) : null}
      </div>

      {creating ? (
        <CycleForm
          mode="create"
          defaultProductId={defaultProductId}
          products={products}
          onDone={() => setCreating(false)}
        />
      ) : null}

      {cycles.length === 0 && !creating ? (
        <EmptyState
          className="mt-8"
          title="No cycles yet"
          description={
            canEdit
              ? "A cycle is the time box your team plans into, usually a week or two. Create one, then schedule work into it from any item's detail panel. Releases keep answering what ships together; cycles answer what the team is doing now."
              : "A cycle is the time box the team plans into. Once someone with edit access creates one, it appears here."
          }
          action={
            canEdit ? (
              <Button size="sm" onClick={() => setCreating(true)}>
                New cycle
              </Button>
            ) : null
          }
        />
      ) : null}

      <div className="space-y-3">
        {cycles.map((cycle) => (
          <CycleCard
            key={cycle.id}
            cycle={cycle}
            items={itemsByCycle.get(cycle.id) ?? []}
            otherCycles={cycles.filter((c) => c.id !== cycle.id)}
            workflow={workflow}
            canEdit={canEdit}
            org={org}
            productSlug={productSlug}
            levels={levels}
            products={products}
          />
        ))}
      </div>
    </section>
  );
}

function CycleCard({
  cycle,
  items,
  otherCycles,
  workflow,
  canEdit,
  org,
  productSlug,
  levels,
  products,
}: {
  cycle: CycleRecord;
  items: CycleItem[];
  otherCycles: CycleRecord[];
  workflow: StatusWorkflow;
  canEdit: boolean;
  org: string;
  productSlug: string;
  levels: { key: string; label: string }[];
  products: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [rollingOver, setRollingOver] = useState(false);
  const [pending, startTransition] = useTransition();

  const levelLabel = new Map(levels.map((l) => [l.key, l.label]));
  const remaining = cycleDaysRemaining(cycle);
  const unfinished = cycle.itemCount - cycle.doneCount;
  const pct =
    cycle.itemCount === 0
      ? 0
      : Math.round((cycle.doneCount / cycle.itemCount) * 100);

  function onDelete() {
    if (
      !window.confirm(
        `Delete ${cycle.name}? Its ${cycle.itemCount} item${cycle.itemCount === 1 ? "" : "s"} are unscheduled, not deleted, and keep their release.`,
      )
    )
      return;
    startTransition(async () => {
      try {
        await deleteCycle(cycle.id);
        toast.success("Cycle deleted");
        router.refresh();
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          router.push(
            `/sign-in?from=${encodeURIComponent(window.location.pathname)}`,
          );
          return;
        }
        toast.error(err instanceof Error ? err.message : "Delete failed.");
      }
    });
  }

  return (
    <Card className={cn("space-y-3 p-4", STATE_TONE[cycle.state])}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Repeat className="size-4 text-muted-foreground" aria-hidden />
            <h2 className="font-medium">{cycle.name}</h2>
            <Badge variant={STATE_BADGE[cycle.state]} size="sm">
              {cycleStateLabel(cycle.state)}
            </Badge>
            {cycle.productId === null ? (
              <Badge variant="outline" size="sm">
                Workspace-wide
              </Badge>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            {cycle.startDate} to {cycle.endDate}
            {cycle.state === "active" ? (
              <> · {remaining} day{remaining === 1 ? "" : "s"} left</>
            ) : null}
            {cycle.itemCount > 0 ? (
              <>
                {" "}
                · {cycle.doneCount} of {cycle.itemCount} done ({pct}%)
              </>
            ) : null}
          </p>
        </div>
        {canEdit ? (
          <div className="flex flex-wrap items-center gap-1">
            {unfinished > 0 && otherCycles.length > 0 ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setRollingOver((v) => !v)}
              >
                Roll over
              </Button>
            ) : null}
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

      {cycle.notes ? (
        <p className="whitespace-pre-wrap text-sm text-muted-foreground">
          {cycle.notes}
        </p>
      ) : null}

      {editing ? (
        <CycleForm
          mode="edit"
          cycle={cycle}
          defaultProductId={cycle.productId}
          products={products}
          onDone={() => setEditing(false)}
        />
      ) : null}

      {rollingOver ? (
        <RolloverForm
          cycle={cycle}
          unfinished={unfinished}
          candidates={otherCycles}
          onDone={() => setRollingOver(false)}
        />
      ) : null}

      {items.length > 0 ? (
        <ul className="space-y-1 border-t pt-3">
          {items.map((item) => (
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
              <span className="shrink-0 text-xs text-muted-foreground">
                {statusLabel(item.status, workflow)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="border-t pt-3 text-sm text-muted-foreground">
          Nothing scheduled into this cycle yet. Open an item and pick this
          cycle from its properties.
        </p>
      )}
    </Card>
  );
}

/** Create / edit form. One component for both so the two never drift. */
function CycleForm({
  mode,
  cycle,
  defaultProductId,
  products,
  onDone,
}: {
  mode: "create" | "edit";
  cycle?: CycleRecord;
  defaultProductId: string | null;
  products: { id: string; name: string }[];
  onDone: () => void;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const name = String(data.get("name") ?? "").trim();
    const startDate = String(data.get("startDate") ?? "");
    const endDate = String(data.get("endDate") ?? "");
    const notes = String(data.get("notes") ?? "").trim() || null;
    const productId = String(data.get("productId") ?? "") || null;
    if (!name) return setError("Name is required.");
    if (!startDate || !endDate) return setError("Both dates are required.");
    if (endDate < startDate) {
      return setError("A cycle cannot end before it starts.");
    }

    startTransition(async () => {
      setError(null);
      try {
        if (mode === "create") {
          await createCycle({ name, startDate, endDate, notes, productId });
          toast.success("Cycle created");
        } else {
          await updateCycle(cycle!.id, {
            name,
            startDate,
            endDate,
            notes,
            productId,
          });
          toast.success("Cycle updated");
        }
        onDone();
        router.refresh();
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          router.push(
            `/sign-in?from=${encodeURIComponent(window.location.pathname)}`,
          );
          return;
        }
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
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">Name</span>
          <Input
            name="name"
            defaultValue={cycle?.name ?? ""}
            placeholder="e.g. Sprint 14"
            className="h-8"
          />
        </label>
        {products.length > 0 ? (
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Product
            </span>
            <Select
              name="productId"
              defaultValue={cycle?.productId ?? defaultProductId ?? ""}
              className="h-8"
            >
              {/* Workspace-wide is owner-only server-side; offering it here and
                  letting the server refuse keeps one rule in one place. */}
              <option value="">Workspace-wide (all products)</option>
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
            Start date
          </span>
          <Input
            name="startDate"
            type="date"
            defaultValue={cycle?.startDate ?? ""}
            className="h-8"
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            End date
          </span>
          <Input
            name="endDate"
            type="date"
            defaultValue={cycle?.endDate ?? ""}
            className="h-8"
          />
        </label>
      </div>
      <label className="block space-y-1.5">
        <span className="text-xs font-medium text-muted-foreground">Notes</span>
        <Textarea
          name="notes"
          rows={3}
          defaultValue={cycle?.notes ?? ""}
          placeholder="The goal for this cycle, or anything worth noting."
        />
      </label>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending
            ? "Saving…"
            : mode === "create"
              ? "Create cycle"
              : "Save changes"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * Rollover: move this cycle's unfinished work into another cycle. Explicit by
 * design, never automatic on the end date, because what carries over is a
 * decision the team makes rather than a rule. Finished work stays put so the
 * closed cycle keeps an honest record of what it delivered.
 */
function RolloverForm({
  cycle,
  unfinished,
  candidates,
  onDone,
}: {
  cycle: CycleRecord;
  unfinished: number;
  candidates: CycleRecord[];
  onDone: () => void;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Default to the soonest cycle that has not finished; the list is already
  // ordered active, then upcoming, then complete.
  const preferred = candidates.find((c) => c.state !== "complete") ?? candidates[0];

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const toCycleId = String(data.get("toCycleId") ?? "");
    if (!toCycleId) return setError("Pick a cycle to roll work into.");
    startTransition(async () => {
      setError(null);
      try {
        const result = await rolloverCycle(cycle.id, toCycleId);
        toast.success(
          `${result.moved} item${result.moved === 1 ? "" : "s"} rolled over`,
        );
        onDone();
        router.refresh();
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          router.push(
            `/sign-in?from=${encodeURIComponent(window.location.pathname)}`,
          );
          return;
        }
        setError(err instanceof Error ? err.message : "Rollover failed.");
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3 border-t pt-3">
      <p className="text-sm text-muted-foreground">
        Move the {unfinished} unfinished item{unfinished === 1 ? "" : "s"} in{" "}
        {cycle.name} into another cycle. Work that is already done stays here,
        so this cycle keeps its record of what it delivered.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            Roll into
          </span>
          <Select
            name="toCycleId"
            defaultValue={preferred?.id ?? ""}
            className="h-8"
          >
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({cycleStateLabel(c.state).toLowerCase()})
              </option>
            ))}
          </Select>
        </label>
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Moving…" : "Roll over"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </form>
  );
}
