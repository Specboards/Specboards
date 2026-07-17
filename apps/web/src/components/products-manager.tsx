"use client";

import { useRouter } from "next/navigation";
import { Fragment, useState, useTransition } from "react";
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
import { GripVertical } from "lucide-react";
import { toast } from "sonner";

import {
  descendantGroupIds,
  MAX_GROUP_DEPTH,
  PRODUCT_COLORS,
  resolveProductColor,
  wouldCreateCycle,
  wouldExceedDepth,
  type ProductColor,
} from "@specboard/core";

import { ProductMembers } from "@/components/product-members";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import {
  AuthRequiredError,
  createProduct,
  createProductGroup,
  deleteProduct,
  deleteProductGroup,
  updateProduct,
  updateProductGroup,
} from "@/lib/api-client";
import { colorDot, productColorClasses } from "@/lib/product-color";
import type {
  ProductGroupPatch,
  ProductGroupRecord,
  ProductRecord,
  ProductVisibility,
} from "@/lib/store/types";
import { cn } from "@/lib/utils";

type Member = { userId: string; name: string; email: string };

const VISIBILITY_LABEL: Record<ProductVisibility, string> = {
  org: "Everyone in org",
  private: "Private",
};

/**
 * Pick a product accent color. `null` ("Auto") derives a stable color from the
 * product key; the rest set an explicit palette token.
 */
function ColorPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (color: string | null) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        onClick={() => onChange(null)}
        aria-label="Auto color"
        aria-pressed={value === null}
        className={cn(
          "h-6 rounded-full border px-2 text-[11px] text-muted-foreground transition",
          value === null &&
            "ring-2 ring-ring ring-offset-1 ring-offset-background",
        )}
      >
        Auto
      </button>
      {PRODUCT_COLORS.map((c: ProductColor) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          aria-label={c}
          aria-pressed={value === c}
          className={cn(
            "h-6 w-6 rounded-full transition",
            colorDot(c),
            value === c &&
              "ring-2 ring-ring ring-offset-1 ring-offset-background",
          )}
        />
      ))}
    </div>
  );
}

/** A group flattened for tree display: depth-first, sibling position order. */
interface TreeRow {
  group: ProductGroupRecord;
  depth: number;
}

/** Flatten the group tree depth-first. Cycle/orphan-safe: a dangling parent
 * renders at the top level and every group appears exactly once. */
function flattenGroupTree(groups: ProductGroupRecord[]): TreeRow[] {
  const ids = new Set(groups.map((g) => g.id));
  const byParent = new Map<string | null, ProductGroupRecord[]>();
  for (const g of groups) {
    const parent = g.parentId && ids.has(g.parentId) ? g.parentId : null;
    const list = byParent.get(parent);
    if (list) list.push(g);
    else byParent.set(parent, [g]);
  }
  const out: TreeRow[] = [];
  const walk = (parent: string | null, depth: number, seen: Set<string>) => {
    const siblings = (byParent.get(parent) ?? []).sort(
      (a, b) => a.position - b.position || a.name.localeCompare(b.name),
    );
    for (const g of siblings) {
      if (seen.has(g.id)) continue;
      seen.add(g.id);
      out.push({ group: g, depth });
      walk(g.id, depth + 1, seen);
    }
  };
  walk(null, 0, new Set());
  return out;
}

/** Split a "kind:rest" drag/drop id into its kind and payload. */
function parseDndId(raw: string): { kind: string; rest: string } {
  const i = raw.indexOf(":");
  return { kind: raw.slice(0, i), rest: raw.slice(i + 1) };
}

/**
 * Manage the org's products and product groups in one tree: groups as nodes
 * (nesting up to MAX_GROUP_DEPTH levels), products as leaf rows, and
 * ungrouped products at the bottom. Org admins drag rows to reorganize (a
 * product onto a group to move it there, a group onto a group to nest it, a
 * group onto the bar between rows to reorder siblings) and edit any row via a
 * drawer; per-product admins can edit their products. Everyone else sees the
 * tree read-only. Groups appear in the product switcher and roll their
 * products' work up on the group dashboard.
 */
