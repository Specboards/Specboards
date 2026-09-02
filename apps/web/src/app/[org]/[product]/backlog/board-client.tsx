"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS, getEventCoordinates } from "@dnd-kit/utilities";
import { toast } from "sonner";

import type {
  PropertyType,
  StatusWorkflow,
  WorkspaceLevel,
} from "@specboards/core";

import { BoardColumnNav } from "@/components/board-column-nav";
import { useBoardSelection } from "@/components/board-selection";
import { ColumnQuickAdd } from "@/components/column-quick-add";
import { FeatureCard, type ProductTag } from "@/components/feature-card";
import { FeatureEditSheet } from "@/components/feature-edit-sheet";
import { MoveMenu, type MoveOption } from "@/components/move-menu";
import { StatusDot } from "@/components/status-dot";
import { Badge } from "@/components/ui/badge";
import { redirectOnAuthExpiry } from "@/lib/auth-expiry";
import { patchFeature } from "@/lib/api-client/work-items";
import { useAnnouncer } from "@/lib/use-announcer";
import { useIsCoarsePointer, useIsMobile } from "@/lib/use-media-query";
import { useSwipeColumns } from "@/lib/use-swipe-columns";
import {
  compareByCustomField,
  compareByRiceScore,
  CUSTOM_SORT_PREFIX,
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
/** Edge drop zones: the "drop at top" / "drop at end" bars a column floats over
 * its two edges while a card is in flight, so a tall column's ends stay
 * reachable without drag-scrolling to them. */
const TOP_PREFIX = "top:";
const END_PREFIX = "end:";
/** Every droppable id carries one of these; the rest is the column's status. */
const ZONE_PREFIXES = [COL_PREFIX, TOP_PREFIX, END_PREFIX];

/** True for a column-level droppable (a column body or one of its edge bars),
 * as opposed to a card. */
function isZoneId(id: string): boolean {
  return ZONE_PREFIXES.some((p) => id.startsWith(p));
}

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
  levels,
  productsById,
  bulkOptions,
  quickAdd,
  sortMode = "default",
  customFieldTypes = {},
}: {
  features: FeatureRecord[];
  columns: string[];
  workflow: StatusWorkflow;
  /** How to order cards within each column: manual rank, RICE score, or a
   * custom property (`cf:<key>` sort mode). */
  sortMode?: SortMode;
  /** Declared type per custom-property key, so a `cf:` sort compares dates and
   * numbers correctly. */
  customFieldTypes?: Record<string, PropertyType>;
  customFieldLabels: Record<string, string>;
  memberNames: Record<string, string>;
  /** The workspace's releases (for the release badge). */
  releases: ReleaseRecord[];
  /** The workspace's hierarchy levels, so cards can name the child and parent
   * levels in their progress badges. */
  levels: readonly WorkspaceLevel[];
  /** Product identity by id, for the per-card attribution badge in the
   * cross-product view. Omitted when the board is scoped to one product. */
  productsById?: Record<string, ProductTag>;
  /** Option lists for the bulk action bar; enables card multi-select when
   * provided (editors only). */
  bulkOptions?: BulkOptions;
  /** Enables the per-column "Add {level}" quick add (editors, non-leaf level,
   * single product in scope). The new item takes the column's status. */
  quickAdd?: { levelKey: string; levelLabel: string; productId: string | null };
}) {
  const router = useRouter();
  const announce = useAnnouncer();
  const { cardFields, featured } = useBoardPrefs();
  const [records, setRecords] = useState<Record<string, FeatureRecord>>(() =>
    Object.fromEntries(features.map((f) => [f.specId, f])),
  );
  const [lists, setLists] = useState<Record<string, string[]>>(() =>
    groupIntoColumns(features, columns, sortMode, customFieldTypes),
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editingSpecId, setEditingSpecId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Multi-select is opt-in: checkboxes only appear once the user turns it on, so
  // they never crowd a card's product tag or title in normal use. The mode
  // itself lives in BoardSelectionProvider so the toolbar can own the toggle;
  // only the selected ids belong to this board.
  const { selectMode, exit: exitSelect } = useBoardSelection();

  const toggleSelect = useCallback((specId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(specId)) next.delete(specId);
      else next.add(specId);
      return next;
    });
  }, []);
  const clearSelection = useCallback(() => setSelected(new Set()), []);

  // Leaving multi-select (the toggle, Escape, or the bulk bar) drops whatever
  // was selected, so re-entering never resurrects a stale selection.
  useEffect(() => {
    if (!selectMode) setSelected(new Set());
  }, [selectMode]);

  // Re-seed from the server whenever the data set changes. Every mutation (a
  // field edit in the drawer, a newly created item, a drag we just persisted)
  // ends in a router.refresh(), which re-renders this component with a fresh
  // `features` prop. The useState initializers above only run once, so without
  // this the board would keep showing stale cards until a full page reload.
  // router.refresh() only fires after the write has resolved, so re-seeding to
  // server truth never clobbers an in-flight optimistic drag.
  useEffect(() => {
    setRecords(Object.fromEntries(features.map((f) => [f.specId, f])));
    setLists(groupIntoColumns(features, columns, sortMode, customFieldTypes));
  }, [features, columns, sortMode, customFieldTypes]);

  // Below md the board is a swipe-column carousel: dragging is disabled (see
  // SortableCard) and horizontal swipes scroll between columns. On coarse
  // pointers wide enough to still drag (tablets), a short long-press lifts a
  // card so a swipe scrolls instead of snatching one; a fine pointer keeps the
  // instant 6px threshold.
  const isMobile = useIsMobile();
  const coarsePointer = useIsCoarsePointer();
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: coarsePointer
        ? { delay: 250, tolerance: 8 }
        : { distance: 6 },
    }),
  );
  const { scrollRef, activeColumn, scrollToColumn } = useSwipeColumns(
    columns.length,
  );

  // Desktop columns stop growing at the bottom of the viewport and scroll
  // inside instead, so the board never runs off the page. That is what makes a
  // drop reachable: the column's own scroll area is the drag surface, its edge
  // bars stay pinned in view, and dnd-kit auto-scrolls the column (not the
  // window) when a card nears an edge. Measured rather than a guessed `vh`
  // offset, so the toolbar and filter bar above can change height freely. Below
  // md the board is a swipe carousel with drag off, so the page scrolls as
  // before.
  const boardRef = useRef<HTMLDivElement | null>(null);
  const [boardMaxHeight, setBoardMaxHeight] = useState<number | null>(null);
  useEffect(() => {
    function measure() {
      const el = boardRef.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top + window.scrollY;
      // The gap clears what sits below the board (the page container's bottom
      // padding, mainly). Leaving the page even slightly scrollable would undo
      // the point of the cap: dnd-kit auto-scrolls the window whenever a drag
      // nears the viewport edge, which is exactly where the "drop at end" bar
      // sits, and the page sliding out from under the pointer knocks it off the
      // target.
      setBoardMaxHeight(Math.max(360, window.innerHeight - top - 48));
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // Column-aware collision, in priority order: an edge bar (it floats over the
  // cards beneath it, so the pointer is always inside both), then a card (for
  // precise within-column insertion), then the column body so a drop onto open
  // space still lands in that column. `closestCorners` (the dnd-kit board
  // default) measured against the nearest card rect, so dragging from the bottom
  // of a tall column toward a near-empty one kept resolving back to a
  // source-column card and the drop no-oped (the card snapped home). The roadmap
  // board avoids this the same way (it uses pointerWithin).
  const collisionDetection: CollisionDetection = useCallback((args) => {
    const pointerCollisions = pointerWithin(args);
    const collisions =
      pointerCollisions.length > 0 ? pointerCollisions : rectIntersection(args);
    const edgeCollisions = collisions.filter((c) => {
      const id = String(c.id);
      return id.startsWith(TOP_PREFIX) || id.startsWith(END_PREFIX);
    });
    if (edgeCollisions.length > 0) return edgeCollisions;
    const cardCollisions = collisions.filter((c) => !isZoneId(String(c.id)));
    return cardCollisions.length > 0 ? cardCollisions : collisions;
  }, []);

  function columnOf(id: string): string | undefined {
    const prefix = ZONE_PREFIXES.find((p) => id.startsWith(p));
    if (prefix) return id.slice(prefix.length);
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

    // Build the target column's new ordering.
    const overId = String(over.id);
    let target: string[];
    let index: number;
    if (from === to && !isZoneId(overId)) {
      // Within a column, commit exactly what the drag preview showed: the card
      // takes the slot that opened up, which is *after* the card it was dragged
      // past on the way down and before it on the way up. Inserting at the
      // over-card's index unconditionally (what this used to do) contradicted
      // the preview downward, so a card could never be dragged onto the last
      // slot: it always landed one above.
      const list = lists[from] ?? [];
      const oldIndex = list.indexOf(specId);
      const newIndex = list.indexOf(overId);
      if (oldIndex < 0 || newIndex < 0) return;
      target = arrayMove(list, oldIndex, newIndex);
      index = newIndex;
    } else {
      target = (lists[to] ?? []).filter((id) => id !== specId);
      index = dropIndex(overId, target, event);
      target.splice(index, 0, specId);
    }

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
        if (redirectOnAuthExpiry(err, router)) return;
        toast.error(err instanceof Error ? err.message : "Move failed.");
      });
  }

  // Persist a card at a new (status, rank) with an optimistic update, rollback on
  // failure, and a live-region announcement. Shared by the two non-drag moves
  // below so the keyboard/menu path commits identically to a drop.
  function commitMove(
    specId: string,
    toStatus: string,
    nextLists: Record<string, string[]>,
    newRank: string | null,
    message: string,
  ) {
    const current = records[specId];
    if (!current) return;
    const prevLists = lists;
    const prevRecords = records;
    setLists(nextLists);
    setRecords({
      ...records,
      [specId]: { ...current, rank: newRank, status: toStatus },
    });
    patchFeature(specId, { status: toStatus, rank: newRank })
      .then(() => {
        router.refresh();
        announce(message);
      })
      .catch((err) => {
        setLists(prevLists);
        setRecords(prevRecords);
        if (redirectOnAuthExpiry(err, router)) return;
        toast.error(err instanceof Error ? err.message : "Move failed.");
      });
  }

  // Non-drag "Move to <column>": relocate a card to the end of another column,
  // if the workflow allows the transition. The keyboard/menu counterpart to
  // dragging across columns.
  function moveToStatus(specId: string, toStatus: string) {
    const current = records[specId];
    const from = current?.status;
    if (!current || !from || from === toStatus) return;
    if (!statusOptions(from, workflow).includes(toStatus)) {
      toast.error(
        `Can't move ${statusLabel(from, workflow)} → ${statusLabel(toStatus, workflow)} (not an allowed transition).`,
      );
      return;
    }
    const targetIds = lists[toStatus] ?? [];
    const lastId = targetIds[targetIds.length - 1] ?? null;
    const lastRank = lastId ? (records[lastId]?.rank ?? null) : null;
    const newRank = rankBetween(lastRank, null);
    const nextLists = {
      ...lists,
      [from]: (lists[from] ?? []).filter((id) => id !== specId),
      [toStatus]: [...targetIds, specId],
    };
    commitMove(
      specId,
      toStatus,
      nextLists,
      newRank,
      `Moved ${current.title} to ${statusLabel(toStatus, workflow)}`,
    );
  }

  // Non-drag reorder: nudge a card one slot up or down within its column and
  // re-rank it between its new neighbors. The keyboard/menu counterpart to
  // dragging within a column.
  function moveWithinColumn(specId: string, dir: -1 | 1) {
    const current = records[specId];
    const status = current?.status;
    if (!current || !status) return;
    const col = lists[status] ?? [];
    const i = col.indexOf(specId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= col.length) return;
    const next = [...col];
    next.splice(i, 1);
    next.splice(j, 0, specId);
    const prevId = j > 0 ? next[j - 1] : null;
    const nextId = j < next.length - 1 ? next[j + 1] : null;
    const prevRank = prevId ? (records[prevId]?.rank ?? null) : null;
    let nextRank = nextId ? (records[nextId]?.rank ?? null) : null;
    if (prevRank && nextRank && !(prevRank < nextRank)) nextRank = null;
    const newRank = rankBetween(prevRank, nextRank);
    commitMove(
      specId,
      status,
      { ...lists, [status]: next },
      newRank,
      `Moved ${current.title} ${dir < 0 ? "up" : "down"}`,
    );
  }

  const activeRecord = activeId ? records[activeId] : null;
  const releaseNames = Object.fromEntries(releases.map((r) => [r.id, r.name]));

  return (
    <>
      <BoardColumnNav
        label={
          columns[activeColumn]
            ? statusLabel(columns[activeColumn], workflow)
            : ""
        }
        index={activeColumn}
        count={columns.length}
        onPrev={() => scrollToColumn(activeColumn - 1)}
        onNext={() => scrollToColumn(activeColumn + 1)}
      />
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        // A cancelled drag (Escape, the window resizing, the tab going
        // background) never reaches onDragEnd, so without this the board would
        // stay in its dragging state: overlay card stuck to the cursor, drop
        // zones stuck open.
        onDragCancel={() => setActiveId(null)}
      >
        <div
          ref={(node) => {
            scrollRef.current = node;
            boardRef.current = node;
          }}
          style={
            isMobile || !boardMaxHeight
              ? undefined
              : { maxHeight: boardMaxHeight }
          }
          className="relative flex items-stretch gap-4 overflow-x-auto pb-4 max-md:-mx-4 max-md:snap-x max-md:snap-mandatory max-md:px-4 max-md:scroll-px-4"
        >
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
              customFieldTypes={customFieldTypes}
              memberNames={memberNames}
              releaseNames={releaseNames}
              levels={levels}
              onOpen={setEditingSpecId}
              productsById={productsById}
              selectMode={selectMode}
              selected={selected}
              onToggleSelect={toggleSelect}
              dragDisabled={isMobile}
              dragActive={activeId !== null}
              onMoveToStatus={moveToStatus}
              onMoveWithinColumn={moveWithinColumn}
              quickAdd={quickAdd}
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
              customFieldTypes={customFieldTypes}
              memberNames={memberNames}
              releaseNames={releaseNames}
              levels={levels}
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
  customFieldTypes,
  memberNames,
  releaseNames,
  levels,
  onOpen,
  productsById,
  selectMode,
  selected,
  onToggleSelect,
  dragDisabled,
  dragActive,
  onMoveToStatus,
  onMoveWithinColumn,
  quickAdd,
}: {
  status: string;
  workflow: StatusWorkflow;
  cardIds: string[];
  records: Record<string, FeatureRecord>;
  cardFields: string[];
  featured: string | null;
  customFieldLabels: Record<string, string>;
  customFieldTypes: Record<string, PropertyType>;
  memberNames: Record<string, string>;
  releaseNames: Record<string, string>;
  levels: readonly WorkspaceLevel[];
  onOpen: (specId: string) => void;
  productsById?: Record<string, ProductTag>;
  selectMode: boolean;
  selected: Set<string>;
  onToggleSelect: (specId: string) => void;
  /** Below md, drag is off and swiping scrolls between columns instead. */
  dragDisabled: boolean;
  /** True while a card is in flight anywhere on the board: the cue to show this
   * column's drop zones. */
  dragActive: boolean;
  /** Non-drag "Move to <column>" (workflow-validated). */
  onMoveToStatus: (specId: string, toStatus: string) => void;
  /** Non-drag reorder within this column (-1 up, +1 down). */
  onMoveWithinColumn: (specId: string, dir: -1 | 1) => void;
  /** When set, a per-column "Add {level}" affordance sits at the column foot;
   * the new item takes this column's status. */
  quickAdd?: { levelKey: string; levelLabel: string; productId: string | null };
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `${COL_PREFIX}${status}` });
  // The column's scroll area, kept alongside the droppable ref so a drag can ask
  // whether this column is taller than it can show. Only an overflowing column
  // gets the edge bars: where you can see the whole column, both ends are
  // already on screen and its open space appends a card anyway.
  const listRef = useRef<HTMLDivElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    if (!dragActive) return;
    const el = listRef.current;
    if (el) setOverflowing(el.scrollHeight > el.clientHeight + 4);
  }, [dragActive]);
  const showEdges = dragActive && !dragDisabled && overflowing;

  // Destinations for a card's Move menu: this column (checked, current) plus the
  // transitions the workflow permits out of it.
  const moveDestinations: MoveOption[] = [
    { key: status, label: statusLabel(status, workflow), current: true },
    ...statusOptions(status, workflow).map((s) => ({
      key: s,
      label: statusLabel(s, workflow),
    })),
  ];
  return (
    <div
      data-board-column
      className="flex w-72 shrink-0 flex-col rounded-md bg-muted/35 p-2.5 max-md:w-[calc(100vw-3rem)] max-md:snap-start"
    >
      <div className="flex items-center gap-2 px-2 py-1.5">
        <StatusDot status={status} />
        <span className="text-sm font-medium">
          {statusLabel(status, workflow)}
        </span>
        <Badge variant="counter" className="ml-auto">
          {cardIds.length}
        </Badge>
      </div>
      <SortableContext items={cardIds} strategy={verticalListSortingStrategy}>
        {/* The edge bars are siblings of the scroll area, not children of it,
            and float over its two edges. dnd-kit rebases a droppable's rect by
            how far its scroll container has scrolled since the drag began, which
            is right for cards (they move with the content) and wrong for
            anything pinned: inside the list, a bar's drop target slid away from
            the bar the moment the column auto-scrolled. */}
        <div className="relative flex min-h-0 flex-1 flex-col">
          {/* The whole scroll area is the column's drop target, and each card
              tiles it edge to edge (the 8px gap between cards is the card's own
              padding, not a dead margin), so there is no sliver you can release
              a card over and have nothing happen. */}
          <div
            ref={(node) => {
              listRef.current = node;
              setNodeRef(node);
            }}
            className={cn(
              "min-h-12 flex-1 rounded-md transition-colors md:min-h-0 md:overflow-y-auto",
              isOver && "bg-muted",
            )}
          >
            {cardIds.map((id, index) => {
              const record = records[id];
              if (!record) return null;
              return (
                <SortableCard key={id} id={id} disabled={dragDisabled}>
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
                        "group relative min-w-0 flex-1 rounded-md",
                        selected.has(id) && "ring-2 ring-primary",
                      )}
                    >
                      <FeatureCard
                        feature={record}
                        fields={cardFields}
                        featured={featured}
                        customFieldLabels={customFieldLabels}
                        customFieldTypes={customFieldTypes}
                        memberNames={memberNames}
                        releaseNames={releaseNames}
                        levels={levels}
                        onOpen={() => onOpen(id)}
                        // Below md there is no drag to protect, so the whole card
                        // stays a tap target. Where it can be dragged, only the
                        // title opens it.
                        clickToOpen={dragDisabled}
                        product={
                          record.productId
                            ? productsById?.[record.productId]
                            : undefined
                        }
                      />
                      {/* The keyboard/pointer alternative to dragging (SC 2.1.1,
                        2.5.7). Revealed on hover/focus on desktop where drag is
                        primary; always visible below md where drag is off. */}
                      {!selectMode ? (
                        <div className="absolute right-1 top-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 max-md:opacity-100 has-[[data-state=open]]:opacity-100">
                          <MoveMenu
                            triggerLabel={`Move ${record.title}`}
                            destinationsLabel="Move to column"
                            destinations={moveDestinations}
                            onSelect={(toStatus) =>
                              onMoveToStatus(id, toStatus)
                            }
                            reorder={{
                              onUp: () => onMoveWithinColumn(id, -1),
                              onDown: () => onMoveWithinColumn(id, 1),
                              canUp: index > 0,
                              canDown: index < cardIds.length - 1,
                            }}
                          />
                        </div>
                      ) : null}
                    </div>
                  </div>
                </SortableCard>
              );
            })}
            {cardIds.length === 0 ? (
              <p className="px-2 pb-2 text-xs text-muted-foreground">Empty</p>
            ) : null}
          </div>
          {showEdges ? (
            <>
              <EdgeDropZone
                id={`${TOP_PREFIX}${status}`}
                edge="top"
                label="Drop at top"
              />
              <EdgeDropZone
                id={`${END_PREFIX}${status}`}
                edge="bottom"
                label="Drop at end"
              />
            </>
          ) : null}
        </div>
      </SortableContext>
      {quickAdd ? (
        <div className="mt-2">
          <ColumnQuickAdd
            levelKey={quickAdd.levelKey}
            levelLabel={quickAdd.levelLabel}
            productId={quickAdd.productId}
            status={status}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * A column's "drop at top" / "drop at end" bar, shown only while a card is in
 * flight. It floats over its edge of the column's scroll area, so the two ends
 * of a column that is taller than the screen stay one move away instead of a
 * drag-scroll away. Positioned out of the flow so a starting drag doesn't
 * displace the list, and the collision detection gives it priority over whatever
 * is underneath.
 */
function EdgeDropZone({
  id,
  edge,
  label,
}: {
  id: string;
  edge: "top" | "bottom";
  label: string;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      aria-hidden
      className={cn(
        // Inert to the pointer: dnd-kit resolves drops from rects, and this way
        // the bar never swallows a hover or click of its own.
        "pointer-events-none absolute inset-x-0 z-20 flex h-9 items-center justify-center rounded-md border border-dashed text-xs font-medium shadow-sm",
        edge === "top" ? "top-0" : "bottom-0",
        // Opaque: it floats over the card at that edge, and a translucent bar
        // left that card's title showing through it.
        isOver
          ? "border-primary bg-primary/20 text-primary"
          : "border-border bg-background text-muted-foreground",
      )}
    >
      {label}
    </div>
  );
}

function SortableCard({
  id,
  disabled,
  children,
}: {
  id: string;
  disabled: boolean;
  children: React.ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1,
      }}
      // The gap between cards is padding here rather than a margin, so a card's
      // droppable rect reaches its neighbor's and a release between two cards
      // still resolves to one of them. The body is the drag handle (the title
      // link opts out of it), hence the grab cursor.
      className={cn("pb-2", !disabled && "cursor-grab active:cursor-grabbing")}
      {...attributes}
      {...listeners}
    >
      {children}
    </div>
  );
}

