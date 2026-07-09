"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { toast } from "sonner";

import type { StatusWorkflow } from "@specboard/core";

import { FeatureCard, type ProductTag } from "@/components/feature-card";
import { FeatureEditSheet } from "@/components/feature-edit-sheet";
import { StatusDot } from "@/components/status-dot";
import { Badge } from "@/components/ui/badge";
import { AuthRequiredError, patchFeature } from "@/lib/api-client";
import {
  rankBetween,
  sortBoardCards,
  statusLabel,
  statusOptions,
} from "@/lib/feature-helpers";
import type { FeatureRecord, ReleaseRecord } from "@/lib/store/types";

import { useBoardPrefs } from "./board-prefs";

const COL_PREFIX = "col:";

/**
 * Interactive Kanban board: drag cards between columns (changes status, if the
 * workflow permits) or reorder within a column (persists a fractional `rank`).
 * Clicking a card opens an edit drawer. Server-rendered data seeds local state;
 * each drop optimistically updates, persists via the API, then revalidates.
 */
export function BoardClient({
  features,
  columns,
  workflow,
  customFieldLabels,
  memberNames,
  releases,
  productsById,
}: {
  features: FeatureRecord[];
  columns: string[];
  workflow: StatusWorkflow;
  customFieldLabels: Record<string, string>;
  memberNames: Record<string, string>;
  /** The workspace's releases (for the release badge). */
  releases: ReleaseRecord[];
  /** Product identity by id, for the per-card attribution badge in the
   * cross-product view. Omitted when the board is scoped to one product. */
  productsById?: Record<string, ProductTag>;
}) {
  const router = useRouter();
  const { cardFields, featured } = useBoardPrefs();
  const [records, setRecords] = useState<Record<string, FeatureRecord>>(() =>
    Object.fromEntries(features.map((f) => [f.specId, f])),
  );
  const [lists, setLists] = useState<Record<string, string[]>>(() =>
    groupIntoColumns(features, columns),
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editingSpecId, setEditingSpecId] = useState<string | null>(null);

  // Re-seed from the server whenever the data set changes. Every mutation (a
  // field edit in the drawer, a newly created item, a drag we just persisted)
  // ends in a router.refresh(), which re-renders this component with a fresh
  // `features` prop. The useState initializers above only run once, so without
  // this the board would keep showing stale cards until a full page reload.
  // router.refresh() only fires after the write has resolved, so re-seeding to
  // server truth never clobbers an in-flight optimistic drag.
  useEffect(() => {
    setRecords(Object.fromEntries(features.map((f) => [f.specId, f])));
    setLists(groupIntoColumns(features, columns));
  }, [features, columns]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  function columnOf(id: string): string | undefined {
    if (id.startsWith(COL_PREFIX)) return id.slice(COL_PREFIX.length);
    return columns.find((c) => lists[c]?.includes(id));
  }

  function onDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
  }

  function onDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;
    const specId = String(active.id);
    const current = records[specId];
    const from = columnOf(specId);
    const to = columnOf(String(over.id));
    if (!from || !to || !current) return;

    // Build the target column's new ordering (target list excludes the card,
    // then re-inserts it at the drop position).
    const overId = String(over.id);
    const target = (lists[to] ?? []).filter((id) => id !== specId);
    const overIndex = target.indexOf(overId);
    const index = overId.startsWith(COL_PREFIX) || overIndex < 0
      ? target.length
      : overIndex;
    target.splice(index, 0, specId);

    // No-op: dropped back into its original column at its original position.
    if (from === to && arraysEqual(lists[from] ?? [], target)) return;

    // Reject status changes the workflow doesn't allow.
    const statusChanged = from !== to;
    if (statusChanged && !statusOptions(from, workflow).includes(to)) {
      toast.error(
        `Can't move ${statusLabel(from, workflow)} → ${statusLabel(to, workflow)} (not an allowed transition).`,
      );
      return;
    }

    // Fractional rank between the new neighbors (open boundary => null).
    const prevId = index > 0 ? target[index - 1] : null;
    const nextId = index < target.length - 1 ? target[index + 1] : null;
    const prevRank = prevId ? (records[prevId]?.rank ?? null) : null;
    let nextRank = nextId ? (records[nextId]?.rank ?? null) : null;
    if (prevRank && nextRank && !(prevRank < nextRank)) nextRank = null;
    const newRank = rankBetween(prevRank, nextRank);

    // Snapshot for rollback, then optimistically commit.
    const prevLists = lists;
    const prevRecords = records;
    const nextLists = {
      ...lists,
      [from]: (lists[from] ?? []).filter((id) => id !== specId),
      [to]: target,
    };
    setLists(nextLists);
    setRecords({
      ...records,
      [specId]: { ...current, rank: newRank, status: to },
    });

    const patch = statusChanged
      ? { status: to, rank: newRank }
      : { rank: newRank };
    patchFeature(specId, patch)
      .then(() => router.refresh())
      .catch((err) => {
        setLists(prevLists);
        setRecords(prevRecords);
        if (err instanceof AuthRequiredError) {
          router.push(
            `/sign-in?from=${encodeURIComponent(window.location.pathname)}`,
          );
          return;
        }
        toast.error(err instanceof Error ? err.message : "Move failed.");
      });
  }

  const activeRecord = activeId ? records[activeId] : null;
  const releaseNames = Object.fromEntries(releases.map((r) => [r.id, r.name]));

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        <div className="flex gap-4 overflow-x-auto pb-4">
          {columns.map((status) => (
            <Column
              key={status}
              status={status}
              workflow={workflow}
              cardIds={lists[status] ?? []}
              records={records}
              cardFields={cardFields}
              featured={featured}
              customFieldLabels={customFieldLabels}
              memberNames={memberNames}
              releaseNames={releaseNames}
              onOpen={setEditingSpecId}
              productsById={productsById}
            />
          ))}
        </div>
        <DragOverlay>
          {activeRecord ? (
            <FeatureCard
              feature={activeRecord}
              fields={cardFields}
              featured={featured}
              customFieldLabels={customFieldLabels}
              memberNames={memberNames}
              releaseNames={releaseNames}
              onOpen={() => {}}
              product={
                activeRecord.productId
                  ? productsById?.[activeRecord.productId]
                  : undefined
              }
            />
          ) : null}
        </DragOverlay>
      </DndContext>
      <FeatureEditSheet
        specId={editingSpecId}
        onClose={() => setEditingSpecId(null)}
      />
    </>
  );
}