export function ProductsManager({
  products: initial,
  groups: initialGroups = [],
  members,
  isOrgAdmin,
}: {
  products: ProductRecord[];
  groups?: ProductGroupRecord[];
  members: Member[];
  isOrgAdmin: boolean;
}) {
  const router = useRouter();
  const [products, setProducts] = useState(initial);
  const [groups, setGroups] = useState(initialGroups);
  const [creatingProduct, setCreatingProduct] = useState(false);
  const [addingGroup, setAddingGroup] = useState(false);
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // What is being dragged right now (drives slot visibility and the overlay).
  const [drag, setDrag] = useState<{
    kind: "group" | "product";
    label: string;
  } | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const groupIds = new Set(groups.map((g) => g.id));
  /** A group's effective parent; a dangling parent id renders at top level. */
  const parentOf = (g: ProductGroupRecord) =>
    g.parentId && groupIds.has(g.parentId) ? g.parentId : null;
  const childGroupsOf = (parent: string | null) =>
    groups
      .filter((g) => parentOf(g) === parent)
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  const byPosition = (a: ProductRecord, b: ProductRecord) =>
    a.position - b.position || a.name.localeCompare(b.name);
  const productsOf = (groupId: string) =>
    products.filter((p) => p.groupId === groupId).sort(byPosition);
  const ungrouped = products.filter((p) => !p.groupId).sort(byPosition);

  function onProductSaved(product: ProductRecord) {
    setProducts((ps) => ps.map((p) => (p.id === product.id ? product : p)));
  }

  function onAuthError() {
    window.location.href = "/sign-in";
  }

  function onDeleteProduct(product: ProductRecord) {
    if (!confirm(`Delete “${product.name}”? This can't be undone.`)) return;
    startTransition(async () => {
      try {
        await deleteProduct(product.id);
        setProducts((ps) => ps.filter((p) => p.id !== product.id));
        toast.success("Product deleted");
        router.refresh();
      } catch (err) {
        if (err instanceof AuthRequiredError) return onAuthError();
        toast.error(err instanceof Error ? err.message : "Delete failed.");
      }
    });
  }

  function onDeleteGroup(group: ProductGroupRecord) {
    startTransition(async () => {
      try {
        await deleteProductGroup(group.id);
        setGroups((gs) => gs.filter((g) => g.id !== group.id));
        toast.success("Group deleted");
        router.refresh();
      } catch (err) {
        if (err instanceof AuthRequiredError) return onAuthError();
        toast.error(err instanceof Error ? err.message : "Delete failed.");
      }
    });
  }

  function onDragStart(event: DragStartEvent) {
    const { kind, rest } = parseDndId(String(event.active.id));
    if (kind !== "group" && kind !== "product") return;
    const label =
      kind === "group"
        ? (groups.find((g) => g.id === rest)?.name ?? "")
        : (products.find((p) => p.id === rest)?.name ?? "");
    setDrag({ kind, label });
  }

  function moveProduct(product: ProductRecord, newGroupId: string | null) {
    if ((product.groupId ?? null) === newGroupId) return;
    const prev = product;
    const groupName = newGroupId
      ? (groups.find((g) => g.id === newGroupId)?.name ?? "group")
      : null;
    // Optimistically re-home the leaf, then persist and revalidate.
    onProductSaved({ ...product, groupId: newGroupId });
    updateProduct(product.id, { groupId: newGroupId })
      .then((updated) => {
        onProductSaved(updated);
        toast.success(
          groupName
            ? `${product.name} moved to ${groupName}`
            : `${product.name} ungrouped`,
        );
        router.refresh();
      })
      .catch((err) => {
        onProductSaved(prev);
        if (err instanceof AuthRequiredError) return onAuthError();
        toast.error(err instanceof Error ? err.message : "Move failed.");
      });
  }

  function moveGroup(
    dragged: ProductGroupRecord,
    newParent: string | null,
    insertIndex: number | null,
  ) {
    if (newParent === dragged.id) return;
    if (wouldCreateCycle(groups, dragged.id, newParent)) {
      toast.error("A group can't move inside its own subtree.");
      return;
    }
    if (wouldExceedDepth(groups, dragged.id, newParent)) {
      toast.error(
        `That nesting would exceed the ${MAX_GROUP_DEPTH}-level limit.`,
      );
      return;
    }

    const oldParent = parentOf(dragged);
    // Slot indexes count the dragged row itself when it already sits among the
    // target siblings; compensate so the drop lands where the bar showed.
    let index = insertIndex;
    if (index !== null && oldParent === newParent) {
      const orig = childGroupsOf(newParent).findIndex(
        (g) => g.id === dragged.id,
      );
      if (orig >= 0 && orig < index) index -= 1;
    }
    const siblings = childGroupsOf(newParent).filter(
      (g) => g.id !== dragged.id,
    );
    const at =
      index === null ? siblings.length : Math.min(index, siblings.length);
    const order = [...siblings.slice(0, at), dragged, ...siblings.slice(at)];

    // Renumber the target siblings 0..n and patch only what changed (position
    // is an integer column, so a clean insert needs its neighbors renumbered).
    const patches: { id: string; patch: ProductGroupPatch }[] = [];
    order.forEach((g, i) => {
      const patch: ProductGroupPatch = {};
      if (g.position !== i) patch.position = i;
      if (g.id === dragged.id && oldParent !== newParent) {
        patch.parentId = newParent;
      }
      if (Object.keys(patch).length > 0) patches.push({ id: g.id, patch });
    });
    if (patches.length === 0) return;

    const prevGroups = groups;
    const posById = new Map(order.map((g, i) => [g.id, i]));
    setGroups(
      groups.map((g) => ({
        ...g,
        position: posById.get(g.id) ?? g.position,
        parentId: g.id === dragged.id ? newParent : g.parentId,
      })),
    );
    Promise.all(patches.map(({ id, patch }) => updateProductGroup(id, patch)))
      .then(() => {
        toast.success("Group moved");
        router.refresh();
      })
      .catch((err) => {
        setGroups(prevGroups);
        if (err instanceof AuthRequiredError) return onAuthError();
        toast.error(err instanceof Error ? err.message : "Move failed.");
      });
  }

  function onDragEnd(event: DragEndEvent) {
    setDrag(null);
    const { active, over } = event;
    if (!over) return;
    const { kind, rest: id } = parseDndId(String(active.id));
    const target = parseDndId(String(over.id));

    // Resolve the drop target to a destination parent/group (+ slot index).
    let intoGroup: string | null;
    let slotIndex: number | null = null;
    if (target.kind === "into") {
      intoGroup = target.rest;
    } else if (target.kind === "slot") {
      const cut = target.rest.lastIndexOf(":");
      const parent = target.rest.slice(0, cut);
      intoGroup = parent === "root" ? null : parent;
      slotIndex = Number(target.rest.slice(cut + 1));
    } else if (target.kind === "ungrouped") {
      intoGroup = null;
    } else {
      return;
    }

    if (kind === "product") {
      const product = products.find((p) => p.id === id);
      if (product) moveProduct(product, intoGroup);
    } else if (kind === "group") {
      const dragged = groups.find((g) => g.id === id);
      if (dragged) moveGroup(dragged, intoGroup, slotIndex);
    }
  }

  /** One tree level: sibling groups (with reorder slots), then leaf products. */
  const renderLevel = (
    parent: string | null,
    depth: number,
  ): React.ReactNode => {
    const siblings = childGroupsOf(parent);
    return (
      <>
        {siblings.map((group, i) => (
          <Fragment key={group.id}>
            <DropSlot
              id={`slot:${parent ?? "root"}:${i}`}
              depth={depth}
              active={drag !== null}
            />
            <GroupRow
              group={group}
              depth={depth}
              canManage={isOrgAdmin}
              canDrag={isOrgAdmin}
              productCount={productsOf(group.id).length}
              subgroupCount={childGroupsOf(group.id).length}
              onEdit={() => setEditingGroupId(group.id)}
              onDelete={() => onDeleteGroup(group)}
              busy={pending}
            />
            {renderLevel(group.id, depth + 1)}
            {productsOf(group.id).map((p) => (
              <ProductRow
                key={p.id}
                product={p}
                depth={depth + 1}
                canManage={isOrgAdmin || p.viewerRole === "admin"}
                canDrag={isOrgAdmin}
                onEdit={() => setEditingProductId(p.id)}
                onDelete={() => onDeleteProduct(p)}
                busy={pending}
              />
            ))}
          </Fragment>
        ))}
        {siblings.length > 0 || drag !== null ? (
          <DropSlot
            id={`slot:${parent ?? "root"}:${siblings.length}`}
            depth={depth}
            active={drag !== null}
          />
        ) : null}
      </>
    );
  };

  const editingProduct = products.find((p) => p.id === editingProductId);
  const editingGroup = groups.find((g) => g.id === editingGroupId);
  // Groups only earn their affordance once there's more than one product to
  // organize; existing groups keep it visible so they never become
  // unmanageable.
  const showAddGroup =
    isOrgAdmin && (products.length > 1 || groups.length > 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {isOrgAdmin ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setCreatingProduct(true)}
          >
            New product
          </Button>
        ) : null}
        {showAddGroup ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setAddingGroup(true)}
          >
            Add group
          </Button>
        ) : null}
      </div>

      {showAddGroup && groups.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Drag a product onto a group to move it there, or drag a group to
          nest or reorder it (up to {MAX_GROUP_DEPTH} levels). A group appears
          in the product switcher and rolls its products&apos; work up on its
          dashboard.
        </p>
      ) : null}

      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setDrag(null)}
      >
        {groups.length > 0 ? (
          <ul className="space-y-0.5">{renderLevel(null, 0)}</ul>
        ) : null}
        <UngroupedZone
          framed={groups.length > 0}
          show={ungrouped.length > 0 || drag?.kind === "product"}
        >
          {ungrouped.map((p) => (
            <ProductRow
              key={p.id}
              product={p}
              depth={0}
              canManage={isOrgAdmin || p.viewerRole === "admin"}
              canDrag={isOrgAdmin && groups.length > 0}
              onEdit={() => setEditingProductId(p.id)}
              onDelete={() => onDeleteProduct(p)}
              busy={pending}
            />
          ))}
        </UngroupedZone>
        <DragOverlay>
          {drag ? (
            <div className="w-fit rounded-md border bg-background px-2.5 py-1 text-sm shadow-md">
              {drag.label}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {isOrgAdmin ? (
        <CreateProductSheet
          open={creatingProduct}
          onOpenChange={setCreatingProduct}
          onCreated={(product) =>
            setProducts((ps) => [...ps, product].sort(byPosition))
          }
        />
      ) : null}
      {isOrgAdmin ? (
        <CreateGroupSheet
          open={addingGroup}
          onOpenChange={setAddingGroup}
          groups={groups}
          onCreated={(group) => setGroups((gs) => [...gs, group])}
        />
      ) : null}
      <EditProductSheet
        product={editingProduct ?? null}
        groups={groups}
        members={members}
        onOpenChange={(open) => {
          if (!open) setEditingProductId(null);
        }}
        onSaved={onProductSaved}
      />
      {isOrgAdmin ? (
        <EditGroupSheet
          group={editingGroup ?? null}
          groups={groups}
          onOpenChange={(open) => {
            if (!open) setEditingGroupId(null);
          }}
          onSaved={(updated) =>
            setGroups((gs) =>
              gs.map((g) => (g.id === updated.id ? updated : g)),
            )
          }
        />
      ) : null}
    </div>
  );
}