/**
 * Where a card dropped into a different column (or onto one of a column's edge
 * bars) lands in that column's order: the top bar pins it first, the end bar and
 * any open column space append it, and a drop on a card inserts on whichever
 * side of that card the pointer is nearer. The half-and-half rule is what makes
 * the last slot reachable without scrolling: aim at the bottom of the bottom
 * card and the drop appends rather than pushing that card down.
 */
function dropIndex(
  overId: string,
  target: string[],
  event: DragEndEvent,
): number {
  if (overId.startsWith(TOP_PREFIX)) return 0;
  if (overId.startsWith(END_PREFIX) || overId.startsWith(COL_PREFIX)) {
    return target.length;
  }
  const overIndex = target.indexOf(overId);
  if (overIndex < 0) return target.length;
  const rect = event.over?.rect;
  const start = getEventCoordinates(event.activatorEvent);
  if (!rect || !start) return overIndex;
  const pointerY = start.y + event.delta.y;
  return pointerY > rect.top + rect.height / 2 ? overIndex + 1 : overIndex;
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Group features into per-status ordered specId lists (board order). Cards sort
 * by manual rank by default, by RICE score (highest first), or by a custom
 * property (`cf:<key>`, ascending, empties last) when requested. */
function groupIntoColumns(
  features: FeatureRecord[],
  columns: string[],
  sortMode: SortMode = "default",
  customFieldTypes: Record<string, PropertyType> = {},
): Record<string, string[]> {
  const byStatus = new Map<string, FeatureRecord[]>();
  for (const c of columns) byStatus.set(c, []);
  for (const f of features) byStatus.get(f.status)?.push(f);
  const cfKey = sortMode.startsWith(CUSTOM_SORT_PREFIX)
    ? sortMode.slice(CUSTOM_SORT_PREFIX.length)
    : null;
  const out: Record<string, string[]> = {};
  for (const c of columns) {
    const cards = byStatus.get(c) ?? [];
    const ordered =
      sortMode === "rice"
        ? [...cards].sort(compareByRiceScore)
        : cfKey
          ? [...cards].sort(
              compareByCustomField(cfKey, customFieldTypes[cfKey] ?? "text"),
            )
          : sortBoardCards(cards);
    out[c] = ordered.map((f) => f.specId);
  }
  return out;
}
