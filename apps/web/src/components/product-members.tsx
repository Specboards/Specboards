"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import {
  AuthRequiredError,
  listProductMembers,
  removeProductMember,
  setProductMember,
} from "@/lib/api-client";
import type { ProductMemberRecord, ProductRole } from "@/lib/store/types";

const ROLES: ProductRole[] = ["admin", "contributor", "viewer"];

/** Display labels for the per-product roles. */
const ROLE_LABEL: Record<ProductRole, string> = {
  admin: "Admin",
  contributor: "Contributor",
  viewer: "Viewer",
};

/**
 * Per-product membership editor. Lazy-loads the product's members on mount
 * (it's only rendered once a manager expands a product), then lets a manager
 * grant a workspace member a role, change it, or revoke it. Grants matter for
 * private products — they're what lets a non-admin see and edit the backlog.
 */
export function ProductMembers({
  productId,
  candidates,
}: {
  productId: string;
  /** Workspace members available to grant access to. */
  candidates: { userId: string; name: string; email: string }[];
}) {
  const [members, setMembers] = useState<ProductMemberRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let active = true;
    listProductMembers(productId)
      .then((m) => {
        if (active) setMembers(m);
      })
      .catch((err: unknown) => {
        if (active) {
          setError(err instanceof Error ? err.message : "Failed to load members.");
          setMembers([]);
        }
      });
    return () => {
      active = false;
    };
  }, [productId]);

  function onAuthError() {
    window.location.href = "/sign-in";
  }

  function upsert(userId: string, role: ProductRole) {
    startTransition(async () => {
      setError(null);
      try {
        await setProductMember(productId, { userId, role });
        setMembers(await listProductMembers(productId));
      } catch (err) {
        if (err instanceof AuthRequiredError) return onAuthError();
        setError(err instanceof Error ? err.message : "Update failed.");
      }
    });
  }

  function remove(userId: string) {
    startTransition(async () => {
      setError(null);
      try {
        await removeProductMember(productId, userId);
        setMembers((ms) => ms?.filter((m) => m.userId !== userId) ?? null);
      } catch (err) {
        if (err instanceof AuthRequiredError) return onAuthError();
        setError(err instanceof Error ? err.message : "Remove failed.");
      }
    });
  }

  if (members === null) {
    return <p className="text-xs text-muted-foreground">Loading members…</p>;
  }

  const memberIds = new Set(members.map((m) => m.userId));
  const addable = candidates.filter((c) => !memberIds.has(c.userId));

  return (
    <div className="space-y-3">
      {members.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No explicit members. Org admins always have access.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {members.map((m) => (
            <li key={m.userId} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate">
                {m.name}
                <span className="ml-1.5 text-xs text-muted-foreground">
                  {m.email}
                </span>
              </span>
              <Select
                value={m.role}
                disabled={pending}
                onChange={(e) => upsert(m.userId, e.target.value as ProductRole)}
                className="h-8 w-28"
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </Select>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={pending}
                className="text-muted-foreground"
                onClick={() => remove(m.userId)}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      {addable.length > 0 ? (
        <div className="flex items-center gap-2">
          <Select
            defaultValue=""
            disabled={pending}
            className="h-8"
            onChange={(e) => {
              if (e.target.value) {
                upsert(e.target.value, "viewer");
                e.currentTarget.value = "";
              }
            }}
          >
            <option value="">Add a member…</option>
            {addable.map((c) => (
              <option key={c.userId} value={c.userId}>
                {c.name}
              </option>
            ))}
          </Select>
          <span className="text-xs text-muted-foreground">added as viewer</span>
        </div>
      ) : null}

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