/**
 * A thin insertion bar between sibling group rows. Invisible until a drag is
 * active; dropping a group here reorders it among these siblings (dropping a
 * product here files it into the surrounding parent).
 */
function DropSlot({
  id,
  depth,
  active,
}: {
  id: string;
  depth: number;
  active: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id, disabled: !active });
  return (
    <li
      ref={setNodeRef}
      aria-hidden
      style={{ marginLeft: `${depth * 1.25}rem` }}
      className={cn(
        "h-1 rounded transition-colors",
        active && "h-2",
        active && isOver && "bg-ring/60",
      )}
    />
  );
}

/** One group node in the tree: name, roll-up counts, and admin actions.
 * Draggable to nest/reorder; a drop target for products and other groups. */
function GroupRow({
  group,
  depth,
  canManage,
  canDrag,
  productCount,
  subgroupCount,
  onEdit,
  onDelete,
  busy,
}: {
  group: ProductGroupRecord;
  depth: number;
  canManage: boolean;
  canDrag: boolean;
  productCount: number;
  subgroupCount: number;
  onEdit: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({ id: `group:${group.id}`, disabled: !canDrag });
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `into:${group.id}`,
    disabled: !canDrag,
  });

  const deletable = productCount === 0 && subgroupCount === 0;

  return (
    <li
      ref={(node) => {
        setDragRef(node);
        setDropRef(node);
      }}
      className={cn(
        "flex items-center gap-2 rounded px-1 py-1 text-sm",
        canDrag && "cursor-grab active:cursor-grabbing",
        isOver && "bg-muted ring-1 ring-ring/40",
      )}
      style={{
        marginLeft: `${depth * 1.25}rem`,
        opacity: isDragging ? 0.4 : 1,
      }}
      {...attributes}
      {...listeners}
    >
      {canDrag ? (
        <GripVertical
          className="h-3 w-3 shrink-0 text-muted-foreground/50"
          aria-hidden
        />
      ) : null}
      {group.color ? (
        <span
          className={cn(
            "h-2 w-2 shrink-0 rounded-full",
            colorDot(resolveProductColor(group)),
          )}
          aria-hidden
        />
      ) : null}
      <span className="font-medium">{group.name}</span>
      <span className="text-xs text-muted-foreground">
        {productCount} {productCount === 1 ? "product" : "products"}
        {subgroupCount > 0
          ? ` · ${subgroupCount} ${subgroupCount === 1 ? "subgroup" : "subgroups"}`
          : ""}
      </span>
      {canManage ? (
        <span className="ml-auto flex items-center gap-1">
          <Button type="button" size="sm" variant="ghost" onClick={onEdit}>
            Edit
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-destructive"
            disabled={busy || !deletable}
            title={
              deletable
                ? undefined
                : "Move its products and subgroups out before deleting."
            }
            onClick={onDelete}
          >
            Delete
          </Button>
        </span>
      ) : null}
    </li>
  );
}

