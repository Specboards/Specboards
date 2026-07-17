"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import {
  descendantGroupIds,
  MAX_GROUP_DEPTH,
  PRODUCT_COLORS,
  resolveProductColor,
  type ProductColor,
} from "@specboard/core";

import { ProductMembers } from "@/components/product-members";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
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
  ProductGroupRecord,
  ProductRecord,
  ProductVisibility,
} from "@/lib/store/types";
import { cn } from "@/lib/utils";

type Member = { userId: string; name: string; email: string };

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

/**
 * Manage the org's products: create new ones, rename / re-describe / change a
 * product's visibility, manage its members, or delete an empty one. Create is
 * org-admin only; per-product actions need org-admin or that product's admin
 * role (`canManage`). Non-managers see a read-only list.
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
  const [products, setProducts] = useState(initial);
  const [groups, setGroups] = useState(initialGroups);
  const [creating, setCreating] = useState(false);

  function onCreated(product: ProductRecord) {
    setProducts((ps) =>
      [...ps, product].sort((a, b) => a.position - b.position),
    );
  }

  function onUpdated(product: ProductRecord) {
    setProducts((ps) => ps.map((p) => (p.id === product.id ? product : p)));
  }

  function onDeleted(id: string) {
    setProducts((ps) => ps.filter((p) => p.id !== id));
  }

  return (
    <div className="space-y-4">
      {/* Product groups only earn their place once there's more than one
          product to organize. Existing groups keep the card visible even if the
          product count later dips, so they never become unmanageable. */}
      {isOrgAdmin && (products.length > 1 || groups.length > 0) ? (
        <GroupsCard groups={groups} products={products} onChanged={setGroups} />
      ) : null}

      {isOrgAdmin ? (
        <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
          New product
        </Button>
      ) : null}

      <ul className="space-y-2">
        {products.map((product) => (
          <ProductCard
            key={product.id}
            product={product}
            groups={groups}
            members={members}
            canManage={isOrgAdmin || product.viewerRole === "admin"}
            onUpdated={onUpdated}
            onDeleted={onDeleted}
          />
        ))}
      </ul>

      {isOrgAdmin ? (
        <CreateProductSheet
          open={creating}
          onOpenChange={setCreating}
          onCreated={onCreated}
        />
      ) : null}
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

/**
 * Manage the org's product groups (org-admin only): create (optionally under
 * a parent), rename, recolor, reparent, or delete an empty one. Rendered as
 * an indented tree; nesting is capped at MAX_GROUP_DEPTH levels (the server
 * enforces cycles/depth, this UI just narrows the choices). Products join a
 * group via each product's editor below; a group appears in the product
 * switcher and rolls its products' work up on the group dashboard.
 */
