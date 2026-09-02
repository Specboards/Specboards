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
  MAX_GROUP_DEPTH,
  PRODUCT_COLORS,
  resolveProductColor,
  wouldCreateCycle,
  wouldExceedDepth,
  type ProductColor,
} from "@specboards/core";

import { MoveMenu, type MoveOption } from "@/components/move-menu";
import {
  parseDndId,
  planGroupMove,
  resolveDropTarget,
  type GroupMoveRefusal,
} from "@/components/products-manager/drag";
import {
  byPosition,
  childGroupsOf,
  flattenGroupTree,
  legalParentOptions,
  productsOf,
  ungroupedProducts,
} from "@/components/products-manager/tree";
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
  createProduct,
  createProductGroup,
  deleteProduct,
  deleteProductGroup,
  updateProduct,
  updateProductGroup,
} from "@/lib/api-client/products";
import { redirectOnAuthExpiry } from "@/lib/auth-expiry";
import { productDotColor } from "@/lib/product-color";
import type {
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
          "h-6 rounded-full border px-2 text-2xs text-muted-foreground transition",
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
            value === c &&
              "ring-2 ring-ring ring-offset-1 ring-offset-background",
          )}
          style={{ backgroundColor: productDotColor(c) }}
        />
      ))}
    </div>
  );
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

  // Tree reads live in ./products-manager/tree, so the ordering and
  // dangling-parent rules can be tested without rendering the page.
  const childGroups = (parent: string | null) => childGroupsOf(groups, parent);
  const groupProducts = (groupId: string) => productsOf(products, groupId);
  const ungrouped = ungroupedProducts(products);

  function onProductSaved(product: ProductRecord) {
    setProducts((ps) => ps.map((p) => (p.id === product.id ? product : p)));
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
        if (redirectOnAuthExpiry(err, router)) return;
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
        if (redirectOnAuthExpiry(err, router)) return;
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
        if (redirectOnAuthExpiry(err, router)) return;
        toast.error(err instanceof Error ? err.message : "Move failed.");
      });
  }

  /** What a refused move tells the user. "self" is a no-op, so it says nothing. */
  const REFUSAL: Record<GroupMoveRefusal, string | null> = {
    self: null,
    cycle: "A group can't move inside its own subtree.",
    depth: `That nesting would exceed the ${MAX_GROUP_DEPTH}-level limit.`,
  };

  function moveGroup(
    dragged: ProductGroupRecord,
    newParent: string | null,
    insertIndex: number | null,
  ) {
    // The decision (legality, slot compensation, sibling renumbering) is made
    // in ./products-manager/drag; what is left here is acting on it.
    const plan = planGroupMove(groups, dragged.id, newParent, insertIndex);
    if (!plan.ok) {
      const message = REFUSAL[plan.reason];
      if (message) toast.error(message);
      return;
    }
    if (plan.patches.length === 0) return;

    const prevGroups = groups;
    setGroups(plan.groups);
    Promise.all(
      plan.patches.map(({ id, patch }) => updateProductGroup(id, patch)),
    )
      .then(() => {
        toast.success("Group moved");
        router.refresh();
      })
      .catch((err) => {
        setGroups(prevGroups);
        if (redirectOnAuthExpiry(err, router)) return;
        toast.error(err instanceof Error ? err.message : "Move failed.");
      });
  }

  function onDragEnd(event: DragEndEvent) {
    setDrag(null);
    const { active, over } = event;
    if (!over) return;
    const { kind, rest: id } = parseDndId(String(active.id));
    const target = resolveDropTarget(String(over.id));
    if (!target) return;
    const { intoGroup, slotIndex } = target;

    if (kind === "product") {
      const product = products.find((p) => p.id === id);
      if (product) moveProduct(product, intoGroup);
    } else if (kind === "group") {
      const dragged = groups.find((g) => g.id === id);
      if (dragged) moveGroup(dragged, intoGroup, slotIndex);
    }
  }

  // Keys for the non-group destinations in the Move menus (distinct from any
  // real group id).
  const UNGROUPED_KEY = "__ungrouped__";
  const ROOT_KEY = "__root__";

  // The keyboard/pointer alternative to dragging a product between groups
  // (SC 2.1.1, 2.5.7). Only org admins can re-home products, and only once
  // there is a group to move between.
  function productMoveMenu(p: ProductRecord): React.ReactNode {
    if (!isOrgAdmin || groups.length === 0) return null;
    const current = p.groupId ?? UNGROUPED_KEY;
    const destinations: MoveOption[] = [
      {
        key: UNGROUPED_KEY,
        label: "Ungrouped",
        current: current === UNGROUPED_KEY,
      },
      ...groups.map((g) => ({
        key: g.id,
        label: g.name,
        current: g.id === current,
      })),
    ];
    return (
      <MoveMenu
        triggerLabel={`Move ${p.name}`}
        destinationsLabel="Move to group"
        destinations={destinations}
        onSelect={(key) => moveProduct(p, key === UNGROUPED_KEY ? null : key)}
      />
    );
  }

  // The non-drag alternative for a group: nest it under another group (or the
  // top level) and reorder it among its siblings. moveGroup validates cycles and
  // depth; here we pre-filter destinations that would violate them.
  function groupMoveMenu(
    group: ProductGroupRecord,
    parent: string | null,
    index: number,
    siblingCount: number,
  ): React.ReactNode {
    if (!isOrgAdmin) return null;
    const destinations: MoveOption[] = [
      { key: ROOT_KEY, label: "Top level", current: parent === null },
      ...groups
        .filter(
          (g) =>
            g.id !== group.id &&
            !wouldCreateCycle(groups, group.id, g.id) &&
            !wouldExceedDepth(groups, group.id, g.id),
        )
        .map((g) => ({ key: g.id, label: g.name, current: g.id === parent })),
    ];
    return (
      <MoveMenu
        triggerLabel={`Move ${group.name}`}
        destinationsLabel="Move into"
        destinations={destinations}
        onSelect={(key) =>
          moveGroup(group, key === ROOT_KEY ? null : key, null)
        }
        reorder={{
          // Slot indexes count the dragged row itself, so "down" targets
          // index+2 (past the next sibling); see moveGroup's compensation.
          onUp: () => moveGroup(group, parent, index - 1),
          onDown: () => moveGroup(group, parent, index + 2),
          canUp: index > 0,
          canDown: index < siblingCount - 1,
        }}
      />
    );
  }

  /** One tree level: sibling groups (with reorder slots), then leaf products. */
  const renderLevel = (
    parent: string | null,
    depth: number,
  ): React.ReactNode => {
    const siblings = childGroups(parent);
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
              productCount={groupProducts(group.id).length}
              subgroupCount={childGroups(group.id).length}
              onEdit={() => setEditingGroupId(group.id)}
              onDelete={() => onDeleteGroup(group)}
              moveMenu={groupMoveMenu(group, parent, i, siblings.length)}
              busy={pending}
            />
            {renderLevel(group.id, depth + 1)}
            {groupProducts(group.id).map((p) => (
              <ProductRow
                key={p.id}
                product={p}
                depth={depth + 1}
                canManage={isOrgAdmin || p.viewerRole === "admin"}
                canDrag={isOrgAdmin}
                onEdit={() => setEditingProductId(p.id)}
                onDelete={() => onDeleteProduct(p)}
                moveMenu={productMoveMenu(p)}
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
  const showAddGroup = isOrgAdmin && (products.length > 1 || groups.length > 0);

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
          Drag a product onto a group to move it there, or drag a group to nest
          or reorder it (up to {MAX_GROUP_DEPTH} levels). A group appears in the
          product switcher and rolls its products&apos; work up on its
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
              moveMenu={productMoveMenu(p)}
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
  moveMenu,
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
  /** The non-drag Move menu (nest + reorder), or null for non-admins. */
  moveMenu?: React.ReactNode;
  busy: boolean;
}) {
  // We intentionally do not spread dnd-kit's `attributes` onto the row: they set
  // role="button" and tabindex on the <li>, which stops it being a valid list
  // item and makes it an interactive control wrapping the Edit/Delete buttons
  // (axe: list + nested-interactive). Drag is pointer-only; the keyboard /
  // screen-reader accessible alternative is the `moveMenu` in the actions row.
  const {
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
          className="h-2 w-2 shrink-0 rounded-full"
          style={{
            backgroundColor: productDotColor(resolveProductColor(group)),
          }}
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
          {moveMenu}
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
  moveMenu,
  busy,
}: {
  product: ProductRecord;
  depth: number;
  canManage: boolean;
  canDrag: boolean;
  onEdit: () => void;
  onDelete: () => void;
  /** The non-drag "Move to group" menu, or null for non-admins. */
  moveMenu?: React.ReactNode;
  busy: boolean;
}) {
  // See GroupRow: the row deliberately omits dnd-kit's `attributes` so the <li>
  // stays a valid, non-interactive list item. Pointer drag via `listeners`; the
  // keyboard-accessible alternative is the `moveMenu` in the actions row.
  const { listeners, setNodeRef, isDragging } = useDraggable({
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
      {...listeners}
    >
      {canDrag ? (
        <GripVertical
          className="h-3 w-3 shrink-0 text-muted-foreground/50"
          aria-hidden
        />
      ) : null}
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{
          backgroundColor: productDotColor(resolveProductColor(product)),
        }}
        aria-hidden
      />
      <span>{product.name}</span>
      {product.visibility === "private" ? (
        <Badge variant="outline" size="sm">
          Private
        </Badge>
      ) : null}
      <span className="text-xs text-muted-foreground">
        {product.itemCount} {product.itemCount === 1 ? "item" : "items"}
      </span>
      {canManage ? (
        <span className="ml-auto flex items-center gap-1">
          {moveMenu}
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
        if (redirectOnAuthExpiry(err, router)) return;
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
        if (redirectOnAuthExpiry(err, router)) return;
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
        if (redirectOnAuthExpiry(err, router)) return;
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
        if (redirectOnAuthExpiry(err, router)) return;
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
