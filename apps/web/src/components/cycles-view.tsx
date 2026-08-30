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
  generateCycles,
  rolloverCycle,
  updateCycle,
} from "@/lib/api-client";
import { statusLabel } from "@/lib/feature-helpers";
import { orgProductPath } from "@/lib/org-path";
import {
  cycleDaysRemaining,
  cycleScheduleRemainderDays,
  cycleStateLabel,
  generateCycleSchedule,
  nextCycleNumber,
  todayDateOnly,
  validateCycleScheduleInput,
  CYCLE_NUMBER_TOKEN,
  type CycleRecord,
  type CycleScheduleInput,
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
  const [generating, setGenerating] = useState(false);

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
        {canEdit && !creating && !generating ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setGenerating(true)}
            >
              Generate schedule
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setCreating(true)}
            >
              New cycle
            </Button>
          </div>
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

      {generating ? (
        <GenerateScheduleForm
          existing={cycles}
          defaultProductId={defaultProductId}
          products={products}
          onDone={() => setGenerating(false)}
        />
      ) : null}

      {cycles.length === 0 && !creating && !generating ? (
        <EmptyState
          className="mt-8"
          title="No cycles yet"
          description={
            canEdit
              ? "A cycle is the time box your team plans into, usually a week or two. If you run a fixed cadence, generate the whole run at once rather than adding them one by one. Releases keep answering what ships together; cycles answer what the team is doing now."
              : "A cycle is the time box the team plans into. Once someone with edit access creates one, it appears here."
          }
          action={
            canEdit ? (
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button size="sm" onClick={() => setGenerating(true)}>
                  Generate schedule
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setCreating(true)}
                >
                  New cycle
                </Button>
              </div>
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

/** Cadence choices offered in the picker, in days. Covers the sprint lengths
 * teams actually run; anything else is still creatable one cycle at a time. */
const CADENCES = [
  { days: 7, label: "1 week" },
  { days: 14, label: "2 weeks" },
  { days: 21, label: "3 weeks" },
  { days: 28, label: "4 weeks" },
] as const;

/** Default horizon: the end of the year the start date falls in, which is the
 * "two-week sprints until the end of the year" case this exists for. */
function endOfYear(from: string): string {
  return `${from.slice(0, 4)}-12-31`;
}

/**
 * Generate a whole run of cycles from a cadence: "two-week sprints from Monday
 * until the end of the year", rather than creating twenty by hand.
 *
 * The preview is computed with the same `generateCycleSchedule` the server
 * uses, so what is listed here is exactly what gets created. That is the point
 * of the function living in core rather than in the route: a preview that
 * reimplemented the date maths would eventually disagree with the result, and
 * the user would only find out after twenty rows landed.
 */
function GenerateScheduleForm({
  existing,
  defaultProductId,
  products,
  onDone,
}: {
  existing: CycleRecord[];
  defaultProductId: string | null;
  products: { id: string; name: string }[];
  onDone: () => void;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const [nameTemplate, setNameTemplate] = useState(`Sprint ${CYCLE_NUMBER_TOKEN}`);
  const [lengthDays, setLengthDays] = useState(14);
  // Runs client-side only (the form is behind a state toggle), so reading the
  // clock here cannot cause a hydration mismatch.
  const [startDate, setStartDate] = useState(() => todayDateOnly());
  const [endDate, setEndDate] = useState(() => endOfYear(todayDateOnly()));
  const [productId, setProductId] = useState(defaultProductId ?? "");

  const targetProductId = productId || null;
  // Only names in the same scope can collide, since uniqueness is per product.
  const scopedNames = existing
    .filter((c) => (c.productId ?? null) === targetProductId)
    .map((c) => c.name);
  // Continue the numbering rather than colliding: a team that hand-made
  // Sprint 1 to 5 and now wants the rest of the year should get Sprint 6.
  const startNumber = nextCycleNumber(scopedNames, nameTemplate);

  const input: CycleScheduleInput = {
    startDate,
    endDate,
    lengthDays,
    nameTemplate,
    startNumber,
  };
  const invalid = validateCycleScheduleInput(input);
  const planned = invalid ? [] : generateCycleSchedule(input);
  const remainder = invalid ? 0 : cycleScheduleRemainderDays(input);

  // Warn rather than block: overlapping cycles are legal (a workspace-wide
  // cycle deliberately spans product ones), but overlapping your own existing
  // sprints is nearly always a mistake worth catching before twenty land.
  const overlapping = existing.filter(
    (c) =>
      (c.productId ?? null) === targetProductId &&
      planned.some((p) => p.startDate <= c.endDate && c.startDate <= p.endDate),
  );

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (invalid) return setError(invalid);
    startTransition(async () => {
      setError(null);
      try {
        const created = await generateCycles({
          ...input,
          productId: targetProductId,
        });
        toast.success(
          `${created.length} cycle${created.length === 1 ? "" : "s"} created`,
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
        setError(err instanceof Error ? err.message : "Generate failed.");
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-md border bg-card p-4">
      <div className="space-y-1">
        <h2 className="text-sm font-medium">Generate a schedule</h2>
        <p className="text-xs text-muted-foreground">
          Create a run of back-to-back cycles at a fixed cadence. Each one starts
          the day after the last ends, and they are numbered in sequence.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            Name pattern
          </span>
          <Input
            value={nameTemplate}
            onChange={(e) => setNameTemplate(e.target.value)}
            placeholder={`Sprint ${CYCLE_NUMBER_TOKEN}`}
            className="h-8"
          />
          <span className="block text-2xs text-muted-foreground">
            {CYCLE_NUMBER_TOKEN} is replaced by the cycle number, starting at{" "}
            {startNumber}.
          </span>
        </label>
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            Cycle length
          </span>
          <Select
            value={String(lengthDays)}
            onChange={(e) => setLengthDays(Number(e.target.value))}
            className="h-8"
          >
            {CADENCES.map((c) => (
              <option key={c.days} value={c.days}>
                {c.label}
              </option>
            ))}
          </Select>
        </label>
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            First cycle starts
          </span>
          <Input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="h-8"
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            Generate until
          </span>
          <Input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="h-8"
          />
        </label>
        {products.length > 0 ? (
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Product
            </span>
            <Select
              value={productId}
              onChange={(e) => setProductId(e.target.value)}
              className="h-8"
            >
              <option value="">Workspace-wide (all products)</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </label>
        ) : null}
      </div>

      <SchedulePreview
        planned={planned}
        invalid={invalid}
        remainder={remainder}
        endDate={endDate}
        overlapping={overlapping}
      />

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex items-center gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={pending || planned.length === 0}
        >
          {pending
            ? "Generating…"
            : `Create ${planned.length} cycle${planned.length === 1 ? "" : "s"}`}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Exactly what "Create" will produce, listed before anyone commits to it. */
function SchedulePreview({
  planned,
  invalid,
  remainder,
  endDate,
  overlapping,
}: {
  planned: { name: string; startDate: string; endDate: string }[];
  invalid: string | null;
  remainder: number;
  endDate: string;
  overlapping: CycleRecord[];
}) {
  if (invalid) {
    return (
      <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
        {invalid}
      </p>
    );
  }
  const last = planned[planned.length - 1];
  return (
    <div className="space-y-2 rounded-md border bg-muted/30 p-3">
      <p className="text-xs font-medium">
        {planned.length} cycle{planned.length === 1 ? "" : "s"}, {planned[0]!.startDate}{" "}
        to {last!.endDate}
      </p>
      <ul className="max-h-48 space-y-0.5 overflow-y-auto text-xs text-muted-foreground">
        {planned.map((p) => (
          <li key={p.name} className="flex items-baseline gap-2">
            <span className="font-medium text-foreground">{p.name}</span>
            <span>
              {p.startDate} to {p.endDate}
            </span>
          </li>
        ))}
      </ul>
      {remainder > 0 ? (
        <p className="text-2xs text-muted-foreground">
          The last {remainder} day{remainder === 1 ? "" : "s"} before {endDate}{" "}
          are not covered: another full cycle would run past your end date.
        </p>
      ) : null}
      {overlapping.length > 0 ? (
        <p className="text-2xs text-warning-fg">
          Overlaps {overlapping.length} existing cycle
          {overlapping.length === 1 ? "" : "s"} ({overlapping
            .slice(0, 3)
            .map((c) => c.name)
            .join(", ")}
          {overlapping.length > 3 ? ", …" : ""}). You can still generate these,
          but two cycles will claim the same days.
        </p>
      ) : null}
    </div>
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