/** One product leaf in the tree: identity, item count, and (for managers)
 * Edit/Delete. Draggable onto a group (or the ungrouped zone) to re-home it;
 * everything else lives in the edit drawer. */
function ProductRow({
  product,
  depth,
  canManage,
  canDrag,
  onEdit,
  onDelete,
  busy,
}: {
  product: ProductRecord;
  depth: number;
  canManage: boolean;
  canDrag: boolean;
  onEdit: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `product:${product.id}`,
    disabled: !canDrag,
  });
  return (
    <li
      ref={setNodeRef}
      style={{
        marginLeft: `${depth * 1.25}rem`,
        opacity: isDragging ? 0.4 : 1,
      }}
      className={cn(
        "flex items-center gap-2 rounded px-1 py-1 text-sm",
        canDrag && "cursor-grab active:cursor-grabbing",
      )}
      {...attributes}
      {...listeners}
    >
      {canDrag ? (
        <GripVertical
          className="h-3 w-3 shrink-0 text-muted-foreground/50"
          aria-hidden
        />
      ) : null}
      <span
        className={cn(
          "h-2 w-2 shrink-0 rounded-full",
          productColorClasses(product).dot,
        )}
        aria-hidden
      />
      <span>{product.name}</span>
      {product.visibility === "private" ? (
        <Badge variant="outline" className="text-[10px]">
          Private
        </Badge>
      ) : null}
      <span className="text-xs text-muted-foreground">
        {product.itemCount} {product.itemCount === 1 ? "item" : "items"}
      </span>
      {canManage ? (
        <span className="ml-auto flex items-center gap-1">
          <Button type="button" size="sm" variant="ghost" onClick={onEdit}>
            Edit
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-destructive"
            disabled={busy || product.itemCount > 0}
            title={
              product.itemCount > 0
                ? "Move or remove its items before deleting."
                : undefined
            }
            onClick={onDelete}
          >
            Delete
          </Button>
        </span>
      ) : null}
    </li>
  );
}

