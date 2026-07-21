"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
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
import { ListChecks } from "lucide-react";
import { toast } from "sonner";

import type { StatusWorkflow } from "@specboard/core";

import { FeatureCard, type ProductTag } from "@/components/feature-card";
import { FeatureEditSheet } from "@/components/feature-edit-sheet";
import { StatusDot } from "@/components/status-dot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AuthRequiredError, patchFeature } from "@/lib/api-client";
import {
  compareByRiceScore,
  rankBetween,
  sortBoardCards,
  statusLabel,
  statusOptions,
  type SortMode,
} from "@/lib/feature-helpers";
import type { FeatureRecord, ReleaseRecord } from "@/lib/store/types";
import { cn } from "@/lib/utils";

import { useBoardPrefs } from "./board-prefs";
import { BulkActionBar, type BulkOptions } from "./bulk-action-bar";

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
  bulkOptions,
  sortMode = "default",
}: {
  features: FeatureRecord[];
  columns: string[];
  workflow: StatusWorkflow;
  /** How to order cards within each column: manual rank, or by RICE score. */
  sortMode?: SortMode;
  customFieldLabels: Record<string, string>;
  memberNames: Record<string, string>;
  /** The workspace's releases (for the release badge). */
  releases: ReleaseRecord[];
  /** Product identity by id, for the per-card attribution badge in the
   * cross-product view. Omitted when the board is scoped to one product. */
  productsById?: Record<string, ProductTag>;
  /** Option lists for the bulk action bar; enables card multi-select when
   * provided (editors only). */
  bulkOptions?: BulkOptions;
}) {
  const router = useRouter();
  const { cardFields, featured } = useBoardPrefs();
  const [records, setRecords] = useState<Record<string, FeatureRecord>>(() =>
    Object.fromEntries(features.map((f) => [f.specId, f])),
  );
  const [lists, setLists] = useState<Record<string, string[]>>(() =>
    groupIntoColumns(features, columns, sortMode),
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editingSpecId, setEditingSpecId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Multi-select is opt-in: checkboxes only appear once the user turns it on, so
  // they never crowd a card's product tag or title in normal use.
  const [selectMode, setSelectMode] = useState(false);
  const canSelect = !!bulkOptions;

  const toggleSelect = useCallback((specId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(specId)) next.delete(specId);
      else next.add(specId);
      return next;
    });
  }, []);
  const clearSelection = useCallback(() => setSelected(new Set()), []);
  const exitSelect = useCallback(() => {
    setSelectMode(false);
    setSelected(new Set());
  }, []);

  // Esc leaves multi-select entirely.
  useEffect(() => {
    if (!selectMode) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") exitSelect();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectMode, exitSelect]);

  // Re-seed from the server whenever the data set changes. Every mutation (a
  // field edit in the drawer, a newly created item, a drag we just persisted)
  // ends in a router.refresh(), which re-renders this component with a fresh
  // `features` prop. The useState initializers above only run once, so without
  // this the board would keep showing stale cards until a full page reload.
  // router.refresh() only fires after the write has resolved, so re-seeding to
  // server truth never clobbers an in-flight optimistic drag.
  useEffect(() => {
    setRecords(Object.fromEntries(features.map((f) => [f.specId, f])));
    setLists(groupIntoColumns(features, columns, sortMode));
  }, [features, columns, sortMode]);

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
      {canSelect ? (
        <div className="mb-2 flex justify-end">
          <Button
            type="button"
            size="sm"
            variant={selectMode ? "secondary" : "outline"}
            onClick={() => (selectMode ? exitSelect() : setSelectMode(true))}
            className="h-8 gap-1.5"
          >
            <ListChecks className="h-4 w-4" />
            {selectMode ? "Done" : "Select"}
          </Button>
        </div>
      ) : null}
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
              selectMode={selectMode}
              selected={selected}
              onToggleSelect={toggleSelect}
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
      {selectMode && bulkOptions ? (
        <BulkActionBar
          selectedIds={[...selected]}
          options={bulkOptions}
          onClear={clearSelection}
          onExit={exitSelect}
        />
      ) : null}
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
  selectMode,
  selected,
  onToggleSelect,
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
  selectMode: boolean;
  selected: Set<string>;
  onToggleSelect: (specId: string) => void;
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
                {/* In select mode the checkbox sits in a left gutter beside the
                    card (not over it), so it never overlaps the product tag or
                    title. stopPropagation keeps a checkbox click from starting a
                    drag or opening the card. */}
                <div className="flex items-start gap-1.5">
                  {selectMode ? (
                    <input
                      type="checkbox"
                      aria-label={`Select ${record.title}`}
                      className="mt-3 h-4 w-4 shrink-0 cursor-pointer accent-primary"
                      checked={selected.has(id)}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => onToggleSelect(id)}
                    />
                  ) : null}
                  <div
                    className={cn(
                      "min-w-0 flex-1 rounded-md",
                      selected.has(id) && "ring-2 ring-primary",
                    )}
                  >
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
                  </div>
                </div>
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

/** Group features into per-status ordered specId lists (board order). Cards sort
 * by manual rank by default, or by RICE score (highest first) when requested. */
function groupIntoColumns(
  features: FeatureRecord[],
  columns: string[],
  sortMode: SortMode = "default",
): Record<string, string[]> {
  const byStatus = new Map<string, FeatureRecord[]>();
  for (const c of columns) byStatus.set(c, []);
  for (const f of features) byStatus.get(f.status)?.push(f);
  const out: Record<string, string[]> = {};
  for (const c of columns) {
    const cards = byStatus.get(c) ?? [];
    const ordered =
      sortMode === "rice"
        ? [...cards].sort(compareByRiceScore)
        : sortBoardCards(cards);
    out[c] = ordered.map((f) => f.specId);
  }
  return out;
}
