"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { MAX_GROUP_DEPTH } from "@specboards/core";

import {
  deleteProduct,
  deleteProductGroup,
  updateProduct,
  updateProductGroup,
} from "@/lib/api-client/products";
import { redirectOnAuthExpiry } from "@/lib/auth-expiry";
import type { ProductGroupRecord, ProductRecord } from "@/lib/store/types";

import { type GroupMoveRefusal, planGroupMove } from "./drag";
import {
  byPosition,
  childGroupsOf,
  productsOf,
  ungroupedProducts,
} from "./tree";

/**
 * The products and groups a settings page is showing, and every command that
 * changes them.
 *
 * This is the whole mutable half of the screen. Rows are written optimistically
 * because the server round-trip plus `router.refresh()` is long enough that a
 * drag would otherwise snap back before it landed, and each command therefore
 * has to carry its own rollback. Keeping them together is what makes that
 * reviewable: every place a row is written, and every place a failure puts it
 * back, is in this file.
 *
 * What is deliberately not here: which sheet is open, what is mid-drag, and
 * the tree's JSX. Those are presentation and stay in the component. The
 * decisions each command needs (legality, ordering, renumbering) are in
 * `./drag` and `./tree`, and are tested on their own.
 */

/** What a refused group move tells the user. "self" is a no-op, so it is silent. */
const REFUSAL: Record<GroupMoveRefusal, string | null> = {
  self: null,
  cycle: "A group can't move inside its own subtree.",
  depth: `That nesting would exceed the ${MAX_GROUP_DEPTH}-level limit.`,
};

export function useProductTree(
  initialProducts: ProductRecord[],
  initialGroups: ProductGroupRecord[],
) {
  const router = useRouter();
  const [products, setProducts] = useState(initialProducts);
  const [groups, setGroups] = useState(initialGroups);
  const [pending, startTransition] = useTransition();

  /** Report a failure, unless it was an expired session, which navigates. */
  function report(err: unknown, fallback: string) {
    if (redirectOnAuthExpiry(err, router)) return;
    toast.error(err instanceof Error ? err.message : fallback);
  }

  function onProductSaved(product: ProductRecord) {
    setProducts((ps) => ps.map((p) => (p.id === product.id ? product : p)));
  }

  function onProductCreated(product: ProductRecord) {
    setProducts((ps) => [...ps, product].sort(byPosition));
  }

  function onGroupCreated(group: ProductGroupRecord) {
    setGroups((gs) => [...gs, group]);
  }

  function onGroupSaved(updated: ProductGroupRecord) {
    setGroups((gs) => gs.map((g) => (g.id === updated.id ? updated : g)));
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
        report(err, "Delete failed.");
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
        report(err, "Delete failed.");
      }
    });
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
        report(err, "Move failed.");
      });
  }

  function moveGroup(
    dragged: ProductGroupRecord,
    newParent: string | null,
    insertIndex: number | null,
  ) {
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
        report(err, "Move failed.");
      });
  }

  return {
    products,
    groups,
    pending,
    /** Child groups of `parent`, in sibling order; `null` is the top level. */
    childGroups: (parent: string | null) => childGroupsOf(groups, parent),
    /** The products filed under a group, in sibling order. */
    groupProducts: (groupId: string) => productsOf(products, groupId),
    /** The products in no group, in sibling order. */
    ungrouped: ungroupedProducts(products),
    onProductSaved,
    onProductCreated,
    onGroupCreated,
    onGroupSaved,
    onDeleteProduct,
    onDeleteGroup,
    moveProduct,
    moveGroup,
  };
}