/** Products outside any group, doubling as the drop target that takes a
 * product out of its group. Unframed when there are no groups (it IS the
 * product list then); framed and labeled once a tree sits above it. */
function UngroupedZone({
  children,
  framed,
  show,
}: {
  children: React.ReactNode;
  framed: boolean;
  show: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: "ungrouped:" });
  if (!show) return null;
  if (!framed) return <ul className="space-y-0.5">{children}</ul>;
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "rounded-md border border-dashed p-2 transition-colors",
        isOver && "bg-muted",
      )}
    >
      <p className="text-xs font-medium text-muted-foreground">Ungrouped</p>
      <ul className="mt-1 space-y-0.5">{children}</ul>
      {!Array.isArray(children) || children.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Drop a product here to take it out of its group.
        </p>
      ) : null}
    </div>
  );
}

/** Parent choices for a group being created or moved: every group with room
 * below the depth cap, excluding (when editing) the group's own subtree. */
function legalParentOptions(
  groups: ProductGroupRecord[],
  editing: ProductGroupRecord | null,
): TreeRow[] {
  const rows = flattenGroupTree(groups);
  if (!editing) return rows.filter((r) => r.depth + 1 < MAX_GROUP_DEPTH);
  const depthById = new Map(rows.map((r) => [r.group.id, r.depth]));
  const depth = depthById.get(editing.id) ?? 0;
  const subtree = descendantGroupIds(groups, editing.id);
  const subtreeHeight =
    Math.max(...[...subtree].map((id) => depthById.get(id) ?? depth)) -
    depth +
    1;
  return rows.filter(
    ({ group: candidate, depth: candidateDepth }) =>
      !subtree.has(candidate.id) &&
      candidateDepth + 1 + subtreeHeight <= MAX_GROUP_DEPTH,
  );
}