function Column({
  status,
  workflow,
  cardIds,
  records,
  cardFields,
  featured,
  customFieldLabels,
  memberNames,
  releaseNames,
  onOpen,
  productsById,
}: {
  status: string;
  workflow: StatusWorkflow;
  cardIds: string[];
  records: Record<string, FeatureRecord>;
  cardFields: string[];
  featured: string | null;
  customFieldLabels: Record<string, string>;
  memberNames: Record<string, string>;
  releaseNames: Record<string, string>;
  onOpen: (specId: string) => void;
  productsById?: Record<string, ProductTag>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `${COL_PREFIX}${status}` });
  return (
    <div className="w-72 shrink-0 rounded-md bg-muted/35 p-2.5">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <StatusDot status={status} />
        <span className="text-sm font-medium">{statusLabel(status, workflow)}</span>
        <Badge variant="counter" className="ml-auto">
          {cardIds.length}
        </Badge>
      </div>
      <SortableContext items={cardIds} strategy={verticalListSortingStrategy}>
        <div
          ref={setNodeRef}
          className={`min-h-12 space-y-2 rounded-md transition-colors ${isOver ? "bg-muted" : ""}`}
        >
          {cardIds.map((id) => {
            const record = records[id];
            if (!record) return null;
            return (
              <SortableCard key={id} id={id}>
                <FeatureCard
                  feature={record}
                  fields={cardFields}
                  featured={featured}
                  customFieldLabels={customFieldLabels}
                  memberNames={memberNames}
                  releaseNames={releaseNames}
                  onOpen={() => onOpen(id)}
                  product={
                    record.productId ? productsById?.[record.productId] : undefined
                  }
                />
              </SortableCard>
            );
          })}
          {cardIds.length === 0 ? (
            <p className="px-2 pb-2 text-xs text-muted-foreground">Empty</p>
          ) : null}
        </div>
      </SortableContext>
    </div>
  );
}

function SortableCard({ id, children }: { id: string; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1,
      }}
      {...attributes}
      {...listeners}
    >
      {children}
    </div>
  );
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Group features into per-status ordered specId lists (board order). */
function groupIntoColumns(
  features: FeatureRecord[],
  columns: string[],
): Record<string, string[]> {
  const byStatus = new Map<string, FeatureRecord[]>();
  for (const c of columns) byStatus.set(c, []);
  for (const f of features) byStatus.get(f.status)?.push(f);
  const out: Record<string, string[]> = {};
  for (const c of columns) {
    out[c] = sortBoardCards(byStatus.get(c) ?? []).map((f) => f.specId);
  }
  return out;
}
