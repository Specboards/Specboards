"use client";

import { useEffect, useState, useTransition } from "react";
import { ChevronDown } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  AuthRequiredError,
  listProductMembers,
  removeProductMember,
  setProductMember,
} from "@/lib/api-client";
import type { ProductMemberRecord, ProductRole } from "@/lib/store/types";
import { cn } from "@/lib/utils";

const ROLES: ProductRole[] = ["admin", "contributor", "viewer"];

/** Display labels for the per-product roles. */
const ROLE_LABEL: Record<ProductRole, string> = {
  admin: "Admin",
  contributor: "Contributor",
  viewer: "Viewer",
};

/** Member counts past this start collapsed and gain the search filter. */
const MANY_MEMBERS = 8;

/** Case-insensitive name/email match for the filter and the add picker. */
function matches(
  query: string,
  person: { name: string; email: string },
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    person.name.toLowerCase().includes(q) ||
    person.email.toLowerCase().includes(q)
  );
}

/**
 * Per-product membership editor, built to stay usable at hundreds of members.
 * Lazy-loads the product's members on mount (it's only rendered inside the
 * product's edit drawer), shows them under a collapsible "Members (n)" header
 * (collapsed by default once the list is long), filters by a search box, and
 * caps the list to a scrollable region. Managers grant a workspace member a
 * role via a type-ahead picker, change it, or revoke it. Grants matter for
 * private products: they're what lets a non-admin see and edit the backlog.
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
  // null until members load; the first load decides the default (long lists
  // start collapsed so the drawer opens on the product's own fields).
  const [collapsed, setCollapsed] = useState<boolean | null>(null);
  const [filter, setFilter] = useState("");
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let active = true;
    listProductMembers(productId)
      .then((m) => {
        if (!active) return;
        setMembers(m);
        setCollapsed((prev) => prev ?? m.length > MANY_MEMBERS);
      })
      .catch((err: unknown) => {
        if (active) {
          setError(
            err instanceof Error ? err.message : "Failed to load members.",
          );
          setMembers([]);
          setCollapsed((prev) => prev ?? false);
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

  const memberIds = new Set((members ?? []).map((m) => m.userId));
  const addable = candidates.filter((c) => !memberIds.has(c.userId));
  const visible = (members ?? []).filter((m) => matches(filter, m));
  const isOpen = collapsed === false;

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={isOpen}
        className="flex w-full items-center gap-1.5 text-left"
      >
        <span className="text-xs font-medium text-muted-foreground">
          Members{members !== null ? ` (${members.length})` : ""}
        </span>
        <ChevronDown
          className={cn(
            "size-3.5 text-muted-foreground transition-transform",
            isOpen ? "" : "-rotate-90",
          )}
        />
      </button>

      {isOpen ? (
        members === null ? (
          <p className="text-xs text-muted-foreground">Loading members…</p>
        ) : (
          <div className="space-y-3">
            {members.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No explicit members. Org admins always have access.
              </p>
            ) : (
              <>
                {members.length > MANY_MEMBERS ? (
                  <Input
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="Filter members…"
                    aria-label="Filter members"
                    className="h-8"
                  />
                ) : null}
                {visible.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No members match &ldquo;{filter}&rdquo;.
                  </p>
                ) : (
                  <ul className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
                    {visible.map((m) => (
                      <li
                        key={m.userId}
                        className="flex items-center gap-2 text-sm"
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {m.name}
                          <span className="ml-1.5 text-xs text-muted-foreground">
                            {m.email}
                          </span>
                        </span>
                        <Select
                          value={m.role}
                          disabled={pending}
                          aria-label={`Role for ${m.name}`}
                          onChange={(e) =>
                            upsert(m.userId, e.target.value as ProductRole)
                          }
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
              </>
            )}

            {addable.length > 0 ? (
              <AddMemberPicker
                key={members.length /* reset after an add */}
                candidates={addable}
                disabled={pending}
                onAdd={(userId, name) => {
                  upsert(userId, "viewer");
                  toast.success(`${name} added as viewer`);
                }}
              />
            ) : null}

            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        )
      ) : null}
    </div>
  );
}

/**
 * Type-ahead picker for granting access: search the workspace roster by name
 * or email and click a match to add them (as viewer; adjust the role on their
 * row after). Scales where a plain select of hundreds of options would not.
 */
function AddMemberPicker({
  candidates,
  disabled,
  onAdd,
}: {
  candidates: { userId: string; name: string; email: string }[];
  disabled: boolean;
  onAdd: (userId: string, name: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const matched = candidates.filter((c) => matches(query, c));
  const shown = matched.slice(0, 8);

  return (
    <div className="relative">
      <div className="flex items-center gap-2">
        <Input
          value={query}
          disabled={disabled}
          placeholder="Add a member…"
          aria-label="Add a member"
          className="h-8"
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
        />
        <span className="shrink-0 text-xs text-muted-foreground">
          added as viewer
        </span>
      </div>
      {open && shown.length > 0 ? (
        <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-md border bg-background shadow-md">
          {shown.map((c) => (
            <li key={c.userId}>
              <button
                type="button"
                className="flex w-full items-baseline gap-1.5 px-2 py-1.5 text-left text-sm hover:bg-muted"
                // Keep the input focused through the click so onBlur doesn't
                // close the list before onClick lands.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onAdd(c.userId, c.name);
                  setQuery("");
                  setOpen(false);
                }}
              >
                <span className="truncate">{c.name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {c.email}
                </span>
              </button>
            </li>
          ))}
          {matched.length > shown.length ? (
            <li className="px-2 py-1.5 text-xs text-muted-foreground">
              {matched.length - shown.length} more; keep typing to narrow.
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