/** "Add group" drawer (org-admin only). */
function CreateGroupSheet({
  open,
  onOpenChange,
  groups,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: ProductGroupRecord[];
  onCreated: (g: ProductGroupRecord) => void;
}) {
  const router = useRouter();
  const [color, setColor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const parentOptions = legalParentOptions(groups, null);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const name = String(data.get("name") ?? "").trim();
    if (!name) {
      setError("Name is required.");
      return;
    }
    const parentId = String(data.get("parentId") ?? "") || null;
    startTransition(async () => {
      setError(null);
      try {
        onCreated(await createProductGroup({ name, parentId, color }));
        toast.success("Group created");
        onOpenChange(false);
        setColor(null);
        router.refresh();
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          router.push("/sign-in");
          return;
        }
        setError(err instanceof Error ? err.message : "Create failed.");
      }
    });
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Add group</SheetTitle>
        </SheetHeader>
        <form onSubmit={onSubmit} className="space-y-3">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Name
            </span>
            <Input name="name" autoFocus className="h-8" />
          </label>
          {parentOptions.length > 0 ? (
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                Parent group
              </span>
              <Select name="parentId" defaultValue="" className="h-8">
                <option value="">Top level</option>
                {parentOptions.map(({ group, depth }) => (
                  <option key={group.id} value={group.id}>
                    {`${"  ".repeat(depth)}${group.name}`}
                  </option>
                ))}
              </Select>
            </label>
          ) : null}
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Color
            </span>
            <ColorPicker value={color} onChange={setColor} />
          </div>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Creating…" : "Create group"}
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}

