"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { toast } from "sonner";

import type { StatusWorkflow } from "@specboard/core";

import { useBoardPrefs } from "@/app/[org]/[product]/backlog/board-prefs";
import {
  cardFieldBadges,
  featuredBadge,
  type CardFieldMaps,
} from "@/components/card-field-badges";
import { FeatureEditSheet } from "@/components/feature-edit-sheet";
import type { ProductTag } from "@/components/feature-card";
import { ReleaseDetailSheet } from "@/components/release-detail-sheet";
import { StatusDot } from "@/components/status-dot";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { AuthRequiredError, patchFeature } from "@/lib/api-client";
import { statusLabel } from "@/lib/feature-helpers";
import { productColorClasses } from "@/lib/product-color";
import type { FeatureRecord, ReleaseRecord } from "@/lib/store/types";
import { cn } from "@/lib/utils";

const COL_PREFIX = "rel:";
const UNSCHEDULED = "__unscheduled__";

const RELEASE_STATUS_LABELS: Record<string, string> = {
  planned: "Planned",
  in_progress: "In progress",
  shipped: "Shipped",
};

/** A roadmap column: one release, or the trailing "Unscheduled" bucket. */
export type RoadmapColumn = {
  releaseId: string | null;
  name: string;
  startDate: string | null;
  targetDate: string | null;
  status: string | null;
  /** The full release record (for the detail panel); null for Unscheduled. */
  release: ReleaseRecord | null;
};

/**
 * Interactive Roadmap: items grouped into release columns. Editors drag a card
 * into another release column to schedule it there (or into Unscheduled to
 * clear it); the drop optimistically re-places the card, persists the new
 * `releaseId`, then revalidates. Clicking a release heading opens its detail
 * panel, which is where the Release / Edit / Delete actions live.
 */
export function RoadmapBoard({
  columns,
  features,
  workflow,
  productsById,
  customFieldLabels,
  memberNames,
  releaseNames,
  allowDrag,
  isAdmin,
}: {
  columns: RoadmapColumn[];
  features: FeatureRecord[];
  workflow: StatusWorkflow;
  productsById?: Record<string, ProductTag>;
  /** Label for each custom-property key (without the `cf:` prefix). */
  customFieldLabels: Record<string, string>;
  memberNames: Record<string, string>;
  /** Release name by id, for the release badge. */
  releaseNames: Record<string, string>;
  /** Whether items can be re-scheduled by dragging (editors, active view). */
  allowDrag: boolean;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const maps: CardFieldMaps = { customFieldLabels, memberNames, releaseNames };
  const [placement, setPlacement] = useState<Record<string, string | null>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detailReleaseId, setDetailReleaseId] = useState<string | null>(null);
  const [editingSpecId, setEditingSpecId] = useState<string | null>(null);

  // Re-seed from the server whenever fresh features arrive (after a drop's
  // refresh, or an edit elsewhere). Placement holds only optimistic overrides
  // between a drop and its refresh; clearing it falls back to server truth.
  useEffect(() => {
    setPlacement({});
  }, [features]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const releaseOf = (f: FeatureRecord): string | null =>
    f.specId in placement ? placement[f.specId]! : f.releaseId;

  const byColumn = useMemo(() => {
    const map = new Map<string, FeatureRecord[]>();
    for (const c of columns) map.set(c.releaseId ?? UNSCHEDULED, []);
    for (const f of features) {
      const key = releaseOf(f) ?? UNSCHEDULED;
      map.get(key)?.push(f);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns, features, placement]);

  function onDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
  }

  function onDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;
    const specId = String(active.id);
    const feature = features.find((f) => f.specId === specId);
    if (!feature) return;

    const overId = String(over.id);
    if (!overId.startsWith(COL_PREFIX)) return;
    const key = overId.slice(COL_PREFIX.length);
    const targetReleaseId = key === UNSCHEDULED ? null : key;

    if (releaseOf(feature) === targetReleaseId) return; // no-op

    const prev = placement;
    setPlacement({ ...placement, [specId]: targetReleaseId });
    patchFeature(specId, { releaseId: targetReleaseId })
      .then(() => router.refresh())
      .catch((err) => {
        setPlacement(prev);
        if (err instanceof AuthRequiredError) {
          router.push(
            `/sign-in?from=${encodeURIComponent(window.location.pathname)}`,
          );
          return;
        }
        toast.error(err instanceof Error ? err.message : "Move failed.");
      });
  }

  const activeFeature = activeId
    ? (features.find((f) => f.specId === activeId) ?? null)
    : null;
  const detailRelease =
    columns.find((c) => c.release?.id === detailReleaseId)?.release ?? null;

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        <div className="flex gap-4 overflow-x-auto pb-4">
          {columns.map((column) => (
            <Column
              key={column.releaseId ?? UNSCHEDULED}
              column={column}
              items={byColumn.get(column.releaseId ?? UNSCHEDULED) ?? []}
              workflow={workflow}
              productsById={productsById}
              maps={maps}
              allowDrag={allowDrag}
              onOpenDetail={setDetailReleaseId}
              onOpenItem={setEditingSpecId}
            />
          ))}
        </div>
        <DragOverlay>
          {activeFeature ? (
            <CardBody
              feature={activeFeature}
              workflow={workflow}
              productsById={productsById}
              maps={maps}
              dragging
            />
          ) : null}
        </DragOverlay>
      </DndContext>
      <ReleaseDetailSheet
        release={detailRelease}
        isAdmin={isAdmin}
        onClose={() => setDetailReleaseId(null)}
      />
      <FeatureEditSheet
        specId={editingSpecId}
        onClose={() => setEditingSpecId(null)}
      />
    </>
  );
}