function GroupsCard({
  groups,
  products,
  onChanged,
}: {
  groups: ProductGroupRecord[];
  products: ProductRecord[];
  onChanged: (groups: ProductGroupRecord[]) => void;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const rows = flattenGroupTree(groups);
  const depthById = new Map(rows.map((r) => [r.group.id, r.depth]));
  // New groups land under parents that still have room below the depth cap.
  const parentOptions = rows.filter((r) => r.depth + 1 < MAX_GROUP_DEPTH);

  function onAuthError() {
    window.location.href = "/sign-in";
  }

  function onCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    startTransition(async () => {
      setError(null);
      try {
        const group = await createProductGroup({
          name: trimmed,
          parentId: parentId || null,
        });
        onChanged([...groups, group]);
        setName("");
        setParentId("");
        setAdding(false);
        toast.success("Group created");
        router.refresh();
      } catch (err) {
        if (err instanceof AuthRequiredError) return onAuthError();
        setError(err instanceof Error ? err.message : "Create failed.");
      }
    });
  }

  function onSaved(updated: ProductGroupRecord) {
    onChanged(groups.map((g) => (g.id === updated.id ? updated : g)));
    setEditingId(null);
  }

  function onDelete(group: ProductGroupRecord) {
    startTransition(async () => {
      setError(null);
      try {
        await deleteProductGroup(group.id);
        onChanged(groups.filter((g) => g.id !== group.id));
        toast.success("Group deleted");
        router.refresh();
      } catch (err) {
        if (err instanceof AuthRequiredError) return onAuthError();
        setError(err instanceof Error ? err.message : "Delete failed.");
      }
    });
  }

  return (
    <div className="space-y-3 rounded-md border p-3">
      <div>
        <p className="text-sm font-medium">Product groups</p>
        <p className="text-xs text-muted-foreground">
          Group products into parts of your platform, nesting groups up to{" "}
          {MAX_GROUP_DEPTH} levels. A group appears in the product switcher and
          rolls its products&apos; work up on its dashboard.
        </p>
      </div>
      {rows.length > 0 ? (
        <ul className="space-y-1">
          {rows.map(({ group, depth }) => (
            <GroupRow
              key={group.id}
              group={group}
              depth={depth}
              groups={groups}
              depthById={depthById}
              productCount={
                products.filter((p) => p.groupId === group.id).length
              }
              subgroupCount={
                groups.filter((g) => g.parentId === group.id).length
              }
              editing={editingId === group.id}
              onEdit={() => setEditingId(group.id)}
              onCancel={() => setEditingId(null)}
              onSaved={onSaved}
              onDelete={() => onDelete(group)}
              onAuthError={onAuthError}
              busy={pending}
            />
          ))}
        </ul>
      ) : null}
      {/* Start as an "Add group" affordance, not an always-open form: the
          fields only appear once the admin opts in (see the "add" UX rule in
          CLAUDE.md). */}
      {adding ? (
        <form onSubmit={onCreate} className="flex flex-wrap items-center gap-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New group name"
            className="h-8 max-w-xs"
            autoFocus
          />
          {parentOptions.length > 0 ? (
            <Select
              aria-label="Parent group"
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
              className="h-8 w-auto"
            >
              <option value="">Top level</option>
              {parentOptions.map(({ group, depth }) => (
                <option key={group.id} value={group.id}>
                  {`${"  ".repeat(depth)}${group.name}`}
                </option>
              ))}
            </Select>
          ) : null}
          <Button type="submit" size="sm" disabled={pending || !name.trim()}>
            {pending ? "Adding…" : "Add group"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setAdding(false);
              setName("");
              setParentId("");
              setError(null);
            }}
          >
            Cancel
          </Button>
        </form>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setAdding(true)}
        >
          Add group
        </Button>
      )}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

/** One group tree row: indented summary or an inline editor. */
function GroupRow({
  group,
  depth,
  groups,
  depthById,
  productCount,
  subgroupCount,
  editing,
  onEdit,
  onCancel,
  onSaved,
  onDelete,
  onAuthError,
  busy,
}: {
  group: ProductGroupRecord;
  depth: number;
  groups: ProductGroupRecord[];
  depthById: Map<string, number>;
  productCount: number;
  subgroupCount: number;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSaved: (g: ProductGroupRecord) => void;
  onDelete: () => void;
  onAuthError: () => void;
  busy: boolean;
}) {
  const router = useRouter();
  const [color, setColor] = useState<string | null>(group.color);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Legal parents exclude the group's own subtree (a cycle) and any parent
  // whose depth leaves no room for this group's subtree; the server is the
  // real guard, this narrows the menu to choices that can succeed.
  const subtree = descendantGroupIds(groups, group.id);
  const subtreeHeight =
    Math.max(...[...subtree].map((id) => depthById.get(id) ?? depth)) -
    depth +
    1;
  const parentOptions = flattenGroupTree(groups).filter(
    ({ group: candidate, depth: candidateDepth }) =>
      !subtree.has(candidate.id) &&
      candidateDepth + 1 + subtreeHeight <= MAX_GROUP_DEPTH,
  );

  function onSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
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
        router.refresh();
      } catch (err) {
        if (err instanceof AuthRequiredError) return onAuthError();
        setError(err instanceof Error ? err.message : "Save failed.");
      }
    });
  }

  const deletable = productCount === 0 && subgroupCount === 0;

  if (editing) {
    return (
      <li
        className="space-y-3 rounded-md border p-3"
        style={{ marginLeft: `${depth * 1.25}rem` }}
      >
        <form onSubmit={onSave} className="space-y-3">
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
              {parentOptions.map(
                ({ group: candidate, depth: candidateDepth }) => (
                  <option key={candidate.id} value={candidate.id}>
                    {`${"  ".repeat(candidateDepth)}${candidate.name}`}
                  </option>
                ),
              )}
            </Select>
          </label>
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Color
            </span>
            <ColorPicker value={color} onChange={setColor} />
          </div>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </form>
      </li>
    );
  }

  return (
    <li
      className="flex items-center gap-2 text-sm"
      style={{ marginLeft: `${depth * 1.25}rem` }}
    >
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
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </li>
  );
}