/** Edit drawer for a group: name, parent, color. */
function EditGroupSheet({
  group,
  groups,
  onOpenChange,
  onSaved,
}: {
  group: ProductGroupRecord | null;
  groups: ProductGroupRecord[];
  onOpenChange: (open: boolean) => void;
  onSaved: (g: ProductGroupRecord) => void;
}) {
  const router = useRouter();
  const [color, setColor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // Track which group the color state belongs to, so opening a different
  // group re-seeds it (a Sheet stays mounted between opens).
  const [colorFor, setColorFor] = useState<string | null>(null);
  if (group && colorFor !== group.id) {
    setColorFor(group.id);
    setColor(group.color);
  }

  const parentOptions = group ? legalParentOptions(groups, group) : [];

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!group) return;
    const data = new FormData(e.currentTarget);
    const name = String(data.get("name") ?? "").trim();
    if (!name) {
      setError("Name is required.");
      return;
    }
    const patch = {
      name,
      color,
      parentId: String(data.get("parentId") ?? "") || null,
    };
    startTransition(async () => {
      setError(null);
      try {
        onSaved(await updateProductGroup(group.id, patch));
        toast.success("Group saved");
        onOpenChange(false);
        router.refresh();
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          router.push("/sign-in");
          return;
        }
        setError(err instanceof Error ? err.message : "Save failed.");
      }
    });
  }

  return (
    <Sheet open={group !== null} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Edit group</SheetTitle>
        </SheetHeader>
        {group ? (
          <form key={group.id} onSubmit={onSubmit} className="space-y-3">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                Name
              </span>
              <Input
                name="name"
                defaultValue={group.name}
                className="h-8"
                autoFocus
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                Parent group
              </span>
              <Select
                name="parentId"
                defaultValue={group.parentId ?? ""}
                className="h-8"
              >
                <option value="">Top level</option>
                {parentOptions.map(({ group: candidate, depth }) => (
                  <option key={candidate.id} value={candidate.id}>
                    {`${"  ".repeat(depth)}${candidate.name}`}
                  </option>
                ))}
              </Select>
            </label>
            <div className="space-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                Color
              </span>
              <ColorPicker value={color} onChange={setColor} />
            </div>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </form>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

/** Edit drawer for a product: details, visibility, group, color, members. */
function EditProductSheet({
  product,
  groups,
  members,
  onOpenChange,
  onSaved,
}: {
  product: ProductRecord | null;
  groups: ProductGroupRecord[];
  members: Member[];
  onOpenChange: (open: boolean) => void;
  onSaved: (p: ProductRecord) => void;
}) {
  const router = useRouter();
  const [color, setColor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // Re-seed the color swatch when a different product opens (see
  // EditGroupSheet for why).
  const [colorFor, setColorFor] = useState<string | null>(null);
  if (product && colorFor !== product.id) {
    setColorFor(product.id);
    setColor(product.color);
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!product) return;
    const data = new FormData(e.currentTarget);
    const name = String(data.get("name") ?? "").trim();
    if (!name) {
      setError("Name is required.");
      return;
    }
    const patch = {
      name,
      description: String(data.get("description") ?? "").trim() || null,
      visibility: String(data.get("visibility")) as ProductVisibility,
      color,
      // Only sent when the group select is rendered (there are groups).
      ...(groups.length > 0
        ? { groupId: String(data.get("groupId") ?? "") || null }
        : {}),
    };
    startTransition(async () => {
      setError(null);
      try {
        onSaved(await updateProduct(product.id, patch));
        toast.success("Product saved");
        onOpenChange(false);
        router.refresh();
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          router.push("/sign-in");
          return;
        }
        setError(err instanceof Error ? err.message : "Save failed.");
      }
    });
  }

  return (
    <Sheet open={product !== null} onOpenChange={onOpenChange}>
      <SheetContent className="overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Edit product</SheetTitle>
        </SheetHeader>
        {product ? (
          <div className="space-y-4">
            <form key={product.id} onSubmit={onSubmit} className="space-y-3">
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  Name
                </span>
                <Input
                  name="name"
                  defaultValue={product.name}
                  className="h-8"
                  autoFocus
                />
              </label>
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  Description
                </span>
                <Textarea
                  name="description"
                  defaultValue={product.description ?? ""}
                  rows={2}
                />
              </label>
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  Visibility
                </span>
                <Select
                  name="visibility"
                  defaultValue={product.visibility}
                  className="h-8"
                >
                  <option value="org">{VISIBILITY_LABEL.org}</option>
                  <option value="private">{VISIBILITY_LABEL.private}</option>
                </Select>
              </label>
              {groups.length > 0 ? (
                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-muted-foreground">
                    Group
                  </span>
                  <Select
                    name="groupId"
                    defaultValue={product.groupId ?? ""}
                    className="h-8"
                  >
                    <option value="">No group</option>
                    {flattenGroupTree(groups).map(({ group, depth }) => (
                      <option key={group.id} value={group.id}>
                        {`${"  ".repeat(depth)}${group.name}`}
                      </option>
                    ))}
                  </Select>
                </label>
              ) : null}
              <div className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  Color
                </span>
                <ColorPicker value={color} onChange={setColor} />
              </div>
              {error ? (
                <p className="text-xs text-destructive">{error}</p>
              ) : null}
              <Button type="submit" size="sm" disabled={pending}>
                {pending ? "Saving…" : "Save"}
              </Button>
            </form>
            <Separator />
            <ProductMembers productId={product.id} candidates={members} />
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

/** "New product" drawer (org-admin only). */
function CreateProductSheet({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (p: ProductRecord) => void;
}) {
  const router = useRouter();
  const [color, setColor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const name = String(data.get("name") ?? "").trim();
    if (!name) {
      setError("Name is required.");
      return;
    }
    const input = {
      name,
      description: String(data.get("description") ?? "").trim() || null,
      visibility: String(data.get("visibility")) as ProductVisibility,
      color,
    };
    startTransition(async () => {
      setError(null);
      try {
        onCreated(await createProduct(input));
        toast.success("Product created");
        onOpenChange(false);
        router.refresh();
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          router.push("/sign-in");
          return;
        }
        setError(err instanceof Error ? err.message : "Create failed.");
      }
    });
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>New product</SheetTitle>
        </SheetHeader>
        <form onSubmit={onSubmit} className="space-y-3">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Name
            </span>
            <Input name="name" autoFocus className="h-8" />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Description
            </span>
            <Textarea name="description" rows={2} />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Visibility
            </span>
            <Select name="visibility" defaultValue="org" className="h-8">
              <option value="org">{VISIBILITY_LABEL.org}</option>
              <option value="private">{VISIBILITY_LABEL.private}</option>
            </Select>
          </label>
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Color
            </span>
            <ColorPicker value={color} onChange={setColor} />
          </div>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Creating…" : "Create product"}
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}