function Column({
  column,
  items,
  workflow,
  productsById,
  maps,
  allowDrag,
  onOpenDetail,
  onOpenItem,
}: {
  column: RoadmapColumn;
  items: FeatureRecord[];
  workflow: StatusWorkflow;
  productsById?: Record<string, ProductTag>;
  maps: CardFieldMaps;
  allowDrag: boolean;
  onOpenDetail: (releaseId: string) => void;
  onOpenItem: (specId: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `${COL_PREFIX}${column.releaseId ?? UNSCHEDULED}`,
  });
  const dates = formatReleaseDates(column.startDate, column.targetDate);
  const statusLabelText =
    column.status && column.status !== "planned"
      ? (RELEASE_STATUS_LABELS[column.status] ?? column.status)
      : null;

  return (
    <div className="w-72 shrink-0 space-y-2 rounded-md bg-muted/35 p-2.5">
      {/* Heading: release name on top, dates (and non-default status) beneath. */}
      <div className="space-y-0.5 px-1">
        <div className="flex items-baseline justify-between gap-2">
          {column.release ? (
            <button
              type="button"
              onClick={() => onOpenDetail(column.release!.id)}
              className="text-left text-sm font-medium text-link hover:underline"
            >
              {column.name}
            </button>
          ) : (
            <span className="text-sm font-medium text-muted-foreground">
              {column.name}
            </span>
          )}
          <Badge variant="counter" className="shrink-0">
            {items.length}
          </Badge>
        </div>
        {/* Always render the date line (a non-breaking space when a column has
            neither dates nor a status) so every column's cards start at the
            same vertical offset, including "Unscheduled". */}
        <p className="text-xs text-muted-foreground">
          {dates || statusLabelText ? (
            <>
              {dates}
              {dates && statusLabelText ? " · " : ""}
              {statusLabelText}
            </>
          ) : (
            " "
          )}
        </p>
      </div>

      <div
        ref={setNodeRef}
        className={cn(
          "min-h-16 space-y-2 rounded-md p-1 transition-colors",
          isOver ? "bg-muted/60" : "",
        )}
      >
        {items.map((f) => (
          <DraggableCard
            key={f.specId}
            feature={f}
            workflow={workflow}
            productsById={productsById}
            maps={maps}
            allowDrag={allowDrag}
            onOpenItem={onOpenItem}
          />
        ))}
        {items.length === 0 ? (
          <p className="px-2 py-1 text-xs text-muted-foreground">Empty</p>
        ) : null}
      </div>
    </div>
  );
}

function DraggableCard({
  feature,
  workflow,
  productsById,
  maps,
  allowDrag,
  onOpenItem,
}: {
  feature: FeatureRecord;
  workflow: StatusWorkflow;
  productsById?: Record<string, ProductTag>;
  maps: CardFieldMaps;
  allowDrag: boolean;
  onOpenItem: (specId: string) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: feature.specId,
    disabled: !allowDrag,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ opacity: isDragging ? 0.4 : 1 }}
      className={allowDrag ? "cursor-grab active:cursor-grabbing" : ""}
      {...(allowDrag ? attributes : {})}
      {...(allowDrag ? listeners : {})}
    >
      <CardBody
        feature={feature}
        workflow={workflow}
        productsById={productsById}
        maps={maps}
        onOpenItem={onOpenItem}
      />
    </div>
  );
}

/**
 * Presentational roadmap card (shared by the column list and the drag overlay).
 * The user-selected card fields come from the shared board preferences (scoped
 * to the Roadmap), rendered the same way as on the Backlog board.
 */
function CardBody({
  feature,
  workflow,
  productsById,
  maps,
  onOpenItem,
  dragging,
}: {
  feature: FeatureRecord;
  workflow: StatusWorkflow;
  productsById?: Record<string, ProductTag>;
  maps: CardFieldMaps;
  /** Open the item's preview panel; omitted for the drag overlay (inert). */
  onOpenItem?: (specId: string) => void;
  dragging?: boolean;
}) {
  const { cardFields, featured } = useBoardPrefs();
  const product =
    productsById && feature.productId
      ? productsById[feature.productId]
      : undefined;
  const featuredEl = featuredBadge(featured, cardFields, feature, maps);
  const badges = cardFieldBadges(cardFields, featured, feature, maps);
  return (
    <Card className={cn(dragging && "shadow-md")}>
      <CardHeader className="space-y-1 p-3">
        {product ? (
          <Badge
            variant="secondary"
            className={cn(
              "w-fit border-transparent text-[10px]",
              productColorClasses(product).badge,
            )}
          >
            {product.name}
          </Badge>
        ) : null}
        {featuredEl}
        <CardTitle className="text-sm">
          {/* Opens the same preview panel as the Backlog board (not a full-page
              nav), so the two spaces behave the same. stopPropagation keeps a
              click from also being read as a drag start. */}
          <button
            type="button"
            className="text-left hover:underline"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onOpenItem?.(feature.specId);
            }}
          >
            {feature.title}
          </button>
        </CardTitle>
        <CardDescription className="flex items-center gap-2 text-xs">
          <StatusDot status={feature.status} />
          {statusLabel(feature.status, workflow)}
        </CardDescription>
        {badges.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1">{badges}</div>
        ) : null}
      </CardHeader>
    </Card>
  );
}

/** Render a release's date range as "start → ship", omitting missing ends. */
function formatReleaseDates(
  startDate: string | null,
  targetDate: string | null,
): string | null {
  if (startDate && targetDate) return `${startDate} → ${targetDate}`;
  if (targetDate) return `→ ${targetDate}`;
  if (startDate) return `${startDate} →`;
  return null;
}
