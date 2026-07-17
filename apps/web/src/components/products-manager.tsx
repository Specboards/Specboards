"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { PRODUCT_COLORS, type ProductColor } from "@specboard/core";

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
          value === null && "ring-2 ring-ring ring-offset-1 ring-offset-background",
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
            value === c && "ring-2 ring-ring ring-offset-1 ring-offset-background",
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
      {isOrgAdmin ? (
        <GroupsCard
          groups={groups}
          products={products}
          onChanged={setGroups}
        />
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

/**
 * Manage the org's product groups (org-admin only): create one, delete an
 * empty one. Products join a group via each product's editor below; a group
 * scopes the Board/Roadmap through the product switcher and rolls its
 * products' content up for management visibility.
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
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    startTransition(async () => {
      setError(null);
      try {
        const group = await createProductGroup({ name: trimmed });
        onChanged([...groups, group]);
        setName("");
        toast.success("Group created");
        router.refresh();
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          window.location.href = "/sign-in";
          return;
        }
        setError(err instanceof Error ? err.message : "Create failed.");
      }
    });
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
        if (err instanceof AuthRequiredError) {
          window.location.href = "/sign-in";
          return;
        }
        setError(err instanceof Error ? err.message : "Delete failed.");
      }
    });
  }

  return (
    <div className="space-y-3 rounded-md border p-3">
      <div>
        <p className="text-sm font-medium">Product groups</p>
        <p className="text-xs text-muted-foreground">
          Group products into parts of your platform. A group appears in the
          product switcher and rolls up its products&apos; work.
        </p>
      </div>
      {groups.length > 0 ? (
        <ul className="space-y-1">
          {groups.map((group) => {
            const count = products.filter((p) => p.groupId === group.id).length;
            return (
              <li key={group.id} className="flex items-center gap-2 text-sm">
                <span className="font-medium">{group.name}</span>
                <span className="text-xs text-muted-foreground">
                  {count} {count === 1 ? "product" : "products"}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="ml-auto text-destructive"
                  disabled={pending || count > 0}
                  title={
                    count > 0
                      ? "Move its products out of the group before deleting."
                      : undefined
                  }
                  onClick={() => onDelete(group)}
                >
                  Delete
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <form onSubmit={onCreate} className="flex items-center gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New group name"
          className="h-8 max-w-xs"
        />
        <Button type="submit" size="sm" variant="outline" disabled={pending || !name.trim()}>
          {pending ? "Adding…" : "Add group"}
        </Button>
      </form>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
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
            <span className="text-xs font-medium text-muted-foreground">Name</span>
            <Input name="name" defaultValue={product.name} className="h-8" autoFocus />
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
            <span className="text-xs font-medium text-muted-foreground">Color</span>
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
              className={cn("h-2.5 w-2.5 shrink-0 rounded-full", productColorClasses(product).dot)}
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
            <p className="text-sm text-muted-foreground">{product.description}</p>
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
            <span className="text-xs font-medium text-muted-foreground">Name</span>
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
            <span className="text-xs font-medium text-muted-foreground">Color</span>
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