const VISIBILITY_LABEL: Record<ProductVisibility, string> = {
  org: "Everyone in org",
  private: "Private",
};

/** One product row: summary, an inline editor, a members panel, and delete. */
function ProductCard({
  product,
  groups,
  members,
  canManage,
  onUpdated,
  onDeleted,
}: {
  product: ProductRecord;
  groups: ProductGroupRecord[];
  members: Member[];
  canManage: boolean;
  onUpdated: (p: ProductRecord) => void;
  onDeleted: (id: string) => void;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [color, setColor] = useState<string | null>(product.color);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onAuthError() {
    window.location.href = "/sign-in";
  }

  function onSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
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
        onUpdated(await updateProduct(product.id, patch));
        setEditing(false);
        toast.success("Product saved");
        router.refresh();
      } catch (err) {
        if (err instanceof AuthRequiredError) return onAuthError();
        setError(err instanceof Error ? err.message : "Save failed.");
      }
    });
  }

  function onDelete() {
    if (!confirm(`Delete “${product.name}”? This can't be undone.`)) return;
    startTransition(async () => {
      setError(null);
      try {
        await deleteProduct(product.id);
        onDeleted(product.id);
        toast.success("Product deleted");
        router.refresh();
      } catch (err) {
        if (err instanceof AuthRequiredError) return onAuthError();
        setError(err instanceof Error ? err.message : "Delete failed.");
      }
    });
  }

  return (
    <li className="rounded-md border p-3">
      {editing ? (
        <form onSubmit={onSave} className="space-y-3">
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
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
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
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "h-2.5 w-2.5 shrink-0 rounded-full",
                productColorClasses(product).dot,
              )}
              aria-hidden
            />
            <span className="font-medium">{product.name}</span>
            {product.visibility === "private" ? (
              <Badge variant="outline" className="text-[10px]">
                Private
              </Badge>
            ) : null}
            {product.groupId ? (
              <Badge variant="outline" className="text-[10px]">
                {groups.find((g) => g.id === product.groupId)?.name ?? "Group"}
              </Badge>
            ) : null}
            <span className="text-xs text-muted-foreground">
              {product.itemCount} {product.itemCount === 1 ? "item" : "items"}
            </span>
            {canManage ? (
              <div className="ml-auto flex items-center gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowMembers((s) => !s)}
                >
                  Members
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setEditing(true)}
                >
                  Edit
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  disabled={pending || product.itemCount > 0}
                  title={
                    product.itemCount > 0
                      ? "Move or remove its items before deleting."
                      : undefined
                  }
                  onClick={onDelete}
                >
                  Delete
                </Button>
              </div>
            ) : null}
          </div>
          {product.description ? (
            <p className="text-sm text-muted-foreground">
              {product.description}
            </p>
          ) : null}
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          {showMembers && canManage ? (
            <div className="border-t pt-3">
              <ProductMembers productId={product.id} candidates={members} />
            </div>
          ) : null}
        </div>
      )}
    </li>
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
